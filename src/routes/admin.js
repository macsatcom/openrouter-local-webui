import express from 'express';
import { requireAdmin, requireAuth } from '../auth.js';
import { queries, getSetting, setSetting, getLoggingEnabled, setLoggingEnabled, getOpenRouterApiKey, setOpenRouterApiKey, getUserExposedModels, setUserExposedModels, getOnlineModels, setOnlineModels } from '../db.js';
import { hashPassword } from '../auth.js';
import { connectToMcpServers, listToolsFromClients, disconnectMcpClients, invalidateMcpServer } from '../mcp-client.js';
import db from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();

async function fetchAllModels(apiKey) {
  try {
    const [generalRes, imageRes, videoRes] = await Promise.all([
      fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      }),
      fetch('https://openrouter.ai/api/v1/models?output_modalities=image', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      }),
      fetch('https://openrouter.ai/api/v1/videos/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      })
    ]);
    const generalData = generalRes.ok ? await generalRes.json() : { data: [] };
    const imageData = imageRes.ok ? await imageRes.json() : { data: [] };
    const videoData = videoRes.ok ? await videoRes.json() : { data: [] };
    const modelMap = new Map();
    for (const m of (generalData.data || [])) {
      modelMap.set(m.id, m);
    }
    for (const m of (imageData.data || [])) {
      if (!modelMap.has(m.id)) {
        modelMap.set(m.id, m);
      }
    }
    for (const m of (videoData.data || [])) {
      if (!modelMap.has(m.id)) {
        const skus = m.pricing_skus || {};
        const prices = Object.values(skus).map(p => parseFloat(p)).filter(p => !isNaN(p));
        const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
        modelMap.set(m.id, { ...m, pricing: { prompt: String(minPrice), completion: '0' }, is_video: true });
      }
    }
    return Array.from(modelMap.values());
  } catch {
    return [];
  }
}

function formatPrice(price) {
  const p = parseFloat(price);
  if (p === 0) return 'Free';
  if (p < 0.00001) return '$' + (p * 1000000).toFixed(2) + '/M';
  if (p < 0.0001) return '$' + (p * 1000000).toFixed(1) + '/M';
  if (p < 0.001) return '$' + (p * 1000).toFixed(2) + '/K';
  return '$' + p.toFixed(3);
}

function getModelPrice(m) {
  const prompt = parseFloat(m.pricing?.prompt) || 0;
  const completion = parseFloat(m.pricing?.completion) || 0;
  return prompt + completion;
}

const __adminDirname = path.dirname(fileURLToPath(import.meta.url));
const MARKETPLACE_CACHE = path.join(__adminDirname, '..', '..', 'data', 'marketplace-cache.json');
const MARKETPLACE_SOURCE = 'https://mcp-marketplace.io/llms-full.txt';
const MARKETPLACE_TTL = 24 * 60 * 60 * 1000;

const INCOMPATIBLE_PATTERNS = [
  'blender', 'godot', 'unreal', 'unity', 'ios simulator', 'android studio',
  'chrome browser', 'chrome extension', 'peekaboo', 'figma', 'photoshop',
  'premiere', 'after effects', 'xcode', 'swift', 'arkit', 'visionos',
  'macos', 'mac only', 'windows only', 'hardware', 'gpio', 'arduino',
  'vr', 'oculus', 'obsidian', 'whatsapp', 'slack', 'discord bot',
  'desktop app', 'electron app', 'menubar', 'dock',
];

function isIncompatible(entry) {
  const check = (entry.name + ' ' + (entry.Description || '') + ' ' + (entry.Summary || '') + ' ' + (entry.Tags || '')).toLowerCase();
  return INCOMPATIBLE_PATTERNS.some(p => check.includes(p));
}

