// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  db.js — MongoDB Helper Module v4.0                                    ║
// ║  Student Prompt Hub AI | By Propeak Digital Academy                   ║
// ║  Replaces lowdb/FileSync with persistent MongoDB Atlas storage        ║
// ║  All functions are async and mirror the old synchronous lowdb API     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

'use strict';

const { MongoClient } = require('mongodb');

// ── Connection state ──────────────────────────────────────────────────────────
let _client   = null;
let _db       = null;
let _isConnected = false;

// ── Default bot_settings document ────────────────────────────────────────────
const DEFAULT_BOT_SETTINGS = {
  _id:                'singleton',
  welcome_msg:        'default',
  about_msg:          'default',
  help_msg:           'default',
  system_prompt:      'default',
  maintenance_mode:   false,
  daily_limit:        100,
  moderation_enabled: true,
  auto_ban_threshold: parseInt(process.env.AUTO_BAN_THRESHOLD || '5', 10),
  warn_threshold:     parseInt(process.env.WARN_THRESHOLD || '2', 10),
  menu_buttons: [
    [{ text: '📸 Upload Image',  callback_data: 'mode_image'  }, { text: '📄 Upload PDF',    callback_data: 'mode_pdf'   }],
    [{ text: '🎤 Voice Note',    callback_data: 'mode_voice'  }, { text: '❓ Quick Question', callback_data: 'mode_chat'  }],
    [{ text: '🎨 Gen Flashcard', callback_data: 'action_flashcard_gen' }, { text: '📜 Commands', callback_data: 'view_commands' }],
    [{ text: '⚙️ My Profile',   callback_data: 'view_profile' }, { text: '🔙 Back',          callback_data: 'back_start'  }]
  ]
};

const DEFAULT_ADMIN = {
  _id:              'singleton',
  pin:              process.env.ADMIN_PIN || 'PECULIAR123',
  api_usage:        0,
  total_broadcasts: 0
};

// ── Connect to MongoDB ────────────────────────────────────────────────────────
async function connect() {
  if (_isConnected) return _db;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI environment variable is not set!');

  console.log('[DB] Connecting to MongoDB Atlas...');

  _client = new MongoClient(uri, {
    maxPoolSize:        10,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS:   10000,
    socketTimeoutMS:    45000,
    retryWrites:        true,
    retryReads:         true
  });

  await _client.connect();
  _db          = _client.db(); // uses DB name from connection string
  _isConnected = true;

  console.log('[DB] ✅ Connected to MongoDB Atlas successfully');

  // Handle disconnection events
  _client.on('close',   () => { _isConnected = false; console.warn('[DB] ⚠️ MongoDB connection closed'); });
  _client.on('error',   (e) => { console.error('[DB] ❌ MongoDB error:', e.message); });
  _client.on('timeout', ()  => { console.warn('[DB] ⚠️ MongoDB connection timeout'); });

  // Seed default documents if they don't exist
  await _seedDefaults();

  return _db;
}

// ── Seed default documents on first run ──────────────────────────────────────
async function _seedDefaults() {
  try {
    // admin singleton
    await _db.collection('admin').updateOne(
      { _id: 'singleton' },
      { $setOnInsert: DEFAULT_ADMIN },
      { upsert: true }
    );

    // bot_settings singleton
    await _db.collection('bot_settings').updateOne(
      { _id: 'singleton' },
      { $setOnInsert: DEFAULT_BOT_SETTINGS },
      { upsert: true }
    );

    console.log('[DB] ✅ Default documents seeded');
  } catch (e) {
    console.error('[DB] Seed error:', e.message);
  }
}

// ── Ensure connected (auto-reconnect wrapper) ─────────────────────────────────
async function getDB() {
  if (_isConnected && _db) return _db;
  return connect();
}

