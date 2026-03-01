import forge from 'node-forge';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const certsDir = path.join(__dirname, '..', 'certs');

function generateCA() {
  console.log('Generating CCProxy CA certificate...');

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
    {
      name: 'subjectKeyIdentifier',
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  fs.writeFileSync(path.join(certsDir, 'ca.pem'), certPem);
  fs.writeFileSync(path.join(certsDir, 'ca-key.pem'), keyPem);
  fs.chmodSync(path.join(certsDir, 'ca-key.pem'), 0o600);

  console.log(`CA certificate written to: ${path.join(certsDir, 'ca.pem')}`);
  console.log(`CA private key written to: ${path.join(certsDir, 'ca-key.pem')}`);
  console.log('');
  console.log('Start Claude Code with:');
  console.log(`  HTTPS_PROXY=http://localhost:8080 NODE_EXTRA_CA_CERTS=${path.join(certsDir, 'ca.pem')} claude`);
}

generateCA();
