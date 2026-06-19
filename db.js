const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

let db = null;
let initPromise = null;

// --- Database lifecycle ---

function getDb() {
  if (!db) throw new Error('Database not initialized. Call init() first.');
  return db;
}

function saveToDisk() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

async function init() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const SQL = await initSqlJs();

    // Load existing database or create new one
    if (fs.existsSync(DB_PATH)) {
      const fileBuffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(fileBuffer);
    } else {
      db = new SQL.Database();
    }

    // Enable WAL mode for crash safety and better concurrency
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA synchronous=NORMAL');
    db.run('PRAGMA foreign_keys=ON');

    // Create tables
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        api_key TEXT UNIQUE NOT NULL,
        balance INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        endpoint TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        points_cost INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS payment_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        order_no TEXT UNIQUE NOT NULL,
        package_id TEXT NOT NULL,
        amount REAL NOT NULL,
        points INTEGER NOT NULL,
        bonus_points INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL DEFAULT 'xorpay',
        provider_charge_id TEXT,
        transaction_id TEXT,
        proof_note TEXT DEFAULT '',
        approve_token TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        paid_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Migrations: add columns that may not exist in older DBs
    const addColumn = (table, colDef) => {
      try { db.run(`ALTER TABLE ${table} ADD COLUMN ${colDef}`); } catch (_) { /* already exists */ }
    };
    addColumn('payment_orders', 'transaction_id TEXT');
    addColumn('payment_orders', 'proof_note TEXT DEFAULT \'\'');

    // Robust approve_token migration: check via SELECT before ALTER
    try {
      db.exec('SELECT approve_token FROM payment_orders LIMIT 1');
    } catch (_) {
      db.run('ALTER TABLE payment_orders ADD COLUMN approve_token TEXT');
      logger.info('Migration: added approve_token column to payment_orders');
    }

    // Verify the column exists
    try {
      db.exec('SELECT approve_token FROM payment_orders LIMIT 1');
      logger.info('approve_token column verified');
    } catch (_) {
      logger.error('approve_token column STILL MISSING after migration!');
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS invite_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'admin',
        max_uses INTEGER NOT NULL DEFAULT 1,
        used_count INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    saveToDisk();
    logger.info('Database initialized successfully');
  })();

  return initPromise;
}

// --- User operations ---

function createUser(username, password) {
  const d = getDb();
  const existing = d.exec('SELECT id FROM users WHERE username = ?', [username]);
  if (existing.length > 0 && existing[0].values.length > 0) {
    return { error: '用户名已存在' };
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const apiKey = 'dsk-' + uuidv4().replace(/-/g, '');

  d.run(
    'INSERT INTO users (username, password_hash, api_key, balance) VALUES (?, ?, ?, ?)',
    [username, passwordHash, apiKey, 100]
  );
  saveToDisk();

  return { username, api_key: apiKey, balance: 100 };
}

function authenticateUser(username, password) {
  const d = getDb();
  const result = d.exec('SELECT id, username, password_hash, api_key, balance FROM users WHERE username = ?', [username]);
  if (result.length === 0 || result[0].values.length === 0) return null;

  const user = result[0].values[0];
  const hash = user[2];
  if (!bcrypt.compareSync(password, hash)) return null;

  return {
    id: user[0],
    username: user[1],
    api_key: user[3],
    balance: user[4],
  };
}

function getUserByApiKey(apiKey) {
  const d = getDb();
  const result = d.exec('SELECT id, username, api_key, balance FROM users WHERE api_key = ?', [apiKey]);
  if (result.length === 0 || result[0].values.length === 0) return null;

  const u = result[0].values[0];
  return { id: u[0], username: u[1], api_key: u[2], balance: u[3] };
}

function getUserByUsername(username) {
  const d = getDb();
  const result = d.exec('SELECT id, username, api_key, balance FROM users WHERE username = ?', [username]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  const u = result[0].values[0];
  return { id: u[0], username: u[1], api_key: u[2], balance: u[3] };
}

function deductBalance(userId, points) {
  const d = getDb();
  const result = d.exec('SELECT balance FROM users WHERE id = ?', [userId]);
  if (result.length === 0 || result[0].values.length === 0) return false;

  const balance = result[0].values[0][0];
  if (balance < points) return false;

  d.run('UPDATE users SET balance = balance - ? WHERE id = ?', [points, userId]);
  saveToDisk();
  return true;
}

function addBalance(userId, points) {
  const d = getDb();
  d.run('UPDATE users SET balance = balance + ? WHERE id = ?', [points, userId]);
  saveToDisk();
}

function logUsage(userId, endpoint, promptTokens, completionTokens, pointsCost) {
  const d = getDb();
  d.run(
    'INSERT INTO usage_logs (user_id, endpoint, prompt_tokens, completion_tokens, points_cost) VALUES (?, ?, ?, ?, ?)',
    [userId, endpoint, promptTokens, completionTokens, pointsCost]
  );
  saveToDisk();
}

function getUsageStats(userId = null) {
  const d = getDb();
  let sql, params;
  if (userId) {
    sql = `SELECT endpoint, COUNT(*) as calls, SUM(prompt_tokens) as total_prompt, SUM(completion_tokens) as total_completion, SUM(points_cost) as total_cost FROM usage_logs WHERE user_id = ? GROUP BY endpoint`;
    params = [userId];
  } else {
    sql = `SELECT u.username, l.endpoint, COUNT(*) as calls, SUM(l.prompt_tokens) as total_prompt, SUM(l.completion_tokens) as total_completion, SUM(l.points_cost) as total_cost FROM usage_logs l JOIN users u ON l.user_id = u.id GROUP BY l.user_id, l.endpoint`;
    params = [];
  }
  const result = d.exec(sql, params);
  if (result.length === 0) return [];
  const columns = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => (obj[col] = row[i]));
    return obj;
  });
}

