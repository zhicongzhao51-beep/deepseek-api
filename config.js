'use strict';

require('dotenv').config();

/**
 * @param {string} key - Environment variable name
 * @param {string} [fallback] - Optional fallback value
 * @returns {string}
 */
function required(key, fallback) {
  const val = process.env[key] || fallback;
  if (val === undefined || val === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

/**
 * @param {string} key - Environment variable name
 * @param {string} fallback - Default value
 * @returns {string}
 */
function optional(key, fallback) {
  return process.env[key] || fallback;
}

const config = Object.freeze({
  // Server
  port: parseInt(optional('PORT', '3456'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),

  // DeepSeek API
  deepseekApiKey: required('DEEPSEEK_API_KEY'),
  deepseekBaseUrl: optional('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
  deepseekModel: optional('DEEPSEEK_MODEL', 'deepseek-v4-flash'),

  // Admin
  adminPassword: required('ADMIN_PASSWORD'),

  // Rate limits
  rateLimitWindowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '60000'), 10),
  rateLimitMaxAi: parseInt(optional('RATE_LIMIT_MAX_AI', '30'), 10),
  rateLimitMaxAuth: parseInt(optional('RATE_LIMIT_MAX_AUTH', '10'), 10),

  // Request body size limit
  maxBodySize: optional('MAX_BODY_SIZE', '100kb'),

  // DeepSeek API timeout (ms)
  deepseekTimeoutMs: parseInt(optional('DEEPSEEK_TIMEOUT_MS', '30000'), 10),

  // XorPay
  xorpayAppId: optional('XORPAY_APP_ID', ''),
  xorpayAppSecret: optional('XORPAY_APP_SECRET', ''),
  xorpayNotifyUrl: optional('XORPAY_NOTIFY_URL', ''),

  // Points packages (JSON string)
  pointsPackages: JSON.parse(optional('POINTS_PACKAGES', JSON.stringify([
    { id: 'basic',    label: '基础包',  amount: 10,   points: 1000,  bonus: 0    },
    { id: 'starter',  label: '入门包',  amount: 50,   points: 5000,  bonus: 500  },
    { id: 'popular',  label: '人气包',  amount: 100,  points: 10000, bonus: 2000 },
    { id: 'pro',      label: '专业包',  amount: 200,  points: 20000, bonus: 5000 },
    { id: 'ultimate', label: '企业包',  amount: 500,  points: 50000, bonus: 15000},
  ]))),

  // Payment order expiry (minutes)
  paymentOrderExpiryMinutes: parseInt(optional('PAYMENT_ORDER_EXPIRY_MINUTES', '30'), 10),

  // Manual/offline payment info (shown to users on recharge page)
  manualPaymentInfo: optional('MANUAL_PAYMENT_INFO', ''),
});

module.exports = config;