// ── Collection shortcuts ──────────────────────────────────────────────────────
async function col(name) {
  const database = await getDB();
  return database.collection(name);
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get a user document by userId string.
 * Returns null if not found.
 */
async function getUser(userId) {
  const c = await col('users');
  return c.findOne({ _id: String(userId) });
}

/**
Ensure user record exists. Creates it if not. Auto-resets daily count.
Returns userId string.
*/
async function ensureUser(telegramFrom) {
  const userId = String(telegramFrom.id);
  const today  = new Date().toISOString().split('T')[0];
  const c      = await col('users');
  
  const existing = await c.findOne({ _id: userId });
  
  if (!existing) {
    // New user: Insert safely
    await c.insertOne({
      _id:          userId,
      username:     telegramFrom.username ? `@${telegramFrom.username}` : null,
      custom_name:  null,
      joined_date:  today,
      query_count:  0,
      today_count:  0,
      last_reset:   today,
      is_banned:    false,
      custom_limit: null,
      warn_count:   0
    });
  } else {
    // Existing user: Update username ONLY if it changed, using $set to avoid conflicts
    const newUsername = telegramFrom.username ? `@${telegramFrom.username}` : null;
    
    // Only update if username is different to save DB writes
    if (existing.username !== newUsername) {
      await c.updateOne(
        { _id: userId },
        { $set: { username: newUsername } } // Explicit $set prevents conflict
      );
    }

    // Auto-reset daily counter on new day
    if (existing.last_reset !== today) {
      await c.updateOne(
        { _id: userId },
        { $set: { today_count: 0, last_reset: today } }
      );
    }
  }
  return userId;
                                                }

/**
 * Get display name: custom_name → @username → first_name → 'Student'
 */
async function getDisplayName(userId, telegramFrom) {
  const u = await getUser(userId);
  if (u?.custom_name)             return u.custom_name;
  if (telegramFrom?.username)     return `@${telegramFrom.username}`;
  if (telegramFrom?.first_name)   return telegramFrom.first_name;
  return 'Student';
}

/**
 * Check if user is banned.
 */
async function isBanned(userId) {
  const u = await getUser(String(userId));
  return u?.is_banned === true;
}

/**
 * Check daily usage limit.
 */
async function checkLimit(userId) {
  const u       = await getUser(String(userId));
  const settings = await getBotSettings();
  const limit   = u?.custom_limit ?? settings.daily_limit ?? 100;
  const count   = u?.today_count || 0;
  return { allowed: count < limit, count, limit };
}

/**
 * Increment today_count, query_count, and admin api_usage.
 */
async function incrementUsage(userId) {
  const uc = await col('users');
  const ac = await col('admin');
  await Promise.all([
    uc.updateOne({ _id: String(userId) }, { $inc: { today_count: 1, query_count: 1 } }),
    ac.updateOne({ _id: 'singleton' },    { $inc: { api_usage: 1 } })
  ]);
}

/**
 * Set a specific field on a user document.
 */
async function setUserField(userId, field, value) {
  const c = await col('users');
  await c.updateOne({ _id: String(userId) }, { $set: { [field]: value } }, { upsert: true });
}

/**
 * Ban or unban a user.
 */
async function setBanned(userId, banned) {
  await setUserField(String(userId), 'is_banned', banned);
}

/**
 * Get all users as an array.
 */
async function getAllUsers() {
  const c = await col('users');
  return c.find({}).toArray();
}

/**
 * Get all non-banned user IDs.
 */
async function getActiveUserIds() {
  const c = await col('users');
  const users = await c.find({ is_banned: { $ne: true } }, { projection: { _id: 1 } }).toArray();
  return users.map(u => u._id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get admin singleton document.
 */
async function getAdmin() {
  const c = await col('admin');
  return c.findOne({ _id: 'singleton' });
}

/**
 * Get the admin PIN.
 */
async function getAdminPin() {
  const a = await getAdmin();
  return a?.pin || process.env.ADMIN_PIN || 'PECULIAR123';
}

/**
 * Check if a PIN matches the stored admin PIN.
 */
async function checkAdminPin(pin) {
  if (!pin) return false;
  const stored = await getAdminPin();
  return pin === stored;
}

/**
 * Update admin singleton fields.
 */
async function updateAdmin(fields) {
  const c = await col('admin');
  await c.updateOne({ _id: 'singleton' }, { $set: fields }, { upsert: true });
}

/**
 * Increment total_broadcasts counter.
 */
async function incBroadcasts() {
  const c = await col('admin');
  await c.updateOne({ _id: 'singleton' }, { $inc: { total_broadcasts: 1 } });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERSATION HISTORY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get last N message pairs for a user.
 */
async function getHistory(userId) {
  const c    = await col('conversations');
  const doc  = await c.findOne({ _id: String(userId) });
  return doc?.messages || [];
}

/**
 * Append a message to history, keeping last 10 entries (5 pairs).
 */
async function addToHistory(userId, role, content) {
  const c   = await col('conversations');
  const uid = String(userId);

  // Push new message, then slice to last 10 using a two-step approach
  await c.updateOne(
    { _id: uid },
    {
      $push: {
        messages: {
          $each: [{ role, content: String(content).substring(0, 3000) }],
          $slice: -10
        }
      }
    },
    { upsert: true }
  );
}

/**
 * Clear all conversation history for a user.
 */
async function clearHistory(userId) {
  const c = await col('conversations');
  await c.updateOne({ _id: String(userId) }, { $set: { messages: [] } }, { upsert: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// API LOGS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Append an API call log entry.
 */
async function logApiCall(userId, type, tokens = 0) {
  const c = await col('api_logs');
  await c.insertOne({ userId: String(userId), type, tokens, timestamp: new Date() });
}

/**
 * Get recent API logs with optional filters.
 * @param {object} filter - { userId?, sinceDate?, limit? }
 */
async function getApiLogs({ userId, sinceDate, limit = 5000 } = {}) {
  const c     = await col('api_logs');
  const query = {};
  if (userId)    query.userId    = String(userId);
  if (sinceDate) query.timestamp = { $gte: sinceDate };
  return c.find(query).sort({ timestamp: -1 }).limit(limit).toArray();
}

/**
 * Count API logs for analytics.
 */
async function countApiLogs({ userId, sinceDate, type } = {}) {
  const c     = await col('api_logs');
  const query = {};
  if (userId)    query.userId    = String(userId);
  if (sinceDate) query.timestamp = { $gte: sinceDate };
  if (type)      query.type      = type;
  return c.countDocuments(query);
}

/**
 * Get top command types by count.
 */
async function getTopCommands({ sinceDate, limit = 5 } = {}) {
  const c       = await col('api_logs');
  const match   = sinceDate ? { $match: { timestamp: { $gte: sinceDate } } } : { $match: {} };
  const results = await c.aggregate([
    match,
    { $group: { _id: '$type', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit }
  ]).toArray();
  return results; // [{ _id: 'chat', count: 42 }, ...]
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR LOGS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Append an error log entry.
 */
async function logError(context, error) {
  try {
    const c = await col('error_logs');
    await c.insertOne({
      context,
      message:   error?.message || String(error),
      timestamp: new Date()
    });
  } catch (_) {
    // Never throw from logError itself
    console.error('[DB] logError failed:', context, error?.message);
  }
}

/**
 * Get last N error logs.
 */
async function getErrorLogs(limit = 10) {
  const c = await col('error_logs');
  return c.find({}).sort({ timestamp: -1 }).limit(limit).toArray();
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOT SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the bot_settings singleton document.
 * Always returns a valid object (merges defaults).
 */
async function getBotSettings() {
  const c   = await col('bot_settings');
  const doc = await c.findOne({ _id: 'singleton' });
  return { ...DEFAULT_BOT_SETTINGS, ...(doc || {}) };
}

/**
 * Update one or more bot_settings fields.
 */
async function setBotSetting(field, value) {
  const c = await col('bot_settings');
  await c.updateOne(
    { _id: 'singleton' },
    { $set: { [field]: value } },
    { upsert: true }
  );
}

/**
 * Update multiple bot_settings fields at once.
 */
async function setBotSettings(fields) {
  const c = await col('bot_settings');
  await c.updateOne(
    { _id: 'singleton' },
    { $set: fields },
    { upsert: true }
  );
}

/**
 * Get the dynamic main menu buttons.
 */
async function getMenuButtons() {
  const s = await getBotSettings();
  return s.menu_buttons || DEFAULT_BOT_SETTINGS.menu_buttons;
}

/**
 * Add a new button row to menu_buttons.
 */
async function addMenuButton(buttonRow) {
  const c = await col('bot_settings');
  await c.updateOne(
    { _id: 'singleton' },
    { $push: { menu_buttons: buttonRow } },
    { upsert: true }
  );
}

/**
 * Remove all button rows where any button text matches label.
 */
async function removeMenuButton(label) {
  const current = await getMenuButtons();
  const filtered = current.filter(row => !row.some(btn => btn.text === label));
  await setBotSetting('menu_buttons', filtered);
  return filtered.length < current.length; // true if something was removed
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOM COMMANDS (Dynamic Command Injector)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get all custom commands as a plain object { name: { prompt, created } }.
 */
async function getCustomCommands() {
  const c    = await col('custom_commands');
  const docs = await c.find({}).toArray();
  const out  = {};
  docs.forEach(d => { out[d._id] = { prompt: d.prompt, created: d.created }; });
  return out;
}

/**
 * Save/update a custom command.
 */
async function setCustomCommand(name, prompt) {
  const c = await col('custom_commands');
  await c.updateOne(
    { _id: name },
    { $set: { prompt, created: new Date().toISOString() } },
    { upsert: true }
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODERATION FLAGS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log a moderation flag. Creates or updates the user's flag entry.
 * Returns the new total warn_count for the user.
 */
async function logFlag(userId, username, message, severity, matched = []) {
  const uid     = String(userId);
  const c       = await col('flags');
  const incident = {
    message:   message.substring(0, 300),
    timestamp: new Date().toISOString(),
    severity,
    matched
  };

  await c.updateOne(
    { _id: uid },
    {
      $setOnInsert: {
        _id:          uid,
        username:     username || uid,
        firstFlagged: new Date().toISOString(),
        status:       'pending'
      },
      $push:  { incidents: incident },
      $set:   { lastSeen: new Date().toISOString(), username: username || uid },
      $inc:   { totalFlags: 1 }
    },
    { upsert: true }
  );

  // Increment user warn_count
  const uc = await col('users');
  const result = await uc.findOneAndUpdate(
    { _id: uid },
    { $inc: { warn_count: 1 } },
    { returnDocument: 'after', upsert: true }
  );

  return result?.warn_count || 1;
}

/**
 * Get all flags, optionally filtered by status.
 */
async function getFlags({ status } = {}) {
  const c     = await col('flags');
  const query = status ? { status } : {};
  return c.find(query).sort({ lastSeen: -1 }).toArray();
}

/**
 * Count flags by status.
 */
async function countFlags(status) {
  const c = await col('flags');
  return c.countDocuments(status ? { status } : {});
}

/**
 * Update flag status for a userId.
 */
async function setFlagStatus(userId, status) {
  const c = await col('flags');
  await c.updateOne({ _id: String(userId) }, { $set: { status } });
}

/**
 * Auto-ban user and update flag status.
 */
async function autoBanUser(userId) {
  await setBanned(String(userId), true);
  await setFlagStatus(String(userId), 'auto_banned');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Connection
  connect,
  getDB,

  // Users
  getUser,
  ensureUser,
  getDisplayName,
  isBanned,
  checkLimit,
  incrementUsage,
  setUserField,
  setBanned,
  getAllUsers,
  getActiveUserIds,

  // Admin
  getAdmin,
  getAdminPin,
  checkAdminPin,
  updateAdmin,
  incBroadcasts,

  // Conversations
  getHistory,
  addToHistory,
  clearHistory,

  // API Logs
  logApiCall,
  getApiLogs,
  countApiLogs,
  getTopCommands,

  // Error Logs
  logError,
  getErrorLogs,

  // Bot Settings
  getBotSettings,
  setBotSetting,
  setBotSettings,
  getMenuButtons,
  addMenuButton,
  removeMenuButton,

  // Custom Commands
  getCustomCommands,
  setCustomCommand,

  // Moderation Flags
  logFlag,
  getFlags,
  countFlags,
  setFlagStatus,
  autoBanUser
};
    
