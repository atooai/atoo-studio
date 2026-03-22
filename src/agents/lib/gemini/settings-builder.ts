/**
 * Per-instance Gemini CLI isolation via GEMINI_CLI_HOME.
 *
 * Creates a temporary home directory with:
 *  - Custom settings.json (MCP servers, custom model aliases for reasoning)
 *  - GEMINI.md (system prompt injection)
 *  - Symlinks to real ~/.gemini/ for auth, state, sessions, etc.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { getMcpServerDef, registerMcpToken } from '../../../mcp/config.js';
import { MCP_SYSTEM_PROMPT, CHAIN_SYSTEM_PROMPT } from '../../../mcp/config.js';

const INSTANCES_DIR = path.join(os.homedir(), '.atoo-studio', 'gemini-instances');
const REAL_GEMINI_DIR = path.join(os.homedir(), '.gemini');

// Directories that MUST exist in real ~/.gemini/ before symlinking.
// Without pre-creation, fresh installs would create these inside the
// fake home — sessions and history would be lost on cleanup.
const CRITICAL_DIRS = [
  'tmp',      // session storage — must persist across instances
  'history',  // command history
];

// Fallback list of files/dirs to symlink if readdirSync of real dir fails
const SYMLINK_ITEMS = [
  'oauth_creds.json',
  'google_accounts.json',
  'installation_id',
  'trustedFolders.json',
  'projects.json',
  'state.json',
  'history',
  'tmp',
  'mcp-oauth-tokens.json',
];

/**
 * Map frontend model IDs → CLI model names for Gemini.
 */
export const GEMINI_MODEL_MAP: Record<string, string> = {
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
};

/**
 * Map Gemini CLI model names to built-in alias names for custom alias `extends`.
 * These must match the aliases defined in Gemini CLI's defaultModelConfigs.
 */
const MODEL_ALIAS_BASE: Record<string, string> = {
  'gemini-3.1-pro-preview': 'gemini-3-pro-preview',
  'gemini-3-flash-preview': 'gemini-3-flash-preview',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
};

interface BuildInstanceOptions {
  /** Unique identifier for this instance (session UUID) */
  sessionUuid: string;
  /** Parent atoo-any session UUID for MCP session identity */
  parentSessionUuid?: string;
  /** System prompt to inject via GEMINI.md */
  systemPrompt?: string;
  /** Whether this is a chain continuation */
  isChainContinuation?: boolean;
  /** Frontend model ID (e.g. 'gemini-3.1-pro') */
  model?: string;
  /** Reasoning/thinking level (e.g. 'low', 'medium', 'high') */
  reasoningLevel?: string;
}

interface GeminiInstance {
  /** The fake home directory (set as GEMINI_CLI_HOME) */
  geminiHome: string;
  /** The model argument to pass to --model (may be a custom alias name) */
  modelArg: string;
  /** MCP token registered for this instance */
  mcpToken: string;
  /** Cleanup function to remove the temp directory */
  cleanup: () => void;
}

/**
 * Build an isolated Gemini CLI instance with custom settings.
 */
