import { Client, type SFTPWrapper, type ClientChannel, type ConnectConfig } from 'ssh2';
import fs from 'fs';
import net from 'net';
import path from 'path';
import os from 'os';
import { CA_CERT_PATH, PROXY_PORT } from '../config.js';
import { deobfuscate } from './obfuscation.js';
import type { SshConnection } from '../state/db.js';

interface DirEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
}

interface ActiveSshConnection {
  id: string;
  client: Client;
  sftp?: SFTPWrapper;
  config: SshConnection;
  connected: boolean;
  error?: string;
  reverseTunnelServers: net.Server[];
  forwardTunnels: Map<number, { localPort: number; server: net.Server }>;
}

export interface PtyOpts {
  rows?: number;
  cols?: number;
  cwd?: string;
  env?: Record<string, string>;
}

class SshManager {
  private connections = new Map<string, ActiveSshConnection>();

  async connect(config: SshConnection): Promise<void> {
    if (this.connections.has(config.id) && this.connections.get(config.id)!.connected) {
      return;
    }

    const client = new Client();
    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
    };

    if (config.auth_method === 'password' && config.password_obfuscated) {
      connectConfig.password = deobfuscate(config.password_obfuscated);
    } else if (config.auth_method === 'privatekey' && config.private_key_obfuscated) {
      connectConfig.privateKey = deobfuscate(config.private_key_obfuscated);
      if (config.passphrase_obfuscated) {
        connectConfig.passphrase = deobfuscate(config.passphrase_obfuscated);
      }
    } else if (config.auth_method === 'systemkey' && config.system_key_path) {
      connectConfig.privateKey = fs.readFileSync(config.system_key_path, 'utf-8');
      if (config.passphrase_obfuscated) {
        connectConfig.passphrase = deobfuscate(config.passphrase_obfuscated);
      }
    }

    const active: ActiveSshConnection = {
      id: config.id,
      client,
      config,
      connected: false,
      reverseTunnelServers: [],
      forwardTunnels: new Map(),
    };
    this.connections.set(config.id, active);

