#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const certsDir = path.join(projectRoot, 'certs');

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

// Start the server
await import('../dist/src/index.js');