function parseInstallCommand(installCmd) {
  if (!installCmd) return null;
  if (installCmd.includes('--transport http') || installCmd.includes('--transport streamable')) {
    const urlMatch = installCmd.match(/(https?:\/\/\S+)/);
    const nameMatch = installCmd.match(/claude mcp add(?: --transport \S+)?\s+(\S+)\s+/);
    return {
      transport_type: 'streamable-http',
      command: null,
      args: null,
      url: urlMatch ? urlMatch[1] : null,
      name: nameMatch ? nameMatch[1] : null
    };
  }
  const uvxMatch = installCmd.match(/--\s*uvx\s+(.+)/);
  if (uvxMatch) {
    const rest = uvxMatch[1].trim();
    return { transport_type: 'stdio', command: 'uvx', args: rest.split(/\s+/) };
  }
  const npxMatch = installCmd.match(/--\s*npx\s+(.+)/);
  if (npxMatch) {
    const rest = npxMatch[1].trim();
    return { transport_type: 'stdio', command: 'npx', args: rest.split(/\s+/) };
  }
  const pipMatch = installCmd.match(/--\s*pip\s+(.+)/);
  if (pipMatch) {
    return { transport_type: 'stdio', command: 'python3', args: ['-m', ...pipMatch[1].trim().split(/\s+/)] };
  }
  return null;
}

function parseMarketplaceEntries(text) {
  const entries = [];
  const blocks = text.split(/\n---+\n/);
  for (const block of blocks) {
    if (!block.trim() || block.includes('Generated:') || block.includes('Total servers:')) continue;
    const entry = {};
    const lines = block.split('\n');
    let currentKey = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('## ')) {
        entry.name = line.slice(3).trim();
        continue;
      }
      const kvMatch = line.match(/^([A-Za-z0-9 ()]+?):\s*(.*)/);
      if (kvMatch) {
        currentKey = kvMatch[1].trim();
        entry[currentKey] = kvMatch[2].trim();
      } else if (currentKey && line.trim() && !line.startsWith('Install')) {
        entry[currentKey] = (entry[currentKey] || '') + ' ' + line.trim();
      }
    }
    const name = entry.name || (entry['URL'] ? entry['URL'].split('/').pop() : null);
    if (name && name !== 'MCP Marketplace' && name !== 'Complete Server Catalog') {
      if (!entry.name) entry.name = name;
      entries.push(entry);
    }
  }
  return entries;
}

function loadMarketplaceCache() {
  try {
    if (fs.existsSync(MARKETPLACE_CACHE)) {
      const stat = fs.statSync(MARKETPLACE_CACHE);
      if (Date.now() - stat.mtimeMs < MARKETPLACE_TTL) {
        return JSON.parse(fs.readFileSync(MARKETPLACE_CACHE, 'utf-8'));
      }
    }
  } catch {}
  return null;
}

function saveMarketplaceCache(entries) {
  try {
    const dir = path.dirname(MARKETPLACE_CACHE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MARKETPLACE_CACHE, JSON.stringify(entries));
  } catch {}
}

router.get('/models', requireAdmin, async (req, res) => {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    return res.json({ models: [] });
  }
  const models = await fetchAllModels(apiKey);
  const onlineModels = getOnlineModels();

  const sortedModels = models.sort((a, b) => getModelPrice(a) - getModelPrice(b));

  res.json({
    models: sortedModels.map(m => {
      const promptPrice = m.pricing?.prompt ? formatPrice(m.pricing.prompt) : '?';
      const completionPrice = m.pricing?.completion ? formatPrice(m.pricing.completion) : '?';
      const isOnline = onlineModels.includes(m.id);
      const isVideo = m.is_video === true;
      const videoTag = isVideo ? ' [video]' : '';
      const displayName = `${m.name || m.id}${videoTag}${isOnline ? ' [online]' : ''} (${promptPrice} / ${completionPrice})`;
      return {
        id: m.id,
        name: m.name || m.id,
        display_name: displayName,
        prompt_price: promptPrice,
        completion_price: completionPrice,
        is_online: isOnline
      };
    })
  });
});

router.get('/online-models', requireAdmin, (req, res) => {
  res.json({ models: getOnlineModels() });
});

router.put('/online-models', requireAdmin, (req, res) => {
  const { model_ids } = req.body;
  if (!Array.isArray(model_ids)) {
    return res.status(400).json({ error: 'model_ids must be an array' });
  }
  setOnlineModels(model_ids);
  res.json({ success: true });
});

