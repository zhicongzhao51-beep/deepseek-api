const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data.db');

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

    // Enable WAL-like persistence via manual save
    db.run('PRAGMA journal_mode=OFF');
    db.run('PRAGMA synchronous=OFF');

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

    saveToDisk();
    console.log('[DB] Initialized successfully');
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
};
