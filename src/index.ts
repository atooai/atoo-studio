import path from 'path';
import fs from 'fs';
import os from 'os';
import https from 'https';
import forge from 'node-forge';
import { fileURLToPath } from 'url';
import { createWebServer } from './web/server.js';
import { killAllCliProcesses } from './spawner.js';
import { WEB_PORT, CA_CERT_PATH, CA_KEY_PATH, WEB_CERT_PATH, WEB_KEY_PATH } from './config.js';
import { cleanupStaleMcpConfigs } from './mcp/config.js';
import { fsMonitor } from './fs-monitor.js';
import { db } from './state/db.js';
import { agentRegistry } from './agents/registry.js';
import { ClaudeCodeTerminalAgentFactory } from './agents/claude-code-terminal/index.js';
import { ClaudeCodeTerminalChatROAgentFactory } from './agents/claude-code-terminal-chatro/index.js';
import { CodexTerminalChatROAgentFactory } from './agents/codex-terminal-chatro/index.js';
import { CodexTerminalAgentFactory } from './agents/codex-terminal/index.js';
import { AtooAnyAgentFactory } from './agents/atoo-any/index.js';
import { GeminiTerminalAgentFactory } from './agents/gemini-terminal/index.js';
import { sshManager } from './services/ssh-manager.js';
import { previewManager } from './services/preview-manager.js';


async function main() {
  console.log('=== Atoo Studio ===');
  console.log('');

  // 1. Connect to filesystem monitor (graceful — no-op if unavailable)
  fsMonitor.connect().catch(err => console.warn('[init] FS monitor not available:', err.message));

  // 2. Register agent factories
  agentRegistry.registerFactory(new ClaudeCodeTerminalAgentFactory());
  agentRegistry.registerFactory(new ClaudeCodeTerminalChatROAgentFactory());
  // agentRegistry.registerFactory(new CodexTerminalChatROAgentFactory());
  agentRegistry.registerFactory(new CodexTerminalAgentFactory());
  agentRegistry.registerFactory(new GeminiTerminalAgentFactory());
  agentRegistry.registerFactory(new AtooAnyAgentFactory());

  // 3. Clean up stale per-session MCP config files (older than 24h)
  cleanupStaleMcpConfigs();

  // 3.5. Generate CA-signed TLS cert for web frontend
  const tlsOptions = getOrCreateWebCert();

  // 4. Create and start the web frontend server over HTTPS (bind to 0.0.0.0 for WSL access from Windows)
  const webServer = createWebServer(tlsOptions);

  // Dynamic SAN expansion: detect new hosts from incoming requests and hot-swap cert
  if (webServer instanceof https.Server) {
    setupDynamicSan(webServer);
  }

  webServer.listen(WEB_PORT, '0.0.0.0', () => {
    console.log(`[init] Web frontend listening on 0.0.0.0:${WEB_PORT} (HTTPS)`);
  });

  // Detect local IPs for display
  const localIps = getLocalIps();
  console.log('');
  for (const ip of localIps) {
    console.log(`Web frontend: https://${ip}:${WEB_PORT}`);
  }
  console.log('');

  // Auto-reconnect saved SSH connections
  const savedSshConns = db.listSshConnections();
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
    db.close();
    webServer.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await previewManager.shutdown();
    fsMonitor.disconnect();
    sshManager.disconnectAll();
    killAllCliProcesses();
    db.close();
    webServer.close();
    process.exit(0);
  });
}

// Track known SANs so we can detect new ones
const knownSans = new Set<string>();
let webKeyPem: string = '';

