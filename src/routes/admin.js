import express from 'express';
import { requireAdmin, requireAuth } from '../auth.js';
import { queries, getSetting, getLoggingEnabled, setLoggingEnabled, getOpenRouterApiKey, setOpenRouterApiKey, getUserExposedModels, setUserExposedModels, getOnlineModels, setOnlineModels } from '../db.js';
import { hashPassword } from '../auth.js';
import { connectToMcpServers, listToolsFromClients, disconnectMcpClients } from '../mcp-client.js';
import db from '../db.js';

const router = express.Router();

async function fetchAllModels(apiKey) {
  try {
    const [generalRes, imageRes] = await Promise.all([
      fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      }),
      fetch('https://openrouter.ai/api/v1/models?output_modalities=image', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      })
    ]);
    const generalData = generalRes.ok ? await generalRes.json() : { data: [] };
    const imageData = imageRes.ok ? await imageRes.json() : { data: [] };
    const modelMap = new Map();
    for (const m of (generalData.data || [])) {
      modelMap.set(m.id, m);
    }
    for (const m of (imageData.data || [])) {
      if (!modelMap.has(m.id)) {
        modelMap.set(m.id, m);
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
      const displayName = `${m.name || m.id}${isOnline ? ' [online]' : ''} (${promptPrice} / ${completionPrice})`;
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

router.get('/settings', requireAdmin, (req, res) => {
  res.json({
    openrouter_api_key: getOpenRouterApiKey() || '',
    logging_enabled: getLoggingEnabled(),
    online_models: getOnlineModels()
  });
});

router.put('/settings', requireAdmin, (req, res) => {
  const { openrouter_api_key, logging_enabled, online_models } = req.body;
  if (openrouter_api_key !== undefined) {
    setOpenRouterApiKey(openrouter_api_key);
  }
  if (logging_enabled !== undefined) {
    setLoggingEnabled(logging_enabled);
  }
  if (online_models !== undefined && Array.isArray(online_models)) {
    setOnlineModels(online_models);
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

router.get('/skills', requireAdmin, (req, res) => {
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

router.get('/mcp/servers', requireAdmin, (req, res) => {
  const servers = queries.getAllMcpServers.all();
  res.json({ servers });
});

router.post('/mcp/servers', requireAdmin, (req, res) => {
  const { name, description, transport_type, command, args, url, auth_token, env } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Name required' });
  }
  if (!transport_type || !['stdio', 'sse'].includes(transport_type)) {
    return res.status(400).json({ error: 'transport_type must be stdio or sse' });
  }
  if (transport_type === 'stdio' && !command) {
    return res.status(400).json({ error: 'Command required for stdio transport' });
  }
  if (transport_type === 'sse' && !url) {
    return res.status(400).json({ error: 'URL required for SSE transport' });
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
  if (!transport_type || !['stdio', 'sse'].includes(transport_type)) {
    return res.status(400).json({ error: 'transport_type must be stdio or sse' });
  }
  queries.updateMcpServer.run(
    name, description || '', transport_type,
    command || null, args ? (typeof args === 'string' ? args : JSON.stringify(args)) : null,
    url || null, auth_token || null,
    env ? (typeof env === 'string' ? env : JSON.stringify(env)) : null,
    enabled !== undefined ? (enabled ? 1 : 0) : 1,
    serverId
  );
  res.json({ success: true });
});

router.delete('/mcp/servers/:id', requireAdmin, (req, res) => {
  const serverId = parseInt(req.params.id);
  queries.deleteMcpServer.run(serverId);
  res.json({ success: true });
});

router.post('/mcp/servers/:id/test', requireAdmin, async (req, res) => {
  const serverId = parseInt(req.params.id);
  const server = queries.getMcpServerById.get(serverId);
  if (!server) {
    return res.status(404).json({ error: 'MCP server not found' });
  }
  try {
    const clients = await connectToMcpServers([server]);
    if (clients.length === 0) {
      return res.json({ success: false, error: 'Failed to connect' });
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