router.get('/users', requireAdmin, (req, res) => {
  const users = queries.getAllUsers.all();
  res.json({
    users: users.map(u => ({
      id: u.id,
      username: u.username,
      is_admin: u.is_admin,
      created_at: u.created_at,
      daily_limit_cents: u.daily_limit_cents ?? -1,
      monthly_limit_cents: u.monthly_limit_cents ?? -1,
      exposed_models: getUserExposedModels(u.id)
    })),
    admin_models: getUserExposedModels(req.user.id)
  });
});

router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, daily_limit_cents, monthly_limit_cents, exposed_models } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const existing = queries.getUserByUsername.get(username);
    if (existing) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    const passwordHash = await hashPassword(password);
    const result = queries.createUser.run(username, passwordHash, 0);
    if (daily_limit_cents !== undefined || monthly_limit_cents !== undefined) {
      queries.updateUserLimits.run(result.lastInsertRowid, daily_limit_cents ?? -1, monthly_limit_cents ?? -1);
    }
    if (exposed_models && Array.isArray(exposed_models)) {
      setUserExposedModels(result.lastInsertRowid, exposed_models);
    }
    res.json({ success: true, userId: result.lastInsertRowid });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

router.put('/users/:id', requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { password, daily_limit_cents, monthly_limit_cents, is_admin, exposed_models } = req.body;
    const user = queries.getUserById.get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (password) {
      const passwordHash = await hashPassword(password);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
    }
    if (daily_limit_cents !== undefined || monthly_limit_cents !== undefined) {
      queries.updateUserLimits.run(userId, daily_limit_cents ?? -1, monthly_limit_cents ?? -1);
    }
    if (is_admin !== undefined && req.user.id !== userId) {
      db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(is_admin ? 1 : 0, userId);
    }
    if (exposed_models !== undefined && Array.isArray(exposed_models)) {
      setUserExposedModels(userId, exposed_models);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

router.delete('/users/:id', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  if (userId === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  queries.deleteUserSessions.run(userId);
  queries.deleteUser.run(userId);
  res.json({ success: true });
});

router.get('/users/:id/memories', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  const user = queries.getUserById.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const memories = queries.getUserMemories.all(userId);
  res.json({ memories });
});

router.post('/users/:id/memories', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  const { key, value } = req.body;
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'key and value required' });
  }
  const user = queries.getUserById.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  queries.upsertUserMemory.run(userId, key.trim(), value);
  res.json({ success: true });
});

router.delete('/users/:id/memories/:key', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  const key = decodeURIComponent(req.params.key);
  const user = queries.getUserById.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  queries.deleteUserMemory.run(userId, key);
  res.json({ success: true });
});

router.get('/settings', requireAdmin, (req, res) => {
  res.json({
    openrouter_api_key: getOpenRouterApiKey() || '',
    logging_enabled: getLoggingEnabled(),
    online_models: getOnlineModels(),
    max_video_resolution: getSetting('max_video_resolution', ''),
    max_video_duration: getSetting('max_video_duration', '0')
  });
});

router.put('/settings', requireAdmin, (req, res) => {
  const { openrouter_api_key, logging_enabled, online_models, max_video_resolution, max_video_duration } = req.body;
  if (openrouter_api_key !== undefined) {
    setOpenRouterApiKey(openrouter_api_key);
  }
  if (logging_enabled !== undefined) {
    setLoggingEnabled(logging_enabled);
  }
  if (online_models !== undefined && Array.isArray(online_models)) {
    setOnlineModels(online_models);
  }
  if (max_video_resolution !== undefined) {
    setSetting('max_video_resolution', max_video_resolution);
  }
  if (max_video_duration !== undefined) {
    setSetting('max_video_duration', String(max_video_duration));
  }
  res.json({ success: true });
});

router.get('/logs', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
  const logs = userId ? queries.getChatLogsByUser.all(userId, limit, offset) : queries.getChatLogs.all(limit, offset);
  const count = userId ? queries.countChatLogsByUser.get(userId).count : queries.countChatLogs.get().count;
  res.json({ logs, total: count });
});

