'use strict';

const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');

// ── Zod Schemas ──────────────────────────────────────────────

const registerSchema = z.object({
  username: z.string().min(3, '用户名至少3个字符').max(32, '用户名最多32个字符'),
  password: z.string().min(6, '密码至少6个字符').max(128, '密码最多128个字符'),
});

const loginSchema = z.object({
  username: z.string().min(1, '请提供用户名'),
  password: z.string().min(1, '请提供密码'),
});

const aiEndpointSchema = z.object({
  input: z.string().min(1, '请提供 input 字段').max(50000, '输入内容过长'),
  max_tokens: z.number().int().min(1).max(8192).optional().default(2048),
});

const rechargeSchema = z.object({
  username: z.string().min(1, '请提供用户名'),
  points: z.number().int().min(1, '点数必须为正整数').max(1000000, '单次充值不能超过100万点'),
});

// ── Validation Middleware Factory ────────────────────────────

/**
 * Creates Express middleware that validates req.body against a Zod schema.
 * On failure, returns 400 with the first validation error message.
 * On success, replaces req.body with the parsed (safe) object.
 *
 * @param {import('zod').ZodSchema} schema
 * @returns {import('express').RequestHandler}
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error.issues[0]?.message || '请求参数无效',
      });
    }
    // Replace body with validated & defaulted object (immutable — Zod returns a new object)
    req.body = result.data;
    next();
  };
}

// ── Auth Middleware ──────────────────────────────────────────

/**
 * Express middleware that requires a valid API key in the Authorization header.
 * Attaches `req.user` on success.
 *
 * @param {object} deps
 * @param {function} deps.getUserByApiKey
 * @returns {import('express').RequestHandler}
 */
function requireApiKey(deps) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: '缺少 API Key，请在 Authorization header 中使用 Bearer <your-api-key>',
      });
    }

    const apiKey = authHeader.slice(7);
    const user = deps.getUserByApiKey(apiKey);
    if (!user) {
      return res.status(401).json({ success: false, error: '无效的 API Key' });
    }

    if (user.balance <= 0) {
      return res.status(402).json({ success: false, error: '余额不足，请充值后继续使用' });
    }

    req.user = user;
    next();
  };
}

/**
 * Express middleware that requires the admin password via the x-admin-key header.
 * Query parameter auth is NOT accepted.
 *
 * @returns {import('express').RequestHandler}
 */
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== config.adminPassword) {
    return res.status(403).json({ success: false, error: '管理员密码错误' });
  }
  next();
}

// ── Rate Limiters ───────────────────────────────────────────

const aiLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMaxAi,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '请求过于频繁，请稍后再试' },
});

const authLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMaxAuth,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '请求过于频繁，请稍后再试' },
});

const adminLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '请求过于频繁，请稍后再试' },
});

// ── Request ID ──────────────────────────────────────────────

/**
 * Attaches a unique ID to every request for log correlation.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
function requestId(req, _res, next) {
  req.requestId = uuidv4();
  next();
}

// ── Exports ─────────────────────────────────────────────────

module.exports = {
  schemas: { registerSchema, loginSchema, aiEndpointSchema, rechargeSchema },
  validate,
  requireApiKey,
  requireAdmin,
  aiLimiter,
  authLimiter,
  adminLimiter,
  requestId,
};
