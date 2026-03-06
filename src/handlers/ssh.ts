import { Router } from 'express';
import crypto from 'crypto';
import { vccDb } from '../state/db.js';
import { sshManager } from '../services/ssh-manager.js';
import { obfuscate } from '../services/obfuscation.js';

export const sshRouter = Router();

// Connect to SSH host (creates DB record + live connection)
sshRouter.post('/api/ssh/connect', async (req, res) => {
  const { label, host, port, username, auth_method, password, privateKey, passphrase, systemKeyPath } = req.body;

  if (!host || !username || !auth_method) {
    return res.status(400).json({ error: 'host, username, and auth_method are required' });
  }

  try {
    const config: any = {
      label: label || `${username}@${host}`,
      host,
      port: port || 22,
      username,
      auth_method,
    };

    if (auth_method === 'password' && password) {
      config.password_obfuscated = obfuscate(password);
    } else if (auth_method === 'privatekey' && privateKey) {
      config.private_key_obfuscated = obfuscate(privateKey);
      if (passphrase) config.passphrase_obfuscated = obfuscate(passphrase);
    } else if (auth_method === 'systemkey' && systemKeyPath) {
      config.system_key_path = systemKeyPath;
      if (passphrase) config.passphrase_obfuscated = obfuscate(passphrase);
    }

    const dbRecord = vccDb.createSshConnection(config);

    // Attempt live connection
    await sshManager.connect(dbRecord);

    // Verify claude CLI
    const hasClaude = await sshManager.verifyClaudeCli(dbRecord.id);

    res.json({
      id: dbRecord.id,
      label: dbRecord.label,
      host: dbRecord.host,
      port: dbRecord.port,
      username: dbRecord.username,
      auth_method: dbRecord.auth_method,
      connected: true,
      has_claude: hasClaude,
    });
  } catch (err: any) {
    console.error('[ssh] Connect failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate ed25519 keypair
sshRouter.post('/api/ssh/generate-keypair', (_req, res) => {
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // Convert PEM public key to OpenSSH format for authorized_keys
    const pubKeyObj = crypto.createPublicKey(publicKey);
    const sshPublicKey = pubKeyObj.export({ type: 'spki', format: 'der' });
    const opensshPubKey = `ssh-ed25519 ${Buffer.from(sshPublicKey).toString('base64')} ccproxy-generated`;

    res.json({ privateKey, publicKey: opensshPubKey });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect
sshRouter.post('/api/ssh/:id/disconnect', async (req, res) => {
  try {
    await sshManager.disconnect(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Connection status
sshRouter.get('/api/ssh/:id/status', (req, res) => {
  const status = sshManager.getStatus(req.params.id);
  const dbRecord = vccDb.getSshConnection(req.params.id);
  res.json({
    ...status,
    label: dbRecord?.label,
    host: dbRecord?.host,
    port: dbRecord?.port,
    username: dbRecord?.username,
  });
});

// List all connections (with live status)
sshRouter.get('/api/ssh/connections', (_req, res) => {
  const connections = vccDb.listSshConnections();
  const result = connections.map(c => ({
    id: c.id,
    label: c.label,
    host: c.host,
    port: c.port,
    username: c.username,
    auth_method: c.auth_method,
    created_at: c.created_at,
    ...sshManager.getStatus(c.id),
  }));
  res.json(result);
});

// Remote folder browser (SFTP)
sshRouter.get('/api/ssh/:id/browse', async (req, res) => {
  const browsePath = (req.query.path as string) || '/home';
  try {
    const entries = await sshManager.sftpReaddir(req.params.id, browsePath);
    const dirs = entries.filter(e => e.type === 'dir').map(e => ({
      name: e.name,
      path: browsePath === '/' ? `/${e.name}` : `${browsePath}/${e.name}`,
    }));

    const parent = browsePath === '/' ? null : browsePath.substring(0, browsePath.lastIndexOf('/')) || '/';

    res.json({ current: browsePath, parent, dirs });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Create remote directory
sshRouter.post('/api/ssh/:id/browse/mkdir', async (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath) return res.status(400).json({ error: 'path is required' });
  try {
    await sshManager.sftpMkdir(req.params.id, dirPath);
    res.json({ success: true, path: dirPath });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Delete SSH connection
sshRouter.delete('/api/ssh/:id', async (req, res) => {
  try {
    await sshManager.disconnect(req.params.id);
    vccDb.deleteSshConnection(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Reconnect to a saved connection
sshRouter.post('/api/ssh/:id/reconnect', async (req, res) => {
  const dbRecord = vccDb.getSshConnection(req.params.id);
  if (!dbRecord) return res.status(404).json({ error: 'Connection not found' });

  try {
    await sshManager.connect(dbRecord);
    const hasClaude = await sshManager.verifyClaudeCli(dbRecord.id);
    res.json({ connected: true, has_claude: hasClaude });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