router.get('/image-logs', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
  const logs = userId ? queries.getImageLogsByUser.all(userId, limit, offset) : queries.getImageLogs.all(limit, offset);
  const count = userId ? queries.countImageLogsByUser.get(userId).count : queries.countImageLogs.get().count;
  res.json({ logs, total: count });
});

router.get('/video-logs', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
  const logs = userId ? queries.getVideoLogsByUser.all(userId, limit, offset) : queries.getVideoLogs.all(limit, offset);
  const count = userId ? queries.countVideoLogsByUser.get(userId).count : queries.countVideoLogs.get().count;
  res.json({ logs, total: count });
});

router.get('/video-models', requireAdmin, async (req, res) => {
  const apiKey = getSetting('openrouter_api_key');
  if (!apiKey) return res.json({ models: [] });
  try {
    const response = await fetch('https://openrouter.ai/api/v1/videos/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!response.ok) return res.json({ models: [] });
    const data = await response.json();
    res.json({ models: data.data || [] });
  } catch {
    res.json({ models: [] });
  }
});

router.get('/skills', requireAuth, (req, res) => {
  const skills = queries.getAllSkills.all();
  res.json({ skills });
});

router.post('/skills', requireAdmin, (req, res) => {
  const { name, description, content } = req.body;
  if (!name || !content) {
    return res.status(400).json({ error: 'Name and content required' });
  }
  try {
    const result = queries.createSkill.run(name, description || '', content);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Skill name already exists' });
    }
    throw error;
  }
});

router.put('/skills/:id', requireAdmin, (req, res) => {
  const skillId = parseInt(req.params.id);
  const { name, description, content } = req.body;
  if (!name || !content) {
    return res.status(400).json({ error: 'Name and content required' });
  }
  queries.updateSkill.run(name, description || '', content, skillId);
  res.json({ success: true });
});

router.delete('/skills/:id', requireAdmin, (req, res) => {
  const skillId = parseInt(req.params.id);
  queries.deleteSkill.run(skillId);
  res.json({ success: true });
});

router.get('/mcp/marketplace', requireAdmin, async (req, res) => {
  const { search, category, mode, hide_incompatible, refresh } = req.query;

  let entries = refresh === '1' ? null : loadMarketplaceCache();

  if (!entries) {
    try {
      const response = await fetch(MARKETPLACE_SOURCE, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      entries = parseMarketplaceEntries(text);
      saveMarketplaceCache(entries);
    } catch (e) {
      entries = loadMarketplaceCache();
      if (!entries) {
        return res.status(502).json({ error: 'Failed to fetch marketplace data', detail: e.message });
      }
      res.setHeader('X-Marketplace-Stale', '1');
    }
  }

  let filtered = entries;

  if (hide_incompatible === '1') {
    filtered = filtered.filter(e => !isIncompatible(e));
  }

  if (mode === 'local') {
    filtered = filtered.filter(e => (e.Mode || '').toLowerCase() === 'local');
  } else if (mode === 'remote') {
    filtered = filtered.filter(e => (e.Mode || '').toLowerCase() === 'remote');
  }

  if (category) {
    filtered = filtered.filter(e => (e.Category || '').toLowerCase() === category.toLowerCase());
  }

  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(e => {
      return (e.name || '').toLowerCase().includes(q) ||
        (e.Summary || '').toLowerCase().includes(q) ||
        (e.Description || '').toLowerCase().includes(q) ||
        (e.Tags || '').toLowerCase().includes(q) ||
        (e.Category || '').toLowerCase().includes(q);
    });
  }

  const categories = [...new Set(entries.map(e => e.Category).filter(Boolean))].sort();
  const total = entries.length;
  const shown = filtered.length;

  res.json({
    total,
    shown,
    categories,
    entries: filtered.slice(0, 200).map(e => ({
      name: e.name || (e.URL ? e.URL.split('/').pop() : ''),
      url: e.URL || '',
      summary: e.Summary || '',
      description: (e.Description || '').slice(0, 500),
      category: e.Category || '',
      mode: e.Mode || '',
      pricing: e.Pricing || '',
      github: e.GitHub || '',
      githubStars: e['GitHub Stars'] || '',
      securityScore: e['Security Score'] || '',
      install: e['Install (Claude Code)'] || e['Install (Claude Code Remote)'] || '',
      requiredCredentials: e['Required Credentials'] || '',
      npm: e['npm'] || '',
      pypi: e['PyPI'] || '',
      remoteUrl: e['Remote URL'] || e['streamable-http'] || '',
      mcpTools: e['MCP Tools'] || '',
      tags: e['Tags'] || '',
      creator: e['Creator'] || '',
      parsed: parseInstallCommand(e['Install (Claude Code)'] || e['Install (Claude Code Remote)'] || '')
    }))
  });
});