    return new Promise<void>((resolve, reject) => {
      client.on('ready', async () => {
        console.log(`[ssh] Connected to ${config.host}:${config.port} as ${config.username}`);
        active.connected = true;

        try {
          // Setup reverse tunnels so remote claude can reach our proxy
          await this.setupReverseTunnel(config.id, 3000, 3001);
          await this.setupReverseTunnel(config.id, PROXY_PORT, PROXY_PORT);

          // Upload CA cert to remote
          await this.uploadCaCert(config.id);

          resolve();
        } catch (err: any) {
          console.error(`[ssh] Post-connect setup failed:`, err.message);
          resolve(); // still connected, just tunnel setup failed
        }
      });

      client.on('error', (err) => {
        console.error(`[ssh] Connection error for ${config.id}:`, err.message);
        active.connected = false;
        active.error = err.message;
        if (!active.connected) reject(err);
      });

      client.on('end', () => {
        console.log(`[ssh] Connection ended for ${config.id}`);
        active.connected = false;
        this.cleanupConnection(config.id);
      });

      client.on('close', () => {
        active.connected = false;
        this.cleanupConnection(config.id);
      });

      client.connect(connectConfig);
    });
  }

  async disconnect(id: string): Promise<void> {
    const active = this.connections.get(id);
    if (!active) return;
    this.cleanupConnection(id);
    active.client.end();
    this.connections.delete(id);
    console.log(`[ssh] Disconnected ${id}`);
  }

  async disconnectAll(): Promise<void> {
    for (const id of Array.from(this.connections.keys())) {
      await this.disconnect(id);
    }
  }

  isConnected(id: string): boolean {
    return this.connections.get(id)?.connected ?? false;
  }

  getStatus(id: string): { connected: boolean; error?: string } {
    const active = this.connections.get(id);
    if (!active) return { connected: false };
    return { connected: active.connected, error: active.error };
  }

  // SFTP operations
  private async getSftp(id: string): Promise<SFTPWrapper> {
    const active = this.connections.get(id);
    if (!active || !active.connected) throw new Error('SSH not connected');

    if (active.sftp) return active.sftp;

    return new Promise<SFTPWrapper>((resolve, reject) => {
      active.client.sftp((err, sftp) => {
        if (err) return reject(err);
        active.sftp = sftp;
        resolve(sftp);
      });
    });
  }

  async sftpReaddir(id: string, dirPath: string): Promise<DirEntry[]> {
    const sftp = await this.getSftp(id);
    return new Promise<DirEntry[]>((resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) return reject(err);
        const entries: DirEntry[] = list
          .filter(item => !item.filename.startsWith('.'))
          .map(item => ({
            name: item.filename,
            type: (item.attrs as any).isDirectory() ? 'dir' as const : 'file' as const,
            size: item.attrs.size,
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        resolve(entries);
      });
    });
  }

  async sftpMkdir(id: string, dirPath: string): Promise<void> {
    const sftp = await this.getSftp(id);
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(dirPath, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async sftpReadFile(id: string, filePath: string): Promise<string> {
    const sftp = await this.getSftp(id);
    return new Promise<string>((resolve, reject) => {
      let data = '';
      const stream = sftp.createReadStream(filePath, { encoding: 'utf8' });
      stream.on('data', (chunk: string) => { data += chunk; });
      stream.on('end', () => resolve(data));
      stream.on('error', reject);
    });
  }

  async sftpWriteFile(id: string, filePath: string, content: string): Promise<void> {
    const sftp = await this.getSftp(id);
    return new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(filePath);
      stream.on('close', () => resolve());
      stream.on('error', reject);
      stream.end(content);
    });
  }

  async sftpStat(id: string, filePath: string): Promise<any> {
    const sftp = await this.getSftp(id);
    return new Promise((resolve, reject) => {
      sftp.stat(filePath, (err, stats) => {
        if (err) return reject(err);
        resolve(stats);
      });
    });
  }

  async sftpUnlink(id: string, filePath: string): Promise<void> {
    const sftp = await this.getSftp(id);
    return new Promise<void>((resolve, reject) => {
      sftp.unlink(filePath, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async sftpRmdir(id: string, dirPath: string): Promise<void> {
    const sftp = await this.getSftp(id);
    return new Promise<void>((resolve, reject) => {
      sftp.rmdir(dirPath, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async sftpRename(id: string, oldPath: string, newPath: string): Promise<void> {
    const sftp = await this.getSftp(id);
    return new Promise<void>((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  // Exec
  async exec(id: string, cmd: string, opts?: { cwd?: string }): Promise<string> {
    const active = this.connections.get(id);
    if (!active || !active.connected) throw new Error('SSH not connected');

    const fullCmd = opts?.cwd ? `cd ${shellEscape(opts.cwd)} && ${cmd}` : cmd;

    return new Promise<string>((resolve, reject) => {
      active.client.exec(fullCmd, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        stream.on('data', (data: Buffer) => { stdout += data.toString(); });
        stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
        stream.on('close', (code: number) => {
          if (code !== 0 && stderr) {
            reject(new Error(stderr.trim() || `Command failed with code ${code}`));
          } else {
            resolve(stdout);
          }
        });
      });
    });
  }

  async execPty(id: string, cmd: string, opts: PtyOpts): Promise<ClientChannel> {
    const active = this.connections.get(id);
    if (!active || !active.connected) throw new Error('SSH not connected');

    const fullCmd = opts.cwd ? `cd ${shellEscape(opts.cwd)} && ${cmd}` : cmd;
    const envVars = opts.env || {};

    return new Promise<ClientChannel>((resolve, reject) => {
      active.client.exec(fullCmd, {
        pty: {
          rows: opts.rows || 30,
          cols: opts.cols || 120,
          term: 'xterm-256color',
        },
        env: envVars,
      }, (err, stream) => {
        if (err) return reject(err);
        resolve(stream);
      });
    });
  }

  // Reverse tunnel: remote:remotePort -> local:localPort
  async setupReverseTunnel(id: string, remotePort: number, localPort: number): Promise<void> {
    const active = this.connections.get(id);
    if (!active || !active.connected) throw new Error('SSH not connected');

    // Register tcp connection handler before requesting forwarding
    active.client.on('tcp connection', (info, accept, _reject) => {
      if (info.destPort === remotePort) {
        const channel = accept();
        const socket = net.createConnection(localPort, '127.0.0.1', () => {
          channel.pipe(socket);
          socket.pipe(channel);
        });
        socket.on('error', () => channel.close());
        channel.on('error', () => socket.destroy());
      }
    });

    return new Promise<void>((resolve, reject) => {
      active.client.forwardIn('127.0.0.1', remotePort, (err) => {
        if (err) {
          console.warn(`[ssh] Failed to set up reverse tunnel ${remotePort} -> ${localPort}:`, err.message);
          return reject(err);
        }
        console.log(`[ssh] Reverse tunnel: remote:${remotePort} -> local:${localPort}`);
        resolve();
      });
    });
  }

  // Forward tunnel: on-demand, for port proxy
  async getOrCreateForwardTunnel(id: string, remotePort: number): Promise<number> {
    const active = this.connections.get(id);
    if (!active || !active.connected) throw new Error('SSH not connected');

    const existing = active.forwardTunnels.get(remotePort);
    if (existing) return existing.localPort;

    // Create a local TCP server that pipes through SSH forwardOut
    return new Promise<number>((resolve, reject) => {
      const server = net.createServer((localSocket) => {
        active.client.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (err, stream) => {
          if (err) {
            localSocket.destroy();
            return;
          }
          localSocket.pipe(stream);
          stream.pipe(localSocket);
          localSocket.on('error', () => stream.close());
          stream.on('error', () => localSocket.destroy());
        });
      });

      server.listen(0, '127.0.0.1', () => {
        const localPort = (server.address() as net.AddressInfo).port;
        active.forwardTunnels.set(remotePort, { localPort, server });
        console.log(`[ssh] Forward tunnel: local:${localPort} -> remote:${remotePort}`);
        resolve(localPort);
      });

      server.on('error', reject);
    });
  }

  // Upload CA cert to remote
  private async uploadCaCert(id: string): Promise<void> {
    try {
      const certContent = fs.readFileSync(CA_CERT_PATH, 'utf-8');
      await this.exec(id, 'mkdir -p ~/.ccproxy');
      await this.sftpWriteFile(id, '.ccproxy/ca.pem', certContent);
      console.log(`[ssh] Uploaded CA cert to remote ~/.ccproxy/ca.pem`);
    } catch (err: any) {
      console.warn(`[ssh] Failed to upload CA cert:`, err.message);
    }
  }

  // Verify claude CLI exists on remote
  async verifyClaudeCli(id: string): Promise<boolean> {
    try {
      await this.exec(id, 'which claude');
      return true;
    } catch {
      return false;
    }
  }

  private cleanupConnection(id: string): void {
    const active = this.connections.get(id);
    if (!active) return;

    for (const server of active.reverseTunnelServers) {
      try { server.close(); } catch {}
    }
    active.reverseTunnelServers = [];

    for (const [, tunnel] of active.forwardTunnels) {
      try { tunnel.server.close(); } catch {}
    }
    active.forwardTunnels.clear();

    active.sftp = undefined;
  }
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export const sshManager = new SshManager();
