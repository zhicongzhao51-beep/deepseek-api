'use strict';

const fs = require('fs');
const path = require('path');

// Use a temp DB file for tests
const TEST_DB = path.join(__dirname, '..', 'test-data.db');
process.env.DB_PATH = TEST_DB;

// Clean up
function cleanup() {
  try { fs.unlinkSync(TEST_DB); } catch (_) {}
  try { fs.unlinkSync(TEST_DB + '-wal'); } catch (_) {}
  try { fs.unlinkSync(TEST_DB + '-shm'); } catch (_) {}
}
cleanup();

// Mock logger
jest.mock('../logger', () => ({
  info: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
}));

const db = require('../db');

// Helpers for unique test data
const uniq = (prefix) => prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

describe('db.js', () => {
  beforeAll(async () => {
    await db.init();
  });

  afterAll(() => {
    cleanup();
  });

  // ── User Operations ──

  describe('createUser', () => {
    it('creates a user with balance 100 and api_key', () => {
      const result = db.createUser(uniq('alice'), 'password123');
      expect(result.error).toBeUndefined();
      expect(result.username).toMatch(/^alice_/);
      expect(result.api_key).toMatch(/^dsk-/);
      expect(result.balance).toBe(100);
    });

    it('rejects duplicate username', () => {
      const name = uniq('bob');
      db.createUser(name, 'pass1');
      const result = db.createUser(name, 'pass2');
      expect(result.error).toBe('用户名已存在');
    });
  });

  describe('authenticateUser', () => {
    it('returns user on correct password', () => {
      const name = uniq('charlie');
      db.createUser(name, 'secret123');
      const user = db.authenticateUser(name, 'secret123');
      expect(user).not.toBeNull();
      expect(user.username).toBe(name);
      expect(user.api_key).toMatch(/^dsk-/);
      expect(user.balance).toBe(100);
    });

    it('returns null on wrong password', () => {
      const name = uniq('dave');
      db.createUser(name, 'correct');
      const user = db.authenticateUser(name, 'wrong');
      expect(user).toBeNull();
    });

    it('returns null for non-existent user', () => {
      const user = db.authenticateUser(uniq('nobody'), 'pass');
      expect(user).toBeNull();
    });
  });

  describe('getUserByApiKey', () => {
    it('returns user for valid key', () => {
      const created = db.createUser(uniq('eve'), 'pass');
      const user = db.getUserByApiKey(created.api_key);
      expect(user).not.toBeNull();
      expect(user.username).toBe(created.username);
    });

    it('returns null for invalid key', () => {
      const user = db.getUserByApiKey('dsk-nonexistent');
      expect(user).toBeNull();
    });
  });

  describe('getUserByUsername', () => {
    it('finds existing user', () => {
      const name = uniq('frank');
      db.createUser(name, 'pass');
      const user = db.getUserByUsername(name);
      expect(user).not.toBeNull();
      expect(user.username).toBe(name);
    });

    it('returns null for non-existent', () => {
      const user = db.getUserByUsername(uniq('nobody'));
      expect(user).toBeNull();
    });
  });

  // ── Balance Operations ──

  describe('addBalance', () => {
    it('adds points to user balance', () => {
      const created = db.createUser(uniq('grace'), 'pass');
      const user = db.getUserByApiKey(created.api_key);
      db.addBalance(user.id, 500);
      const updated = db.getUserByApiKey(created.api_key);
      expect(updated.balance).toBe(600);
    });
  });

  describe('deductBalance', () => {
    it('deducts points and returns true when sufficient', () => {
      const created = db.createUser(uniq('henry'), 'pass');
      const user = db.getUserByApiKey(created.api_key);
      const result = db.deductBalance(user.id, 30);
      expect(result).toBe(true);
      const updated = db.getUserByApiKey(created.api_key);
      expect(updated.balance).toBe(70);
    });

    it('returns false when insufficient balance', () => {
      const created = db.createUser(uniq('iris'), 'pass');
      const user = db.getUserByApiKey(created.api_key);
      const result = db.deductBalance(user.id, 200);
      expect(result).toBe(false);
      const updated = db.getUserByApiKey(created.api_key);
      expect(updated.balance).toBe(100);
    });

    it('returns false for non-existent user', () => {
      const result = db.deductBalance(99999, 10);
      expect(result).toBe(false);
    });
  });

  // ── Usage Logging ──

  describe('logUsage and getUsageStats', () => {
    it('logs usage and retrieves stats', () => {
      const created = db.createUser(uniq('jack'), 'pass');
      const user = db.getUserByApiKey(created.api_key);
      db.logUsage(user.id, 'writer', 100, 200, 3);
      db.logUsage(user.id, 'translator', 50, 100, 1);

      const stats = db.getUsageStats(user.id);
      expect(stats.length).toBeGreaterThanOrEqual(2);
    });

    it('returns empty array for user with no usage', () => {
      const created = db.createUser(uniq('kate'), 'pass');
      const user = db.getUserByApiKey(created.api_key);
      const stats = db.getUsageStats(user.id);
      expect(stats).toEqual([]);
    });

    it('getUsageStats without userId returns array', () => {
      const stats = db.getUsageStats();
      expect(Array.isArray(stats)).toBe(true);
    });
  });

  describe('getAllUsers', () => {
    it('returns all users', () => {
      db.createUser(uniq('leo'), 'pass1');
      db.createUser(uniq('mia'), 'pass2');
      const users = db.getAllUsers();
      expect(users.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Payment Orders ──

  describe('Payment Orders', () => {
    const pkg = { id: 'basic', label: '基础包', amount: 10, points: 1000, bonus: 0 };

    function createTestUser() {
      const created = db.createUser(uniq('payuser'), 'pass');
      return db.getUserByApiKey(created.api_key);
    }

    it('creates a payment order', () => {
      const user = createTestUser();
      const orderNo = uniq('ORD');
      const order = db.createPaymentOrder(user.id, pkg, orderNo);
      expect(order.orderNo).toBe(orderNo);
      expect(order.id).toBeGreaterThan(0);
    });

    it('gets a payment order by order_no', () => {
      const user = createTestUser();
      const orderNo = uniq('ORD');
      db.createPaymentOrder(user.id, pkg, orderNo);
      const order = db.getPaymentOrder(orderNo);
      expect(order).not.toBeNull();
      expect(order.status).toBe('pending');
    });

    it('returns null for non-existent order', () => {
      const order = db.getPaymentOrder(uniq('ORD-NOPE'));
      expect(order).toBeNull();
    });

    it('completes payment successfully', () => {
      const user = createTestUser();
      const orderNo = uniq('ORD');
      db.createPaymentOrder(user.id, pkg, orderNo);
      const completed = db.completePaymentOrder(orderNo, 'charge_abc');
      expect(completed).toBe(true);
      const order = db.getPaymentOrder(orderNo);
      expect(order.status).toBe('paid');
      expect(order.provider_charge_id).toBe('charge_abc');
      expect(order.paid_at).not.toBeNull();
    });

    it('idempotent: does not double-complete paid orders', () => {
      const user = createTestUser();
      const orderNo = uniq('ORD');
      db.createPaymentOrder(user.id, pkg, orderNo);
      db.completePaymentOrder(orderNo, 'charge_1');
      const second = db.completePaymentOrder(orderNo, 'charge_2');
      expect(second).toBe(false);
    });

    it('fails a payment order', () => {
      const user = createTestUser();
      const orderNo = uniq('ORD');
      db.createPaymentOrder(user.id, pkg, orderNo);
      db.failPaymentOrder(orderNo);
      const order = db.getPaymentOrder(orderNo);
      expect(order.status).toBe('failed');
    });

    it('gets user payment orders sorted by newest first', () => {
      const user = createTestUser();
      db.createPaymentOrder(user.id, pkg, uniq('ORD-A'));
      db.createPaymentOrder(user.id, pkg, uniq('ORD-B'));
      const orders = db.getUserPaymentOrders(user.id, 10, 0);
      expect(orders.length).toBeGreaterThanOrEqual(2);
    });

    it('respects limit and offset', () => {
      const user = createTestUser();
      db.createPaymentOrder(user.id, pkg, uniq('ORD-C'));
      db.createPaymentOrder(user.id, pkg, uniq('ORD-D'));
      db.createPaymentOrder(user.id, pkg, uniq('ORD-E'));
      const orders = db.getUserPaymentOrders(user.id, 2, 1);
      expect(orders.length).toBe(2);
    });
  });
});