export function buildGeminiInstance(options: BuildInstanceOptions): GeminiInstance {
  const instanceDir = path.join(INSTANCES_DIR, options.sessionUuid);
  const geminiDir = path.join(instanceDir, '.gemini');

  // Create directory structure
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.mkdirSync(REAL_GEMINI_DIR, { recursive: true });

  // Ensure critical directories exist in the real ~/.gemini/ BEFORE symlinking.
  // Without this, fresh installs would create these inside the fake home and
  // sessions/state would be lost on cleanup.
  for (const dir of CRITICAL_DIRS) {
    fs.mkdirSync(path.join(REAL_GEMINI_DIR, dir), { recursive: true });
  }

  // Symlink everything from real ~/.gemini/ except what we'll write ourselves.
  // Always create symlinks — even dangling ones. On Linux, writing through a
  // dangling symlink creates the target file (if parent dir exists), so first-time
  // auth flows that create oauth_creds.json etc. will write to the real location.
  const SKIP_ITEMS = new Set(['settings.json', 'GEMINI.md']);
  const symlinkItem = (item: string) => {
    if (SKIP_ITEMS.has(item)) return;
    const realPath = path.join(REAL_GEMINI_DIR, item);
    const linkPath = path.join(geminiDir, item);
    try {
      fs.symlinkSync(realPath, linkPath);
    } catch (err: any) {
      if (err.code !== 'EEXIST') {
        console.warn(`[gemini-instance] Failed to symlink ${item}:`, err.message);
      }
    }
  };

  try {
    const realItems = fs.readdirSync(REAL_GEMINI_DIR);
    for (const item of realItems) symlinkItem(item);
  } catch {
    // Real gemini dir unreadable — fall back to known critical items
    for (const item of SYMLINK_ITEMS) symlinkItem(item);
  }

  // Build settings.json by merging the real settings with our MCP config.
  // Critical: the real settings.json contains auth config (security.auth.selectedType)
  // which must be preserved, otherwise Gemini asks the user to re-authenticate.
  const mcpToken = crypto.randomUUID();
  registerMcpToken(mcpToken);
  const mcpDef = getMcpServerDef();

  const mcpEnv: Record<string, string> = {
    ...mcpDef.env,
    ATOO_MCP_TOKEN: mcpToken,
  };
  if (options.parentSessionUuid) {
    mcpEnv.ATOO_CURRENT_SESSION_UUID = options.parentSessionUuid;
  }

  // Start from the real settings (auth, UI prefs, etc.) and layer our additions
  let settings: any = {};
  try {
    const realSettingsPath = path.join(REAL_GEMINI_DIR, 'settings.json');
    settings = JSON.parse(fs.readFileSync(realSettingsPath, 'utf-8'));
  } catch {}

  // Inject MCP server config
  if (!settings.mcpServers) settings.mcpServers = {};
  settings.mcpServers['atoo-studio'] = {
    command: mcpDef.command,
    args: mcpDef.args,
    env: mcpEnv,
  };

  // Determine CLI model name
  let cliModel = options.model ? (GEMINI_MODEL_MAP[options.model] || options.model) : '';
  let modelArg = cliModel;

  // Add custom alias for reasoning/thinking configuration.
  // Gemini 3.x models use thinkingLevel (LOW/MEDIUM/HIGH/MINIMAL).
  // Gemini 2.5.x models use thinkingBudget (token count, 0=off, -1=dynamic).
  // The two parameters CANNOT be mixed.
  if (options.reasoningLevel && cliModel) {
    const isGemini3 = cliModel.startsWith('gemini-3');
    const thinkingConfig = isGemini3
      ? buildGemini3ThinkingConfig(options.reasoningLevel)
      : buildGemini25ThinkingConfig(options.reasoningLevel);

    if (thinkingConfig) {
      const aliasName = `atoo-${options.sessionUuid.slice(0, 8)}`;
      const baseName = MODEL_ALIAS_BASE[cliModel] || cliModel;
      if (!settings.modelConfigs) settings.modelConfigs = {};
      if (!settings.modelConfigs.customAliases) settings.modelConfigs.customAliases = {};
      settings.modelConfigs.customAliases[aliasName] = {
        extends: baseName,
        modelConfig: {
          generateContentConfig: {
            thinkingConfig,
          },
        },
      };
      modelArg = aliasName;
    }
  }

  fs.writeFileSync(path.join(geminiDir, 'settings.json'), JSON.stringify(settings, null, 2));

  // Write GEMINI.md for system prompt injection
  const systemPrompt = options.isChainContinuation
    ? (options.systemPrompt || MCP_SYSTEM_PROMPT) + CHAIN_SYSTEM_PROMPT
    : (options.systemPrompt || MCP_SYSTEM_PROMPT);
  fs.writeFileSync(path.join(geminiDir, 'GEMINI.md'), systemPrompt);

  console.log(`[gemini-instance] Created instance at ${instanceDir} (model=${modelArg || 'default'})`);

  return {
    geminiHome: instanceDir,
    modelArg,
    mcpToken,
    cleanup: () => cleanupGeminiInstance(options.sessionUuid),
  };
}

/**
 * Build thinkingConfig for Gemini 3.x models (uses thinkingLevel).
 * Pro minimum is LOW; Flash supports MINIMAL.
 */
function buildGemini3ThinkingConfig(level: string): Record<string, any> | null {
  switch (level.toLowerCase()) {
    case 'minimal': return { thinkingLevel: 'MINIMAL' };
    case 'low': return { thinkingLevel: 'LOW' };
    case 'medium': return { thinkingLevel: 'MEDIUM' };
    case 'high': return { thinkingLevel: 'HIGH' };
    default: return null;
  }
}

/**
 * Build thinkingConfig for Gemini 2.5.x models (uses thinkingBudget).
 * Budget is token count: 0=disabled, -1=dynamic, or a specific number.
 */
function buildGemini25ThinkingConfig(level: string): Record<string, any> | null {
  switch (level.toLowerCase()) {
    case 'low': return { thinkingBudget: 1024 };
    case 'medium': return { thinkingBudget: 8192 };
    case 'high': return { thinkingBudget: -1 }; // dynamic (max)
    default: return null;
  }
}

/**
 * Remove a Gemini instance's temporary directory.
 */
export function cleanupGeminiInstance(sessionUuid: string): void {
  const instanceDir = path.join(INSTANCES_DIR, sessionUuid);
  try {
    fs.rmSync(instanceDir, { recursive: true, force: true });
    console.log(`[gemini-instance] Cleaned up instance ${sessionUuid}`);
  } catch (err: any) {
    console.warn(`[gemini-instance] Failed to clean up ${sessionUuid}:`, err.message);
  }
}

/**
 * Clean up stale Gemini instances older than maxAgeMs.
 */
export function cleanupStaleGeminiInstances(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
  try {
    if (!fs.existsSync(INSTANCES_DIR)) return;
    const now = Date.now();
    for (const dir of fs.readdirSync(INSTANCES_DIR)) {
      const dirPath = path.join(INSTANCES_DIR, dir);
      try {
        const stat = fs.statSync(dirPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          console.log(`[gemini-instance] Cleaned up stale instance: ${dir}`);
        }
      } catch {}
    }
  } catch {}
}
