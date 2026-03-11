#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const certsDir = path.join(projectRoot, 'certs');

// Check system dependencies on Linux
if (process.platform === 'linux') {
  const warnings = [];

  // Chrome / Puppeteer libs
  try {
    execSync('ldconfig -p | grep -q libatk-1.0', { stdio: 'ignore' });
  } catch {
    warnings.push('[ccproxy] Missing Chrome dependencies — browser preview/streaming will not work.');
  }

  // CUSE for serial control signals (DTR/RTS)
  const cusebin = path.join(process.env.HOME || '', '.ccproxy', 'bin', 'cuse_serial');
  if (!fs.existsSync('/dev/cuse') || !fs.existsSync(cusebin)) {
    warnings.push('[ccproxy] CUSE not set up — serial control commands may not work (e.g. auto-reset sequences).');
  }

  if (warnings.length > 0) {
    for (const w of warnings) console.warn(w);
    console.warn('[ccproxy] Run:  sudo ./setup.sh  and  sudo ./setup-cuse.sh');
    console.warn('');
  }
}

// Auto-run setup (generate CA cert) if certs don't exist yet
if (!fs.existsSync(path.join(certsDir, 'ca.pem'))) {
  console.log('[ccproxy] First run — generating CA certificate...');
  const { default: forge } = await import('node-forge');

  fs.mkdirSync(certsDir, { recursive: true });

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: 'CCProxy Local CA' },
    { name: 'organizationName', value: 'CCProxy' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  fs.writeFileSync(path.join(certsDir, 'ca.pem'), forge.pki.certificateToPem(cert));
  fs.writeFileSync(path.join(certsDir, 'ca-key.pem'), forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  console.log('[ccproxy] CA certificate generated.');
}

// Auto-build Docker preview image if Docker/Podman is available but image is missing
{
  let runtime = process.env.CCPROXY_CONTAINER_RUNTIME || '';
  if (!runtime) {
    for (const cmd of ['docker', 'podman']) {
      try { execSync(`${cmd} --version`, { stdio: 'ignore' }); runtime = cmd; break; } catch {}
    }
  }

  if (runtime) {
    let hasRuntime = false;
    try { execSync(`${runtime} info`, { stdio: 'ignore' }); hasRuntime = true; } catch {}

    if (hasRuntime) {
      let hasImage = false;
      try {
        execSync(`${runtime} image inspect ccproxy-preview:latest`, { stdio: 'ignore' });
        hasImage = true;
      } catch {}

      if (!hasImage) {
        const buildScript = path.join(projectRoot, 'docker', 'preview', 'build.sh');
        if (fs.existsSync(buildScript)) {
          console.log(`[ccproxy] Preview image not found — building ccproxy-preview:latest with ${runtime}...`);
          try {
            execSync(`CCPROXY_CONTAINER_RUNTIME=${runtime} bash "${buildScript}"`, { cwd: projectRoot, stdio: 'inherit' });
            console.log('[ccproxy] Docker preview image built successfully.');
          } catch (err) {
            console.warn('[ccproxy] Docker preview image build failed — falling back to headless mode.');
          }
        }
      }
    }
  }
}

// Start the server
await import('../dist/src/index.js');
