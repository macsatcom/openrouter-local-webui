import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'chat.db');

import fs from 'fs';
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS chat_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    response TEXT,
    cost REAL,
    tokens INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS image_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    image_path TEXT,
    cost REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_limits (
    user_id INTEGER PRIMARY KEY,
    daily_limit_cents INTEGER DEFAULT -1,
    monthly_limit_cents INTEGER DEFAULT -1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_spending (
    user_id INTEGER NOT NULL,
    date DATE NOT NULL,
    cents_spent INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_exposed_models (
    user_id INTEGER NOT NULL,
    model_id TEXT NOT NULL,
    PRIMARY KEY (user_id, model_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    model TEXT NOT NULL,
    cost REAL,
    tokens INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS mcp_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    transport_type TEXT NOT NULL DEFAULT 'stdio',
    command TEXT,
    args TEXT,
    url TEXT,
    auth_token TEXT,
    env TEXT,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS video_logs (
    id           TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL,
    model        TEXT NOT NULL,
    prompt       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    job_id       TEXT,
    video_path   TEXT,
    duration     INTEGER,
    resolution   TEXT,
    aspect_ratio TEXT,
    has_audio    INTEGER DEFAULT 0,
    cost         REAL DEFAULT 0,
    error        TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS video_notifications (
    user_id    INTEGER NOT NULL,
    video_id   TEXT NOT NULL,
    seen       INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, video_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES video_logs(id) ON DELETE CASCADE
  );
`);

try {
  db.exec('ALTER TABLE mcp_servers ADD COLUMN env TEXT');
} catch (e) {
  /* column already exists */
}

try {
  const hasOldSessions = db.prepare("SELECT name FROM pragma_table_info('sessions') WHERE name='user_id'").get();
  if (hasOldSessions) {
    db.exec('DROP TABLE sessions');
    console.log('Migrated: replaced legacy sessions table');
  }
} catch (e) {
  /* table may not exist */
}

export const queries = {
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  createUser: db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  updateUserLimits: db.prepare('INSERT OR REPLACE INTO user_limits (user_id, daily_limit_cents, monthly_limit_cents) VALUES (?, ?, ?)'),
  getUserLimits: db.prepare('SELECT * FROM user_limits WHERE user_id = ?'),
  getAllUsers: db.prepare('SELECT u.*, ul.daily_limit_cents, ul.monthly_limit_cents FROM users u LEFT JOIN user_limits ul ON u.id = ul.user_id'),

  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),

  logChat: db.prepare('INSERT INTO chat_logs (user_id, model, prompt, response, cost, tokens) VALUES (?, ?, ?, ?, ?, ?)'),
  getChatLogs: db.prepare('SELECT cl.*, u.username FROM chat_logs cl JOIN users u ON cl.user_id = u.id ORDER BY cl.created_at DESC LIMIT ? OFFSET ?'),
  getChatLogsByUser: db.prepare('SELECT cl.*, u.username FROM chat_logs cl JOIN users u ON cl.user_id = u.id WHERE cl.user_id = ? ORDER BY cl.created_at DESC LIMIT ? OFFSET ?'),
  countChatLogs: db.prepare('SELECT COUNT(*) as count FROM chat_logs'),
  countChatLogsByUser: db.prepare('SELECT COUNT(*) as count FROM chat_logs WHERE user_id = ?'),

  logImage: db.prepare('INSERT INTO image_logs (user_id, model, prompt, image_path, cost) VALUES (?, ?, ?, ?, ?)'),
  getImageLogs: db.prepare('SELECT il.*, u.username FROM image_logs il JOIN users u ON il.user_id = u.id ORDER BY il.created_at DESC LIMIT ? OFFSET ?'),
  getImageLogsByUser: db.prepare('SELECT il.*, u.username FROM image_logs il JOIN users u ON il.user_id = u.id WHERE il.user_id = ? ORDER BY il.created_at DESC LIMIT ? OFFSET ?'),
  countImageLogs: db.prepare('SELECT COUNT(*) as count FROM image_logs'),
  countImageLogsByUser: db.prepare('SELECT COUNT(*) as count FROM image_logs WHERE user_id = ?'),

  getSpending: db.prepare('SELECT cents_spent FROM user_spending WHERE user_id = ? AND date = ?'),
  updateSpending: db.prepare('INSERT INTO user_spending (user_id, date, cents_spent) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET cents_spent = cents_spent + ?'),
  getMonthlySpending: db.prepare("SELECT SUM(cents_spent) as total FROM user_spending WHERE user_id = ? AND date >= date('now', 'start of month')"),

  getAllSkills: db.prepare('SELECT * FROM skills ORDER BY name'),
  getSkillById: db.prepare('SELECT * FROM skills WHERE id = ?'),
  createSkill: db.prepare('INSERT INTO skills (name, description, content) VALUES (?, ?, ?)'),
  updateSkill: db.prepare('UPDATE skills SET name = ?, description = ?, content = ? WHERE id = ?'),
  deleteSkill: db.prepare('DELETE FROM skills WHERE id = ?'),

  getUserExposedModels: db.prepare('SELECT model_id FROM user_exposed_models WHERE user_id = ?'),
  setUserExposedModels: db.prepare('DELETE FROM user_exposed_models WHERE user_id = ?'),
  addUserExposedModel: db.prepare('INSERT OR IGNORE INTO user_exposed_models (user_id, model_id) VALUES (?, ?)'),
  deleteUserExposedModel: db.prepare('DELETE FROM user_exposed_models WHERE user_id = ? AND model_id = ?'),

  getConversations: db.prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC'),
  getConversationById: db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?'),
  createConversation: db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?)'),
  updateConversationTitle: db.prepare('UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'),
  updateConversationTime: db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?'),
  deleteConversation: db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?'),

  getConversationMessages: db.prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC'),
  createChatMessage: db.prepare('INSERT INTO chat_messages (conversation_id, role, content, model, cost, tokens) VALUES (?, ?, ?, ?, ?, ?)'),

  getAllMcpServers: db.prepare('SELECT * FROM mcp_servers ORDER BY name'),
  getMcpServerById: db.prepare('SELECT * FROM mcp_servers WHERE id = ?'),
  getEnabledMcpServers: db.prepare('SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name'),
  createMcpServer: db.prepare('INSERT INTO mcp_servers (name, description, transport_type, command, args, url, auth_token, env, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  updateMcpServer: db.prepare('UPDATE mcp_servers SET name = ?, description = ?, transport_type = ?, command = ?, args = ?, url = ?, auth_token = ?, env = ?, enabled = ? WHERE id = ?'),
  deleteMcpServer: db.prepare('DELETE FROM mcp_servers WHERE id = ?'),

  getUserMemories: db.prepare('SELECT key, value FROM user_memories WHERE user_id = ? ORDER BY key'),
  upsertUserMemory: db.prepare('INSERT INTO user_memories (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'),
  deleteUserMemory: db.prepare('DELETE FROM user_memories WHERE user_id = ? AND key = ?'),

  logVideo: db.prepare('INSERT INTO video_logs (id, user_id, model, prompt, status, job_id, duration, resolution, aspect_ratio, has_audio, cost, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  updateVideoJobResult: db.prepare('UPDATE video_logs SET status = ?, video_path = ?, cost = ?, completed_at = ?, error = ? WHERE id = ?'),
  getVideoLogsByUser: db.prepare('SELECT vl.*, u.username FROM video_logs vl JOIN users u ON vl.user_id = u.id WHERE vl.user_id = ? ORDER BY vl.created_at DESC LIMIT ? OFFSET ?'),
  getVideoLogs: db.prepare('SELECT vl.*, u.username FROM video_logs vl JOIN users u ON vl.user_id = u.id ORDER BY vl.created_at DESC LIMIT ? OFFSET ?'),
  countVideoLogsByUser: db.prepare('SELECT COUNT(*) as count FROM video_logs WHERE user_id = ?'),
  countVideoLogs: db.prepare('SELECT COUNT(*) as count FROM video_logs'),
  getActiveVideoJobs: db.prepare("SELECT * FROM video_logs WHERE status IN ('pending', 'in_progress')"),
  getVideoById: db.prepare('SELECT * FROM video_logs WHERE id = ?'),
  insertVideoNotification: db.prepare('INSERT OR IGNORE INTO video_notifications (user_id, video_id) VALUES (?, ?)'),
  getUnseenNotifications: db.prepare('SELECT vn.*, vl.prompt, vl.status FROM video_notifications vn JOIN video_logs vl ON vn.video_id = vl.id WHERE vn.user_id = ? AND vn.seen = 0 ORDER BY vn.created_at DESC'),
  markNotificationsSeen: db.prepare('UPDATE video_notifications SET seen = 1 WHERE user_id = ?'),
  markVideoNotificationSeen: db.prepare('UPDATE video_notifications SET seen = 1 WHERE user_id = ? AND video_id = ?'),
  deleteVideoLog: db.prepare('DELETE FROM video_logs WHERE id = ?'),
  deleteVideoNotification: db.prepare('DELETE FROM video_notifications WHERE video_id = ?')
};

export function getSetting(key, defaultValue = null) {
  const row = queries.getSetting.get(key);
  return row ? row.value : defaultValue;
}

export function setSetting(key, value) {
  queries.setSetting.run(key, value);
}

export function getExposedModels() {
  const val = getSetting('exposed_models');
  if (!val) return null;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

export function setExposedModels(models) {
  setSetting('exposed_models', JSON.stringify(models));
}

export function getUserExposedModels(userId) {
  const rows = queries.getUserExposedModels.all(userId);
  return rows.map(r => r.model_id);
}

export function setUserExposedModels(userId, modelIds) {
  queries.setUserExposedModels.run(userId);
  for (const modelId of modelIds) {
    queries.addUserExposedModel.run(userId, modelId);
  }
}

export function getLoggingEnabled() {
  return getSetting('logging_enabled') === 'true';
}

export function setLoggingEnabled(enabled) {
  setSetting('logging_enabled', enabled ? 'true' : 'false');
}

export function getOnlineModels() {
  const val = getSetting('online_models');
  if (!val) return [];
  try {
    return JSON.parse(val);
  } catch {
    return [];
  }
}

export function setOnlineModels(modelIds) {
  setSetting('online_models', JSON.stringify(modelIds));
}

export function getOpenRouterApiKey() {
  return getSetting('openrouter_api_key');
}

export function setOpenRouterApiKey(key) {
  setSetting('openrouter_api_key', key);
}

export function checkUserSpendingLimit(userId) {
  const limits = queries.getUserLimits.get(userId);
  if (!limits) return { allowed: true };

  const today = new Date().toISOString().split('T')[0];
  const dailySpent = queries.getSpending.get(userId, today);
  const monthlyTotal = queries.getMonthlySpending.get(userId);

  if (limits.daily_limit_cents > 0 && dailySpent && dailySpent.cents_spent >= limits.daily_limit_cents) {
    return { allowed: false, reason: 'daily_limit_exceeded' };
  }
  if (limits.monthly_limit_cents > 0 && monthlyTotal && monthlyTotal.total >= limits.monthly_limit_cents) {
    return { allowed: false, reason: 'monthly_limit_exceeded' };
  }

  return { allowed: true };
}

export function recordSpending(userId, cents) {
  const today = new Date().toISOString().split('T')[0];
  queries.updateSpending.run(userId, today, cents, cents);
}

export function getMaxVideoResolution() {
  return getSetting('max_video_resolution', '');
}

export function getMaxVideoDuration() {
  return parseInt(getSetting('max_video_duration', '0')) || 0;
}

export default db;