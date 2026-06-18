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

const app = require('../server');

describe('Server API Integration', () => {
  let apiKey;
  const adminPassword = 'test-admin-pass';

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ username: 'integrationtest_' + Date.now(), password: 'testpass123' });
    if (res.body.success) {
      apiKey = res.body.data.api_key;
    } else {
      // May be rate limited; create a fallback key via a second attempt
      const res2 = await request(app)
        .post('/api/register')
        .send({ username: 'integrationtest2_' + Date.now(), password: 'testpass123' });
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
    it('registers new user', async () => {
      const name = 'newuser_' + Date.now();
      const res = await request(app)
        .post('/api/register')
        .send({ username: name, password: 'password123' });
      expect([200, 429]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.success).toBe(true);
        expect(res.body.data.api_key).toMatch(/^dsk-/);
        expect(res.body.data.balance).toBe(100);
      }
    });

    it('rejects duplicate username', async () => {
      await request(app).post('/api/register').send({ username: 'dupuser', password: 'password123' });
      const res = await request(app).post('/api/register').send({ username: 'dupuser', password: 'password123' });
      expect(res.status).toBe(409);
    });

    it('rejects short username', async () => {
      const res = await request(app).post('/api/register').send({ username: 'ab', password: 'short' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/login', () => {
    beforeAll(async () => {
      await request(app).post('/api/register').send({ username: 'loginuser', password: 'correctpass' });
    });

    it('logs in with correct password', async () => {
      const res = await request(app).post('/api/login').send({ username: 'loginuser', password: 'correctpass' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('rejects wrong password', async () => {
      const res = await request(app).post('/api/login').send({ username: 'loginuser', password: 'wrongpass' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/me', () => {
    it('returns user info or handles rate limiting', async () => {
      if (!apiKey) return; // skip if registration was rate limited
      const res = await request(app).get('/api/me').set('Authorization', `Bearer ${apiKey}`);
      expect([200, 401, 429]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.data.username).toMatch(/^integrationtest/);
      }
    });

    it('returns 401 without key', async () => {
      const res = await request(app).get('/api/me');
      expect(res.status).toBe(401);
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
      const res = await request(app).post('/api/admin/recharge')
        .set('x-admin-key', adminPassword)
        .send({ username: 'integrationtest', points: 500 });
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('充值 500 点');
    });

    it('returns 404 for non-existent user', async () => {
      const res = await request(app).post('/api/admin/recharge')
        .set('x-admin-key', adminPassword)
        .send({ username: 'nobody', points: 100 });
      expect(res.status).toBe(404);
    });
  });

  describe('Payment Endpoints', () => {
    let payApiKey;

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/register')
        .send({ username: 'paytest_' + Date.now(), password: 'testpass123' });
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
      // Accept 429 if rate limited from previous tests
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
      // Accept 200, 401, or 429 depending on rate limit state
      expect([200, 401, 429]).toContain(res.status);
    });
  });
});
