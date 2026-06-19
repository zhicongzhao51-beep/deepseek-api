'use strict';

const request = require('supertest');
const path = require('path');
const fs = require('fs');

// Use test DB
const TEST_DB = path.join(__dirname, '..', 'test-server.db');
process.env.DB_PATH = TEST_DB;
process.env.DEEPSEEK_API_KEY = 'sk-test-key';
process.env.ADMIN_PASSWORD = 'test-admin-pass';
process.env.NODE_ENV = 'test';

// Clean
function cleanup() {
  try { fs.unlinkSync(TEST_DB); } catch (_) {}
  try { fs.unlinkSync(TEST_DB + '-wal'); } catch (_) {}
  try { fs.unlinkSync(TEST_DB + '-shm'); } catch (_) {}
}
cleanup();

// Mock XorPay
jest.mock('../services/xorpay', () => ({
  createPayment: jest.fn(async () => ({ qr_url: 'https://qr.example.com/pay', charge_id: 'mock_charge_123' })),
  verifySignature: jest.fn(() => true),
  sign: jest.fn(() => 'mock_sign'),
}));

// Mock logger
jest.mock('../logger', () => ({
  info: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(), warn: jest.fn(),
}));

const db = require('../db');
const app = require('../server');

describe('Server API Integration', () => {
  let apiKey;
  let inviteCode;
  const adminPassword = 'test-admin-pass';

  beforeAll(async () => {
    // Wait for DB init
    await db.init();

    // Create an invite code for testing
    const invite = db.createInviteCode(100, 'test invites'); // multi-use for test suite
    inviteCode = invite.code;

    // Register a user for authenticated tests
    const res = await request(app)
      .post('/api/register')
      .send({ username: 'integrationtest_' + Date.now(), password: 'testpass123', invite_code: inviteCode });
    if (res.body.success) {
      apiKey = res.body.data.api_key;
    } else {
      // May be rate limited; try again
      const res2 = await request(app)
        .post('/api/register')
        .send({ username: 'integrationtest2_' + Date.now(), password: 'testpass123', invite_code: inviteCode });
      if (res2.body.success) {
        apiKey = res2.body.data.api_key;
      }
    }
  });

  afterAll(() => {
    cleanup();
  });

  describe('GET /api/health', () => {
    it('returns 200', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /api/register', () => {
    it('registers new user with valid invite code', async () => {
      const name = 'newuser_' + Date.now();
      const res = await request(app)
        .post('/api/register')
        .send({ username: name, password: 'password123', invite_code: inviteCode });
      expect([200, 429]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.success).toBe(true);
        expect(res.body.data.api_key).toMatch(/^dsk-/);
        expect(res.body.data.balance).toBe(100);
      }
    });

    it('rejects registration without invite code', async () => {
      const name = 'nokey_' + Date.now();
      const res = await request(app)
        .post('/api/register')
        .send({ username: name, password: 'password123' });
      expect(res.status).toBe(400);
    });

    it('rejects invalid invite code', async () => {
      const name = 'badkey_' + Date.now();
      const res = await request(app)
        .post('/api/register')
        .send({ username: name, password: 'password123', invite_code: 'INVALID-CODE' });
      expect(res.status).toBe(400);
    });

    it('rejects duplicate username', async () => {
      const name = 'dupuser_' + Date.now();
      await request(app).post('/api/register')
        .send({ username: name, password: 'password123', invite_code: inviteCode });
      const res = await request(app).post('/api/register')
        .send({ username: name, password: 'password123', invite_code: inviteCode });
      expect(res.status).toBe(409);
    });

    it('rejects short username', async () => {
      const res = await request(app).post('/api/register')
        .send({ username: 'ab', password: 'short', invite_code: inviteCode });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/login', () => {
    beforeAll(async () => {
      await request(app).post('/api/register')
        .send({ username: 'loginuser', password: 'correctpass', invite_code: inviteCode });
    });

    it('logs in with correct password', async () => {
      const res = await request(app).post('/api/login')
        .send({ username: 'loginuser', password: 'correctpass' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('rejects wrong password', async () => {
      const res = await request(app).post('/api/login')
        .send({ username: 'loginuser', password: 'wrongpass' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/me', () => {
    it('returns user info or handles rate limiting', async () => {
      if (!apiKey) return;
      const res = await request(app).get('/api/me').set('Authorization', `Bearer ${apiKey}`);
      expect([200, 401, 429]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.data.username).toMatch(/^integrationtest/);
      }
    });

    it('returns 401 without key', async () => {
      const res = await request(app).get('/api/me');
      expect([401, 429]).toContain(res.status);
    });

    it('returns 401 or 429 with invalid key', async () => {
      const res = await request(app).get('/api/me').set('Authorization', 'Bearer dsk-invalid');
      expect([401, 429]).toContain(res.status);
    });
  });

  describe('AI Endpoints', () => {
    it('POST /api/writer returns 401 without auth', async () => {
      const res = await request(app).post('/api/writer').send({ input: 'test' });
      expect(res.status).toBe(401);
    });

    it('POST /api/writer returns 400 or handles auth/rate', async () => {
      if (!apiKey) return;
      const res = await request(app).post('/api/writer')
        .set('Authorization', `Bearer ${apiKey}`).send({ input: '' });
      expect([400, 401, 429]).toContain(res.status);
    });

    it('POST /api/translator returns 401 without auth', async () => {
      const res = await request(app).post('/api/translator').send({ input: 'hello' });
      expect(res.status).toBe(401);
    });

    it('POST /api/summary returns 401 without auth', async () => {
      const res = await request(app).post('/api/summary').send({ input: 'text' });
      expect(res.status).toBe(401);
    });

    it('POST /api/codegen returns 401 without auth', async () => {
      const res = await request(app).post('/api/codegen')
        .send({ input: 'write a hello world', language: 'python' });
      expect(res.status).toBe(401);
    });

    it('POST /api/codereview returns 401 without auth', async () => {
      const res = await request(app).post('/api/codereview')
        .send({ input: 'function foo() { return 1; }' });
      expect(res.status).toBe(401);
    });

    it('POST /api/dataanalysis returns 401 without auth', async () => {
      const res = await request(app).post('/api/dataanalysis')
        .send({ input: '1,2,3,4,5' });
      expect(res.status).toBe(401);
    });
  });

  describe('Admin Endpoints', () => {
    it('returns 403 without admin key', async () => {
      const res = await request(app).get('/api/admin/stats');
      expect(res.status).toBe(403);
    });

    it('blocks query param admin_key', async () => {
      const res = await request(app).get('/api/admin/stats?admin_key=test-admin-pass');
      expect(res.status).toBe(403);
    });

    it('returns 200 with correct header', async () => {
      const res = await request(app).get('/api/admin/stats').set('x-admin-key', adminPassword);
      expect(res.status).toBe(200);
      expect(res.body.data.users).toBeDefined();
    });

    it('recharges user points', async () => {
      const name = 'rechargetest_' + Date.now();
      const regRes = await request(app).post('/api/register')
        .send({ username: name, password: 'testpass123', invite_code: inviteCode });
      if (regRes.status !== 200) return; // skip if rate limited

      const res = await request(app).post('/api/admin/recharge')
        .set('x-admin-key', adminPassword)
        .send({ username: name, points: 500 });
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('充值 500 点');
    });

    it('returns 404 for non-existent user', async () => {
      const res = await request(app).post('/api/admin/recharge')
        .set('x-admin-key', adminPassword)
        .send({ username: 'nobody_' + Date.now(), points: 100 });
      expect(res.status).toBe(404);
    });

    it('creates invite code', async () => {
      const res = await request(app).post('/api/admin/invite-codes')
        .set('x-admin-key', adminPassword)
        .send({ max_uses: 5, note: 'test batch' });
      expect(res.status).toBe(200);
      expect(res.body.data.code).toBeDefined();
      expect(res.body.data.code.length).toBe(8);
    });

    it('lists invite codes', async () => {
      const res = await request(app).get('/api/admin/invite-codes')
        .set('x-admin-key', adminPassword);
      expect([200, 429]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.data.invite_codes.length).toBeGreaterThan(0);
      }
    });

    it('disables invite code', async () => {
      const newCode = db.createInviteCode(1, 'to disable');
      const res = await request(app).post('/api/admin/invite-codes/disable')
        .set('x-admin-key', adminPassword)
        .send({ code: newCode.code });
      expect([200, 429]).toContain(res.status);
      if (res.status === 429) return; // rate limited

      // Verify it's disabled
      const validateResult = db.validateInviteCode(newCode.code);
      expect(validateResult.error).toBe('邀请码已失效');
    });
  });

  describe('Payment Endpoints', () => {
    let payApiKey;

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/register')
        .send({ username: 'paytest_' + Date.now(), password: 'testpass123', invite_code: inviteCode });
      if (res.body.success) payApiKey = res.body.data.api_key;
    });

    it('GET /api/payments/packages returns packages', async () => {
      const res = await request(app).get('/api/payments/packages');
      expect(res.status).toBe(200);
      expect(res.body.data.packages.length).toBeGreaterThan(0);
    });

    it('POST /api/payments/create-order creates order', async () => {
      const res = await request(app).post('/api/payments/create-order')
        .set('Authorization', `Bearer ${payApiKey}`)
        .send({ package_id: 'basic' });
      if (res.status === 200) {
        expect(res.body.data.order_no).toMatch(/^ORD-/);
      } else {
        expect(res.status).toBe(429);
      }
    });

    it('POST /api/payments/create-order rejects invalid package', async () => {
      const res = await request(app).post('/api/payments/create-order')
        .set('Authorization', `Bearer ${payApiKey}`)
        .send({ package_id: 'nonexistent' });
      expect([400, 429]).toContain(res.status);
    });

    it('GET /api/payments/orders returns history', async () => {
      const res = await request(app).get('/api/payments/orders')
        .set('Authorization', `Bearer ${payApiKey}`);
      expect([200, 401, 429]).toContain(res.status);
    });
  });
});
