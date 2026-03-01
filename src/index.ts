import path from 'path';
import { fileURLToPath } from 'url';
import { CertManager } from './proxy/cert-manager.js';
import { createMitmProxy } from './proxy/mitm-proxy.js';
import { createApiApp } from './router.js';
import { createWebServer } from './web/server.js';
import { killAllCliProcesses } from './spawner.js';
import { PROXY_PORT, WEB_PORT, CA_CERT_PATH } from './config.js';

async function main() {
  console.log('=== CCProxy ===');
  console.log('');

  // 1. Load CA certificate
  const certManager = new CertManager();
  console.log('[init] CA certificate loaded');

  // 2. Create the internal API app (handles decrypted Anthropic traffic)
  const apiApp = createApiApp();

  // 3. Create and start the MITM proxy (bind to 0.0.0.0 for WSL access from Windows)
  const proxyServer = createMitmProxy(apiApp, certManager);
  proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`[init] MITM proxy listening on 0.0.0.0:${PROXY_PORT}`);
  });

  // 4. Create and start the web frontend server (bind to 0.0.0.0 for WSL access from Windows)
  const webServer = createWebServer();
  webServer.listen(WEB_PORT, '0.0.0.0', () => {
    console.log(`[init] Web frontend listening on 0.0.0.0:${WEB_PORT}`);
  });

  console.log('');
  console.log('Start Claude Code with:');
  console.log(`  HTTPS_PROXY=http://localhost:${PROXY_PORT} NODE_EXTRA_CA_CERTS=${CA_CERT_PATH} claude`);
  console.log('');
  console.log(`Web frontend (WSL):     http://localhost:${WEB_PORT}`);
  console.log(`Web frontend (Windows): http://172.25.255.25:${WEB_PORT}`);
  console.log('');

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[shutdown] Stopping...');
    killAllCliProcesses();
    proxyServer.close();
    webServer.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    killAllCliProcesses();
    proxyServer.close();
    webServer.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
