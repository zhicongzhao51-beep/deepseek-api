'use strict';

// Mock config before loading middleware
jest.mock('../config', () => ({
  adminPassword: 'test-admin-pass',
  rateLimitWindowMs: 60000,
  rateLimitMaxAi: 30,
  rateLimitMaxAuth: 10,
  nodeEnv: 'test',
}));

const mw = require('../middleware');

function mockReq(body = {}, headers = {}) {
  return { body, headers, ip: '127.0.0.1', requestId: null, user: null };
}

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('middleware.js', () => {
  describe('validate', () => {
    it('calls next() when body is valid', () => {
      const { registerSchema } = mw.schemas;
      const req = mockReq({ username: 'testuser', password: 'pass123' });
      const res = mockRes();
      const next = jest.fn();

      mw.validate(registerSchema)(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.body.username).toBe('testuser');
    });

    it('returns 400 when body is invalid', () => {
      const { registerSchema } = mw.schemas;
      const req = mockReq({ username: 'ab', password: '12' });
      const res = mockRes();
      const next = jest.fn();

      mw.validate(registerSchema)(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });

    it('returns 400 on missing required fields', () => {
      const { createPaymentOrderSchema } = mw.schemas;
      const req = mockReq({ package_id: '' });
      const res = mockRes();
      const next = jest.fn();

      mw.validate(createPaymentOrderSchema)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('applies defaults for optional fields', () => {
      const { aiEndpointSchema } = mw.schemas;
      const req = mockReq({ input: 'hello world' });
      const res = mockRes();
      const next = jest.fn();

      mw.validate(aiEndpointSchema)(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.body.max_tokens).toBe(2048);
    });

    it('rejects input exceeding max length', () => {
      const { aiEndpointSchema } = mw.schemas;
      const req = mockReq({ input: 'x'.repeat(50001) });
      const res = mockRes();
      const next = jest.fn();

      mw.validate(aiEndpointSchema)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('requireApiKey', () => {
    it('returns 401 when no Authorization header', () => {
      const fakeDb = { getUserByApiKey: jest.fn() };
      const auth = mw.requireApiKey(fakeDb);
      const req = mockReq({}, {});
      const res = mockRes();
      const next = jest.fn();

      auth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 for non-Bearer auth', () => {
      const fakeDb = { getUserByApiKey: jest.fn() };
      const auth = mw.requireApiKey(fakeDb);
      const req = mockReq({}, { authorization: 'Basic xyz' });
      const res = mockRes();
      const next = jest.fn();

      auth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('returns 401 for invalid API key', () => {
      const fakeDb = { getUserByApiKey: jest.fn(() => null) };
      const auth = mw.requireApiKey(fakeDb);
      const req = mockReq({}, { authorization: 'Bearer invalid-key' });
      const res = mockRes();
      const next = jest.fn();

      auth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('returns 402 when balance is zero', () => {
      const fakeDb = {
        getUserByApiKey: jest.fn(() => ({ id: 1, username: 'broke', api_key: 'dsk-xxx', balance: 0 })),
      };
      const auth = mw.requireApiKey(fakeDb);
      const req = mockReq({}, { authorization: 'Bearer dsk-xxx' });
      const res = mockRes();
      const next = jest.fn();

      auth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(402);
    });

    it('calls next() and attaches req.user on success', () => {
      const user = { id: 1, username: 'rich', api_key: 'dsk-abc', balance: 100 };
      const fakeDb = { getUserByApiKey: jest.fn(() => user) };
      const auth = mw.requireApiKey(fakeDb);
      const req = mockReq({}, { authorization: 'Bearer dsk-abc' });
      const res = mockRes();
      const next = jest.fn();

      auth(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual(user);
    });
  });

  describe('requireAdmin', () => {
    it('returns 403 without x-admin-key header', () => {
      const req = mockReq();
      const res = mockRes();
      const next = jest.fn();
      mw.requireAdmin(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('returns 403 with wrong password', () => {
      const req = mockReq({}, { 'x-admin-key': 'wrong' });
      const res = mockRes();
      const next = jest.fn();
      mw.requireAdmin(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('calls next() with correct password', () => {
      const req = mockReq({}, { 'x-admin-key': 'test-admin-pass' });
      const res = mockRes();
      const next = jest.fn();
      mw.requireAdmin(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('requestId', () => {
    it('attaches UUID to req.requestId', () => {
      const req = mockReq();
      const res = mockRes();
      const next = jest.fn();
      mw.requestId(req, res, next);
      expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(next).toHaveBeenCalled();
    });
  });
});
