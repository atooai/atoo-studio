/**
 * Pre-trust a workspace directory in ~/.claude.json so that
 * Claude CLI commands don't fail with "Workspace not trusted".
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

export function ensureWorkspaceTrust(directory: string): void {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    let config: any = {};
    if (fs.existsSync(claudeJsonPath)) {
      config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    }
    if (!config.projects) config.projects = {};
    const absDir = path.resolve(directory);
    if (!config.projects[absDir]) config.projects[absDir] = {};
    if (!config.projects[absDir].hasTrustDialogAccepted) {
      config.projects[absDir].hasTrustDialogAccepted = true;
      fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
      console.log(`[claude] Pre-trusted workspace: ${absDir}`);
    }
  } catch (err: any) {
    console.warn(`[claude] Failed to pre-trust workspace: ${err.message}`);
  }
}
