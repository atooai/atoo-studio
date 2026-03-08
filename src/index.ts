import path from 'path';
import fs from 'fs';
import os from 'os';
import forge from 'node-forge';
import { fileURLToPath } from 'url';
import { CertManager } from './proxy/cert-manager.js';
import { createMitmProxy } from './proxy/mitm-proxy.js';
import { createApiApp } from './router.js';
import { createWebServer } from './web/server.js';
import { killAllCliProcesses } from './spawner.js';
import { PROXY_PORT, WEB_PORT, CA_CERT_PATH, WEB_CERT_PATH, WEB_KEY_PATH } from './config.js';
import { fsMonitor } from './fs-monitor.js';
import { vccDb } from './state/db.js';
import { agentRegistry } from './agents/registry.js';
import { ClaudeCodeAgentFactory } from './agents/claude-code/index.js';
import { ClaudeCodeTerminalAgentFactory } from './agents/claude-code-terminal/index.js';
import { ClaudeCodeTerminalChatROAgentFactory } from './agents/claude-code-terminal-chatro/index.js';
import { sshManager } from './services/ssh-manager.js';
import { previewManager } from './services/preview-manager.js';


async function main() {
  console.log('=== CCProxy ===');
  console.log('');

  // 1. Load CA certificate
  const certManager = new CertManager();
  console.log('[init] CA certificate loaded');

  // 2. Connect to filesystem monitor (graceful — no-op if unavailable)
  fsMonitor.connect().catch(err => console.warn('[init] FS monitor not available:', err.message));

  // 2b. Register agent factories
  agentRegistry.registerFactory(new ClaudeCodeAgentFactory());
  agentRegistry.registerFactory(new ClaudeCodeTerminalAgentFactory());
  agentRegistry.registerFactory(new ClaudeCodeTerminalChatROAgentFactory());

  // 3. Create the internal API app (handles decrypted Anthropic traffic)
  const apiApp = createApiApp();

  // 3. Create and start the MITM proxy (bind to 0.0.0.0 for WSL access from Windows)
  const proxyServer = createMitmProxy(apiApp, certManager);
  proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`[init] MITM proxy listening on 0.0.0.0:${PROXY_PORT}`);
  });

  // 4. Generate self-signed TLS cert for web frontend (if not already present)
  const tlsOptions = getOrCreateWebCert();

  // 5. Create and start the web frontend server over HTTPS (bind to 0.0.0.0 for WSL access from Windows)
  const webServer = createWebServer(tlsOptions);
  webServer.listen(WEB_PORT, '0.0.0.0', () => {
    console.log(`[init] Web frontend listening on 0.0.0.0:${WEB_PORT} (HTTPS)`);
  });

  // Detect local IPs for display
  const localIps = getLocalIps();
  console.log('');
  console.log('Start Claude Code with:');
  console.log(`  HTTPS_PROXY=http://localhost:${PROXY_PORT} NODE_EXTRA_CA_CERTS=${CA_CERT_PATH} claude`);
  console.log('');
  for (const ip of localIps) {
    console.log(`Web frontend: https://${ip}:${WEB_PORT}`);
  }
  console.log('');

  // Auto-reconnect saved SSH connections
  const savedSshConns = vccDb.listSshConnections();
  for (const conn of savedSshConns) {
    sshManager.connect(conn).then(() => {
      console.log(`[init] SSH auto-reconnected: ${conn.label}`);
    }).catch(err => {
      console.warn(`[init] SSH auto-reconnect failed for ${conn.label}: ${err.message}`);
    });
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[shutdown] Stopping...');
    await previewManager.shutdown();
    fsMonitor.disconnect();
    sshManager.disconnectAll();
    killAllCliProcesses();
    vccDb.close();
    proxyServer.close();
    webServer.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await previewManager.shutdown();
    fsMonitor.disconnect();
    sshManager.disconnectAll();
    killAllCliProcesses();
    vccDb.close();
    proxyServer.close();
    webServer.close();
    process.exit(0);
  });
}

function getOrCreateWebCert(): { key: string; cert: string } {
  // Return existing cert if present
  if (fs.existsSync(WEB_CERT_PATH) && fs.existsSync(WEB_KEY_PATH)) {
    return {
      key: fs.readFileSync(WEB_KEY_PATH, 'utf-8'),
      cert: fs.readFileSync(WEB_CERT_PATH, 'utf-8'),
    };
  }

  console.log('[init] Generating self-signed TLS certificate for web frontend...');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 10);

  cert.setSubject([{ name: 'commonName', value: 'CCProxy Web' }]);
  cert.setIssuer([{ name: 'commonName', value: 'CCProxy Web' }]);

  // Collect local IPs for SAN
  const altNames: any[] = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ];
  for (const ip of getLocalIps()) {
    if (ip !== '127.0.0.1' && ip !== 'localhost') {
      altNames.push({ type: 7, ip });
    }
  }

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);

  fs.writeFileSync(WEB_KEY_PATH, keyPem, { mode: 0o600 });
  fs.writeFileSync(WEB_CERT_PATH, certPem);
  console.log('[init] TLS certificate saved to', WEB_CERT_PATH);

  return { key: keyPem, cert: certPem };
}

function getLocalIps(): string[] {
  const ips: string[] = ['localhost'];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
