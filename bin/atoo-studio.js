#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Check system dependencies on Linux
if (process.platform === 'linux') {
  const warnings = [];

  // Chrome / Puppeteer libs
  try {
    execSync('ldconfig -p | grep -q libatk-1.0', { stdio: 'ignore' });
  } catch {
    warnings.push('[atoo-studio] Missing Chrome dependencies — browser preview/streaming will not work.');
  }

  // CUSE for serial control signals (DTR/RTS)
  const cusebin = path.join(process.env.HOME || '', '.atoo-studio', 'bin', 'cuse_serial');
  if (!fs.existsSync('/dev/cuse') || !fs.existsSync(cusebin)) {
    warnings.push('[atoo-studio] CUSE not set up — serial control commands may not work (e.g. auto-reset sequences).');
  }

  if (warnings.length > 0) {
    for (const w of warnings) console.warn(w);
    console.warn('[atoo-studio] Run:  sudo ./setup.sh  and  sudo ./setup-cuse.sh');
    console.warn('');
  }
}

// Start the server
await import('../dist/src/index.js');
