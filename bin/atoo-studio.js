#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

/** Check if a command exists on PATH */
function hasCommand(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// --- Windows: not supported ---
if (process.platform === 'win32') {
  console.error('[atoo-studio] Windows is not supported. Use WSL instead.');
  process.exit(1);
}

// --- Check dependencies ---
const warnings = [];
const setupHints = new Set();

// Required: git — core feature (version control, worktrees, file tracking)
if (!hasCommand('git')) {
  warnings.push('git not found — version control, worktrees, and file tracking will not work.');
}

// Optional: gh — GitHub integration (issues, PRs, authentication)
if (!hasCommand('gh')) {
  warnings.push('gh (GitHub CLI) not found — GitHub integration will not be available.');
}

// Optional: agent CLIs
if (!hasCommand('claude')) {
  warnings.push('claude (Claude Code) not found — Claude Code agent will not be available.');
}
if (!hasCommand('codex')) {
  warnings.push('codex (Codex CLI) not found — Codex agent will not be available.');
}

// Optional: container runtimes
if (!hasCommand('docker') && !hasCommand('podman') && !hasCommand('lxc')) {
  warnings.push('No container runtime found (docker, podman, or lxc) — container management will not be available.');
}

// Optional: ffmpeg — screen recording
if (!hasCommand('ffmpeg')) {
  warnings.push('ffmpeg not found — screen recording will not work.');
  setupHints.add('setup.sh');
}

// Platform-specific checks
if (process.platform === 'linux') {
  // Chrome / Puppeteer libs (only needed on Linux — macOS ships its own)
  try {
    execSync('ldconfig -p | grep -q libatk-1.0', { stdio: 'ignore' });
  } catch {
    warnings.push('Missing Chrome dependencies — browser preview/streaming will not work.');
    setupHints.add('setup.sh');
  }

  // CUSE for serial control signals (DTR/RTS)
  const cusebin = path.join(process.env.HOME || '', '.atoo-studio', 'bin', 'cuse_serial');
  if (!fs.existsSync('/dev/cuse') || !fs.existsSync(cusebin)) {
    warnings.push('CUSE not set up — serial control signals (DTR/RTS) will not work (e.g. auto-reset for ESP32).');
    setupHints.add('setup-cuse.sh');
  }
}

// Print warnings
if (warnings.length > 0) {
  for (const w of warnings) console.warn(`[atoo-studio] ${w}`);
  if (setupHints.size > 0) {
    const prefix = process.platform === 'linux' ? 'sudo ' : '';
    const scripts = [...setupHints].map(s => `${prefix}./${s}`).join('  and  ');
    console.warn(`[atoo-studio] Run:  ${scripts}`);
  }
  console.warn('');
}

// Start the server
await import('../dist/src/index.js');