router.get('/mcp/servers', requireAdmin, (req, res) => {
  const servers = queries.getAllMcpServers.all();
  res.json({ servers });
});

router.post('/mcp/servers', requireAdmin, (req, res) => {
  const { name, description, transport_type, command, args, url, auth_token, env } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Name required' });
  }
  if (!transport_type || !['stdio', 'sse', 'streamable-http'].includes(transport_type)) {
    return res.status(400).json({ error: 'transport_type must be stdio, sse, or streamable-http' });
  }
  if (transport_type === 'stdio' && !command) {
    return res.status(400).json({ error: 'Command required for stdio transport' });
  }
  if ((transport_type === 'sse' || transport_type === 'streamable-http') && !url) {
    return res.status(400).json({ error: 'URL required for SSE/streamable-http transport' });
  }
  try {
    const result = queries.createMcpServer.run(
      name, description || '', transport_type,
      command || null, args ? (typeof args === 'string' ? args : JSON.stringify(args)) : null,
      url || null, auth_token || null,
      env ? (typeof env === 'string' ? env : JSON.stringify(env)) : null, 1
    );
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'MCP server name already exists' });
    }
    throw error;
  }
});

router.put('/mcp/servers/:id', requireAdmin, (req, res) => {
  const serverId = parseInt(req.params.id);
  const { name, description, transport_type, command, args, url, auth_token, env, enabled } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Name required' });
  }
  if (!transport_type || !['stdio', 'sse', 'streamable-http'].includes(transport_type)) {
    return res.status(400).json({ error: 'transport_type must be stdio, sse, or streamable-http' });
  }
  queries.updateMcpServer.run(
    name, description || '', transport_type,
    command || null, args ? (typeof args === 'string' ? args : JSON.stringify(args)) : null,
    url || null, auth_token || null,
    env ? (typeof env === 'string' ? env : JSON.stringify(env)) : null,
    enabled !== undefined ? (enabled ? 1 : 0) : 1,
    serverId
  );
  invalidateMcpServer(serverId);
  res.json({ success: true });
});

router.delete('/mcp/servers/:id', requireAdmin, (req, res) => {
  const serverId = parseInt(req.params.id);
  queries.deleteMcpServer.run(serverId);
  invalidateMcpServer(serverId);
  res.json({ success: true });
});

router.post('/mcp/servers/:id/test', requireAdmin, async (req, res) => {
  const serverId = parseInt(req.params.id);
  const server = queries.getMcpServerById.get(serverId);
  if (!server) {
    return res.status(404).json({ error: 'MCP server not found' });
  }
  try {
    const { clients, failures } = await connectToMcpServers([server]);
    if (clients.length === 0) {
      const reason = failures[0]?.reason || 'Failed to connect';
      return res.json({ success: false, error: reason });
    }
    const result = await listToolsFromClients(clients);
    await disconnectMcpClients(clients);
    res.json({
      success: true,
      toolCount: result.tools.length,
      tools: result.tools.map(t => t.function.name)
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

router.get('/mcp/servers-enabled', requireAuth, (req, res) => {
  const servers = queries.getEnabledMcpServers.all().map(s => ({
    id: s.id,
    name: s.name,
    description: s.description
  }));
  res.json({ servers });
});

export default router;