import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Resolve the project root — works for both tsx (src/config.ts) and compiled (dist/src/config.js)
const __config_dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = __config_dirname.includes('/dist/src')
  ? path.resolve(__config_dirname, '../..')   // dist/src/ → project root
  : path.resolve(__config_dirname, '..');     // src/ → project root

export const PROXY_PORT = 8081;
export const INTERNAL_PORT = 0; // random port for internal Express app
export const WEB_PORT = 3010;
export const ANTHROPIC_HOST = 'api.anthropic.com';
export const ANTHROPIC_ORIGIN = `https://${ANTHROPIC_HOST}`;
export const CERTS_DIR = path.join(PROJECT_ROOT, 'certs') + '/';
export const CA_CERT_PATH = `${CERTS_DIR}ca.pem`;
export const CA_KEY_PATH = `${CERTS_DIR}ca-key.pem`;
export const WEB_CERT_PATH = `${CERTS_DIR}web-cert.pem`;
export const WEB_KEY_PATH = `${CERTS_DIR}web-key.pem`;
export const CDP_PORT_START = 9300;
export const CDP_PORT_END = 9399;

// Docker preview settings
export const DOCKER_PREVIEW_IMAGE = 'atoo-studio-preview:latest';
export const DOCKER_PREVIEW_SOCKET_DIR = path.join(os.tmpdir(), 'atoo-studio-preview-sockets');
import { execSync as _execSync } from 'child_process';

function detectContainerRuntime(): string {
  if (process.env.ATOO_CONTAINER_RUNTIME) return process.env.ATOO_CONTAINER_RUNTIME;
  for (const cmd of ['docker', 'podman']) {
    try {
      _execSync(`${cmd} --version`, { stdio: 'ignore' });
      return cmd;
    } catch {}
  }
  return 'docker'; // default even if not found — will fail gracefully later
}

export const DOCKER_RUNTIME = detectContainerRuntime();