function ensureCACert(): void {
  if (fs.existsSync(CA_CERT_PATH)) return;

  console.log('[tls] First run — generating CA certificate...');
  fs.mkdirSync(path.dirname(CA_CERT_PATH), { recursive: true });

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: 'Atoo Studio Local CA' },
    { name: 'organizationName', value: 'Atoo Studio' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  fs.writeFileSync(CA_CERT_PATH, forge.pki.certificateToPem(cert));
  fs.writeFileSync(CA_KEY_PATH, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  console.log('[tls] CA certificate generated.');
}

function getOrCreateWebCert(): { key: string; cert: string } {
  ensureCACert();

  // Seed known SANs with local IPs
  knownSans.add('localhost');
  knownSans.add('127.0.0.1');
  for (const ip of getLocalIps()) knownSans.add(ip);

  // If existing cert was CA-signed and covers all current SANs, reuse it
  if (fs.existsSync(WEB_CERT_PATH) && fs.existsSync(WEB_KEY_PATH)) {
    try {
      const existingCert = forge.pki.certificateFromPem(fs.readFileSync(WEB_CERT_PATH, 'utf-8'));
      const sanExt = existingCert.getExtension('subjectAltName') as any;
      const existingSans = new Set<string>();
      if (sanExt?.altNames) {
        for (const an of sanExt.altNames) existingSans.add(an.value || an.ip);
      }
      // Check issuer is our CA (not self-signed)
      const caCert = forge.pki.certificateFromPem(fs.readFileSync(CA_CERT_PATH, 'utf-8'));
      const issuedByCA = existingCert.issuer.hash === caCert.subject.hash;
      const allCovered = [...knownSans].every(s => existingSans.has(s));

      if (issuedByCA && allCovered) {
        webKeyPem = fs.readFileSync(WEB_KEY_PATH, 'utf-8');
        // Also add any extra SANs from existing cert to our tracking set
        for (const s of existingSans) knownSans.add(s);
        console.log('[init] Reusing existing CA-signed web certificate');
        return { key: webKeyPem, cert: fs.readFileSync(WEB_CERT_PATH, 'utf-8') };
      }
    } catch {}
  }

  return regenerateWebCert('initial generation');
}

function regenerateWebCert(reason: string): { key: string; cert: string } {
  console.log(`[tls] Generating CA-signed web certificate (${reason})...`);

  const caCertPem = fs.readFileSync(CA_CERT_PATH, 'utf-8');
  const caKeyPem = fs.readFileSync(CA_KEY_PATH, 'utf-8');
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);

  // Reuse existing key if we have one, otherwise generate new
  let privateKey: forge.pki.PrivateKey;
  let publicKey: forge.pki.PublicKey;
  if (webKeyPem) {
    privateKey = forge.pki.privateKeyFromPem(webKeyPem);
    publicKey = forge.pki.setRsaPublicKey(
      (privateKey as any).n, (privateKey as any).e
    );
  } else {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    privateKey = keys.privateKey;
    publicKey = keys.publicKey;
    webKeyPem = forge.pki.privateKeyToPem(privateKey);
  }

  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 1);

  cert.setSubject([{ name: 'commonName', value: 'Atoo Studio Web' }]);
  cert.setIssuer(caCert.subject.attributes);

  // Build SAN list from all known hosts
  const altNames: any[] = [];
  for (const san of knownSans) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(san)) {
      altNames.push({ type: 7, ip: san });
    } else {
      altNames.push({ type: 2, value: san });
    }
  }

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);

  fs.writeFileSync(WEB_KEY_PATH, webKeyPem, { mode: 0o600 });
  fs.writeFileSync(WEB_CERT_PATH, certPem);
  console.log(`[tls] Web certificate issued with SANs: ${[...knownSans].join(', ')}`);

  return { key: webKeyPem, cert: certPem };
}

function setupDynamicSan(server: https.Server) {
  // Intercept connections to check the Host header for unknown SANs
  const origEmit = server.emit.bind(server);
  server.emit = function (event: string, ...args: any[]) {
    if (event === 'request') {
      const req = args[0] as import('http').IncomingMessage;
      const host = req.headers.host;
      if (host) {
        const hostname = host.replace(/:\d+$/, '');
        if (hostname && !knownSans.has(hostname)) {
          knownSans.add(hostname);
          console.log(`[tls] New host detected: ${hostname} — regenerating certificate`);
          const newTls = regenerateWebCert(`adding ${hostname}`);
          server.setSecureContext({ key: newTls.key, cert: newTls.cert });
        }
      }
    }
    return origEmit(event, ...args);
  } as any;
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
