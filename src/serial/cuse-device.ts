import { spawn, execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface CuseDevice {
  devicePath: string;
  write(data: Buffer): number;
  read(): Buffer | null;
  getModemBits(): { dtr: boolean; rts: boolean };
  setModemBits(dtr: boolean, rts: boolean): void;
  onModemBitsChanged: ((bits: { dtr: boolean; rts: boolean }) => void) | null;
  close(): void;
  closed: boolean;
  controlSignalsSupported: true;
}

// Frame protocol: [type:1][len:2 BE][payload:len]
function encodeFrame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(3);
  header[0] = type;
  header[1] = (payload.length >> 8) & 0xFF;
  header[2] = payload.length & 0xFF;
  return Buffer.concat([header, payload]);
}

let deviceCounter = 0;

export function isCuseAvailable(): boolean {
  if (process.platform !== 'linux') return false;

  // Check if /dev/cuse exists (kernel module loaded)
  if (!fs.existsSync('/dev/cuse')) return false;

  // Check if /dev/cuse is actually accessible by the current user
  try {
    fs.accessSync('/dev/cuse', fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    console.log('[serial] /dev/cuse exists but is not accessible (check permissions: chmod 0666 /dev/cuse)');
    return false;
  }

  // Unprivileged LXC containers can open /dev/cuse but can't create device nodes
  try {
    const uidMap = fs.readFileSync('/proc/self/uid_map', 'utf8').trim();
    // In unprivileged containers, uid 0 maps to a high host uid (e.g., 100000)
    // In privileged or bare-metal, uid 0 maps to 0
    const match = uidMap.match(/^\s*0\s+(\d+)/);
    if (match && parseInt(match[1], 10) > 0) return false;
  } catch {}

  // Check if the binary exists and has the required capability or suid bit
  const bin = findCuseBinarySync();
  if (!bin) return false;

  try {
    const stat = fs.statSync(bin);
    const hasSuid = (stat.mode & 0o4000) !== 0;
    if (!hasSuid) {
      // No suid — check for CAP_SYS_ADMIN via getcap
      const caps = execFileSync('getcap', [bin], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      if (!caps.includes('cap_sys_admin')) {
        console.log(`[serial] cuse_serial binary lacks CAP_SYS_ADMIN and suid bit. Run: sudo setcap cap_sys_admin+ep ${bin}`);
        return false;
      }
    }
  } catch {}

  return true;
}

function findCuseBinarySync(): string | null {
  // Preferred: installed by setup-cuse.sh to ~/.atoo-studio/bin/ (survives node-gyp rebuilds)
  const installedPath = path.join(os.homedir(), '.atoo-studio', 'bin', 'cuse_serial');
  if (fs.existsSync(installedPath)) return installedPath;

  // Check /usr/local/bin
  if (fs.existsSync('/usr/local/bin/cuse-serial')) return '/usr/local/bin/cuse-serial';

  // Fallback: node-gyp build dir (may lack capabilities after rebuild)
  const localPath = path.join(__dirname, 'native', 'build', 'Release', 'cuse_serial');
  if (fs.existsSync(localPath)) return localPath;

  const distPath = path.join(__dirname, '..', '..', '..', 'src', 'serial', 'native', 'build', 'Release', 'cuse_serial');
  if (fs.existsSync(distPath)) return distPath;

  return null;
}

export function createCuseDevice(): Promise<CuseDevice> {
  return new Promise((resolve, reject) => {
    const bin = findCuseBinarySync();
    if (!bin) {
      reject(new Error('CUSE serial binary not found'));
      return;
    }

    const devName = `ttyVS${deviceCounter++}`;
    const child = spawn(bin, ['--name=' + devName, '-f'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let closed = false;
    let resolved = false;
    let devicePath = '';
    const readBuffer: Buffer[] = [];
    let lastModemBits = { dtr: false, rts: false };

    // Frame parser state for child's stdout
    let parseState: 'header' | 'payload' = 'header';
    let frameType = 0;
    let frameLen = 0;
    let frameBuf = Buffer.alloc(0);
    let headerBuf = Buffer.alloc(0);

    function processFrame(type: number, payload: Buffer) {
      switch (type) {
        case 0x00: // Serial data from tool
          readBuffer.push(Buffer.from(payload));
          break;
        case 0x01: // Modem signals changed
          if (payload.length >= 1) {
            lastModemBits = {
              dtr: (payload[0] & 0x01) !== 0,
              rts: (payload[0] & 0x02) !== 0,
            };
            // Fire callback immediately for low-latency signal forwarding
            device.onModemBitsChanged?.({ ...lastModemBits });
          }
          break;
        case 0x02: // Device ready
          devicePath = payload.toString('utf8');
          break;
        case 0x03: // Error
          const msg = payload.toString('utf8');
          if (!devicePath) {
            reject(new Error(`CUSE: ${msg}`));
          } else {
            console.error(`[cuse] Error: ${msg}`);
          }
          break;
      }
    }

    function parseStdout(chunk: Buffer) {
      let offset = 0;
      while (offset < chunk.length) {
        if (parseState === 'header') {
          const needed = 3 - headerBuf.length;
          const available = chunk.length - offset;
          const take = Math.min(needed, available);
          headerBuf = Buffer.concat([headerBuf, chunk.subarray(offset, offset + take)]);
          offset += take;
          if (headerBuf.length === 3) {
            frameType = headerBuf[0];
            frameLen = (headerBuf[1] << 8) | headerBuf[2];
            headerBuf = Buffer.alloc(0);
            if (frameLen === 0) {
              processFrame(frameType, Buffer.alloc(0));
            } else {
              frameBuf = Buffer.alloc(0);
              parseState = 'payload';
            }
          }
        } else {
          const needed = frameLen - frameBuf.length;
          const available = chunk.length - offset;
          const take = Math.min(needed, available);
          frameBuf = Buffer.concat([frameBuf, chunk.subarray(offset, offset + take)]);
          offset += take;
          if (frameBuf.length === frameLen) {
            processFrame(frameType, frameBuf);
            parseState = 'header';
          }
        }
      }
    }

    child.stdout!.on('data', (chunk: Buffer) => {
      parseStdout(chunk);
      if (devicePath && !resolved) {
        // Verify the device node actually exists (may fail in LXC due to cgroup restrictions)
        let retries = 0;
        const verifyInterval = setInterval(() => {
          retries++;
          if (fs.existsSync(devicePath)) {
            clearInterval(verifyInterval);
            resolved = true;
            clearTimeout(timeout);
            resolve(device);
          } else if (retries >= 10) {
            clearInterval(verifyInterval);
            resolved = true;
            clearTimeout(timeout);
            child.kill('SIGTERM');
            reject(new Error(`CUSE device ${devicePath} was not created (blocked by container cgroup?)`));
          }
        }, 100);
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.error(`[cuse] ${msg}`);
    });

    child.on('error', (err) => {
      if (!devicePath) reject(err);
    });

    child.on('exit', (code) => {
      closed = true;
      if (!devicePath) {
        reject(new Error(`CUSE helper exited with code ${code}`));
      }
    });

    // Wait up to 5s for device ready
    const timeout = setTimeout(() => {
      if (!devicePath) {
        child.kill();
        reject(new Error('CUSE device creation timed out'));
      }
    }, 5000);

    const device: CuseDevice = {
      get devicePath() { return devicePath; },
      get closed() { return closed; },
      controlSignalsSupported: true,

      write(data: Buffer): number {
        if (closed) return -1;
        try {
          const frame = encodeFrame(0x00, data);
          child.stdin!.write(frame);
          return data.length;
        } catch {
          return -1;
        }
      },

      read(): Buffer | null {
        if (closed) return null;
        if (readBuffer.length === 0) return null;
        const chunk = readBuffer.shift()!;
        return chunk;
      },

      getModemBits(): { dtr: boolean; rts: boolean } {
        return { ...lastModemBits };
      },

      onModemBitsChanged: null,

      setModemBits(_dtr: boolean, _rts: boolean): void {
        // Not needed for CUSE — modem bits are set by the tool's ioctls,
        // which the CUSE helper handles directly
      },

      close(): void {
        if (!closed) {
          closed = true;
          clearTimeout(timeout);
          try { child.stdin!.end(); } catch {}
          try { child.kill('SIGTERM'); } catch {}
          // Give it a moment to clean up, then force kill
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
        }
      },
    };
  });
}
