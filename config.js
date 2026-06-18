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
});

module.exports = config;