function getAllUsers() {
  const d = getDb();
  const result = d.exec('SELECT id, username, api_key, balance, created_at FROM users ORDER BY id DESC');
  if (result.length === 0) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((col, i) => (obj[col] = row[i]));
    return obj;
  });
}

// --- Payment operations ---

function createPaymentOrder(userId, packageInfo, orderNo, provider = 'xorpay') {
  const d = getDb();
  const approveToken = crypto.randomBytes(16).toString('hex');
  d.run(
    `INSERT INTO payment_orders (user_id, order_no, package_id, amount, points, bonus_points, provider, approve_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, orderNo, packageInfo.id, packageInfo.amount, packageInfo.points, packageInfo.bonus || 0, provider, approveToken]
  );
  saveToDisk();
  const result = d.exec('SELECT id FROM payment_orders WHERE order_no = ?', [orderNo]);
  const id = result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : 0;
  return { id, orderNo, approveToken };
}

function getPaymentOrder(orderNo) {
  const d = getDb();
  const result = d.exec(
    'SELECT id, user_id, order_no, package_id, amount, points, bonus_points, provider, provider_charge_id, transaction_id, proof_note, approve_token, status, paid_at, created_at FROM payment_orders WHERE order_no = ?',
    [orderNo]
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  const cols = result[0].columns;
  const row = result[0].values[0];
  const obj = {};
  cols.forEach((col, i) => (obj[col] = row[i]));
  return obj;
}

// Quick approve by token (used in WeChat one-click approval links)
function getPaymentOrderByApproveToken(token) {
  const d = getDb();
  const result = d.exec(
    'SELECT id, user_id, order_no, package_id, amount, points, bonus_points, provider, transaction_id, proof_note, status, paid_at, created_at FROM payment_orders WHERE approve_token = ?',
    [token]
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  const cols = result[0].columns;
  const row = result[0].values[0];
  const obj = {};
  cols.forEach((col, i) => (obj[col] = row[i]));
  return obj;
}

// Quick approve: approve order by token, return the order info
function quickApproveOrder(token) {
  const order = getPaymentOrderByApproveToken(token);
  if (!order) return null;
  if (order.status === 'paid') return { ...order, alreadyApproved: true };
  if (order.status !== 'submitted') return null;

  const d = getDb();
  const paidAt = new Date().toISOString().replace('T', ' ').split('.')[0];
  d.run(
    'UPDATE payment_orders SET status = ?, paid_at = ? WHERE approve_token = ?',
    ['paid', paidAt, token]
  );

  // Credit user balance
  d.run(
    'UPDATE users SET balance = balance + ? WHERE id = ?',
    [order.points + (order.bonus_points || 0), order.user_id]
  );

  // Get username
  const userResult = d.exec('SELECT username FROM users WHERE id = ?', [order.user_id]);
  const username = (userResult.length > 0 && userResult[0].values.length > 0) ? userResult[0].values[0][0] : 'unknown';

  saveToDisk();
  return { ...order, username, alreadyApproved: false };
}

function completePaymentOrder(orderNo, providerChargeId) {
  const d = getDb();
  const before = d.exec('SELECT status FROM payment_orders WHERE order_no = ?', [orderNo]);
  if (before.length === 0 || before[0].values.length === 0) return false;
  const currentStatus = before[0].values[0][0];
  if (currentStatus !== 'pending') return false;

  d.run(
    `UPDATE payment_orders SET status = 'paid', provider_charge_id = ?, paid_at = datetime('now')
     WHERE order_no = ?`,
    [providerChargeId, orderNo]
  );
  saveToDisk();
  return true;
}

function submitPaymentProof(orderNo, transactionId, proofNote) {
  const d = getDb();
  const before = d.exec('SELECT status FROM payment_orders WHERE order_no = ?', [orderNo]);
  if (before.length === 0 || before[0].values.length === 0) return false;
  const currentStatus = before[0].values[0][0];
  if (currentStatus !== 'pending') return false;

  d.run(
    `UPDATE payment_orders SET transaction_id = ?, proof_note = ?, status = 'submitted'
     WHERE order_no = ?`,
    [transactionId, proofNote, orderNo]
  );
  saveToDisk();
  return true;
}

function adminApproveOrder(orderNo) {
  const d = getDb();
  const before = d.exec('SELECT status, user_id, points, bonus_points FROM payment_orders WHERE order_no = ?', [orderNo]);
  if (before.length === 0 || before[0].values.length === 0) return null;
  const [status, userId, points, bonusPoints] = before[0].values[0];
  if (status !== 'submitted') return null;

  d.run(
    `UPDATE payment_orders SET status = 'paid', paid_at = datetime('now') WHERE order_no = ?`,
    [orderNo]
  );
  // Add points to user
  d.run('UPDATE users SET balance = balance + ? WHERE id = ?', [points + (bonusPoints || 0), userId]);
  saveToDisk();
  return { userId, points: points + (bonusPoints || 0) };
}

function adminRejectOrder(orderNo) {
  const d = getDb();
  d.run(
    `UPDATE payment_orders SET status = 'pending' WHERE order_no = ? AND status = 'submitted'`,
    [orderNo]
  );
  saveToDisk();
  return true;
}

function getPendingProofOrders(limit = 50) {
  const d = getDb();
  const result = d.exec(
    `SELECT po.id, po.user_id, po.order_no, po.package_id, po.amount, po.points, po.bonus_points, po.provider, po.transaction_id, po.proof_note, po.approve_token, po.status, po.created_at,
            u.username
     FROM payment_orders po JOIN users u ON po.user_id = u.id
     WHERE po.status = 'submitted'
     ORDER BY po.id ASC LIMIT ?`,
    [limit]
  );
  if (result.length === 0) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((col, i) => (obj[col] = row[i]));
    return obj;
  });
}

function failPaymentOrder(orderNo) {
  const d = getDb();
  d.run(
    `UPDATE payment_orders SET status = 'failed' WHERE order_no = ? AND status = 'pending'`,
    [orderNo]
  );
  saveToDisk();
}

function getUserPaymentOrders(userId, limit = 20, offset = 0) {
  const d = getDb();
  const result = d.exec(
    'SELECT order_no, package_id, amount, points, bonus_points, provider, transaction_id, proof_note, status, paid_at, created_at FROM payment_orders WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
    [userId, limit, offset]
  );
  if (result.length === 0) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((col, i) => (obj[col] = row[i]));
    return obj;
  });
}

// --- Invite Code operations ---

function generateInviteCode(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // avoid confusable chars
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function createInviteCode(maxUses = 1, note = '', createdBy = 'admin') {
  const d = getDb();
  const code = generateInviteCode();
  d.run(
    'INSERT INTO invite_codes (code, created_by, max_uses, note) VALUES (?, ?, ?, ?)',
    [code, createdBy, maxUses, note]
  );
  saveToDisk();
  return { code, max_uses: maxUses, note };
}

function validateInviteCode(code) {
  const d = getDb();
  const result = d.exec(
    'SELECT id, code, max_uses, used_count, is_active FROM invite_codes WHERE code = ?',
    [code]
  );
  if (result.length === 0 || result[0].values.length === 0) return null;

  const row = result[0].values[0];
  const invite = { id: row[0], code: row[1], max_uses: row[2], used_count: row[3], is_active: row[4] };

  if (!invite.is_active) return { error: '邀请码已失效' };
  if (invite.used_count >= invite.max_uses) return { error: '邀请码已被用完' };

  return { valid: true, invite };
}

function consumeInviteCode(code) {
  const d = getDb();
  d.run('UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ?', [code]);
  saveToDisk();
}

function listInviteCodes() {
  const d = getDb();
  const result = d.exec(
    'SELECT id, code, created_by, max_uses, used_count, is_active, note, created_at FROM invite_codes ORDER BY id DESC'
  );
  if (result.length === 0) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((col, i) => (obj[col] = row[i]));
    return obj;
  });
}

function disableInviteCode(code) {
  const d = getDb();
  d.run('UPDATE invite_codes SET is_active = 0 WHERE code = ?', [code]);
  saveToDisk();
  return true;
}

// Payment statistics for admin dashboard
function getPaymentStats() {
  const d = getDb();
  const result = d.exec(
    `SELECT status, COUNT(*) as count, COALESCE(SUM(amount), 0) as total_amount,
            COALESCE(SUM(points), 0) as total_points, COALESCE(SUM(bonus_points), 0) as total_bonus
     FROM payment_orders GROUP BY status`
  );
  if (result.length === 0) return { orders: {}, total_revenue: 0, total_pending: 0, total_points_sold: 0 };

  const stats = { orders: {}, total_revenue: 0, total_pending: 0, total_points_sold: 0 };
  const cols = result[0].columns;
  result[0].values.forEach(row => {
    const obj = {};
    cols.forEach((col, i) => (obj[col] = row[i]));
    stats.orders[obj.status] = obj;
    if (obj.status === 'paid') {
      stats.total_revenue += obj.total_amount || 0;
      stats.total_points_sold += obj.total_points || 0;
    }
    if (obj.status === 'pending' || obj.status === 'submitted') {
      stats.total_pending += obj.total_amount || 0;
    }
  });
  return stats;
}

// Endpoint usage breakdown for admin dashboard
function getEndpointBreakdown() {
  const d = getDb();
  const result = d.exec(
    `SELECT endpoint, COUNT(*) as calls, COALESCE(SUM(points_cost), 0) as total_points,
            COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as total_completion_tokens
     FROM usage_logs GROUP BY endpoint ORDER BY calls DESC`
  );
  if (result.length === 0) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((col, i) => (obj[col] = row[i]));
    return obj;
  });
}

module.exports = {
  init,
  createUser,
  authenticateUser,
  getUserByApiKey,
  getUserByUsername,
  deductBalance,
  addBalance,
  logUsage,
  getUsageStats,
  getAllUsers,
  createPaymentOrder,
  getPaymentOrder,
  completePaymentOrder,
  submitPaymentProof,
  adminApproveOrder,
  adminRejectOrder,
  getPendingProofOrders,
  failPaymentOrder,
  getUserPaymentOrders,
  createInviteCode,
  validateInviteCode,
  consumeInviteCode,
  listInviteCodes,
  disableInviteCode,
  generateInviteCode,
  getPaymentStats,
  getEndpointBreakdown,
  getPaymentOrderByApproveToken,
  quickApproveOrder,
};
