'use strict';

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');

const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const mw = require('./middleware');

// ── Prompt Templates ────────────────────────────────────────

const PROMPTS = Object.freeze({
  writer: {
    system: `你是一位资深的中文内容创作者，擅长各类文体写作（文章、营销文案、社交媒体内容、邮件、演讲稿等）。
写作规则：
- 根据用户需求自动判断文体和风格
- 语言流畅自然，避免AI痕迹
- 内容结构清晰，逻辑严密
- 必要时提供多个版本供选择
- 默认输出中文`,
    userTemplate: (input) => `请根据以下要求创作内容：\n\n${input}`,
  },

  translator: {
    system: `你是一位专业的中英双语翻译专家。
翻译规则：
- 准确传达原文意思，不增不减
- 中文翻译符合中文表达习惯，英文翻译符合英文表达习惯
- 保持原文语气和风格
- 专业术语翻译准确
- 如果是中译英，确保英语地道流畅
- 如果是英译中，确保中文自然优雅
- 输出格式：先判断翻译方向，然后输出译文`,
    userTemplate: (input) => `请翻译以下内容：\n\n${input}`,
  },

  summary: {
    system: `你是一位高效的信息整理专家，擅长将长文本提炼为精炼摘要。
摘要规则：
- 提取核心观点和关键信息
- 保留重要数据和事实
- 结构层次分明（总-分结构）
- 默认输出3种长度：一句话总结、段落摘要、详细摘要
- 在开头标注原文大致字数`,
    userTemplate: (input) => `请对以下内容进行摘要：\n\n${input}`,
  },
});

// ── Express App ─────────────────────────────────────────────

const app = express();

// Security headers (helmet) — permissive CSP for admin panel inline scripts
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'"],
      'script-src-attr': ["'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'"],
    },
  },
}));

// Request ID for log correlation
app.use(mw.requestId);

// Body parsing with size limit
app.use(express.json({ limit: config.maxBodySize }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ── DeepSeek API Call ───────────────────────────────────────

/**
 * Calls the DeepSeek chat completions API.
 * Full error details are logged internally; only a generic message is thrown.
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {number} [maxTokens]
 * @returns {Promise<object>}
 */
async function callDeepSeek(systemPrompt, userMessage, maxTokens = 2048) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.deepseekTimeoutMs);

  try {
    const response = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: config.deepseekModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const status = response.status;
      // Only capture safe parts of the error body; never log raw secrets
      const errBody = await response.text().catch(() => '<unreadable>');
      logger.error({ status, errBodyLen: errBody.length }, 'DeepSeek API error');
      throw new Error(`DeepSeek API returned status ${status}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ── Cost Calculation ────────────────────────────────────────

/**
 * DeepSeek pricing: input ¥1/M tokens, output ¥2/M tokens.
 * We charge 1 point per ¥0.01 worth of DeepSeek cost (10x markup).
 *
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @returns {{ totalCostYuan: number, points: number }}
 */
function calculateCost(promptTokens, completionTokens) {
  const inputCost = (promptTokens / 1_000_000) * 1;
  const outputCost = (completionTokens / 1_000_000) * 2;
  const totalCostYuan = inputCost + outputCost;
  const points = Math.max(1, Math.ceil(totalCostYuan * 100));
  return { totalCostYuan, points };
}

// ── Routes: Public ──────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ success: true, message: 'DeepSeek API Service is running' });
});

// User registration
app.post('/api/register',
  mw.authLimiter,
  mw.validate(mw.schemas.registerSchema),
  (req, res) => {
    const { username, password } = req.body; // already validated

    const result = db.createUser(username, password);
    if (result.error) {
      return res.status(409).json({ success: false, error: result.error });
    }

    logger.info({ username, requestId: req.requestId }, 'New user registered');

    res.json({
      success: true,
      message: '注册成功！新用户赠送100点数',
      data: {
        username: result.username,
        api_key: result.api_key,
        balance: result.balance,
        usage: `在 Authorization header 中使用: Bearer ${result.api_key}`,
      },
    });
  }
);

// User login
app.post('/api/login',
  mw.authLimiter,
  mw.validate(mw.schemas.loginSchema),
  (req, res) => {
    const { username, password } = req.body;

    const user = db.authenticateUser(username, password);
    if (!user) {
      return res.status(401).json({ success: false, error: '用户名或密码错误' });
    }

    res.json({
      success: true,
      data: {
        username: user.username,
        api_key: user.api_key,
        balance: user.balance,
      },
    });
  }
);

// ── Routes: Authenticated (API Key) ─────────────────────────

const requireAuth = mw.requireApiKey({ getUserByApiKey: db.getUserByApiKey });

/**
 * Generic handler for AI endpoints (writer, translator, summary).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {'writer'|'translator'|'summary'} promptKey
 */
async function handleAiEndpoint(req, res, promptKey) {
  const { input, max_tokens } = req.body; // validated

  const prompt = PROMPTS[promptKey];
  const userMessage = prompt.userTemplate(input);

  try {
    const result = await callDeepSeek(prompt.system, userMessage, max_tokens);

    const promptTokens = result.usage?.prompt_tokens || 0;
    const completionTokens = result.usage?.completion_tokens || 0;
    const { points } = calculateCost(promptTokens, completionTokens);

    // Re-fetch user to get latest balance
    const currentUser = db.getUserByApiKey(req.user.api_key);
    if (!currentUser || currentUser.balance < points) {
      return res.status(402).json({
        success: false,
        error: `余额不足，本次需要 ${points} 点，当前余额 ${currentUser ? currentUser.balance : 0} 点`,
      });
    }

    db.deductBalance(req.user.id, points);
    db.logUsage(req.user.id, promptKey, promptTokens, completionTokens, points);

    logger.info({
      userId: req.user.id,
      endpoint: promptKey,
      promptTokens,
      completionTokens,
      points,
      requestId: req.requestId,
    }, 'AI request completed');

    res.json({
      success: true,
      data: {
        result: result.choices[0]?.message?.content || '',
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          points_cost: points,
          balance_remaining: currentUser.balance - points,
        },
      },
    });
  } catch (err) {
    logger.error({
      err,
      endpoint: promptKey,
      userId: req.user?.id,
      requestId: req.requestId,
    }, 'AI endpoint error');
    res.status(500).json({
      success: false,
      error: 'AI 服务暂时不可用，请稍后重试',
    });
  }
}

app.post('/api/writer',
  mw.aiLimiter,
  requireAuth,
  mw.validate(mw.schemas.aiEndpointSchema),
  (req, res) => handleAiEndpoint(req, res, 'writer')
);

app.post('/api/translator',
  mw.aiLimiter,
  requireAuth,
  mw.validate(mw.schemas.aiEndpointSchema),
  (req, res) => handleAiEndpoint(req, res, 'translator')
);

app.post('/api/summary',
  mw.aiLimiter,
  requireAuth,
  mw.validate(mw.schemas.aiEndpointSchema),
  (req, res) => handleAiEndpoint(req, res, 'summary')
);

// User info / balance check (rate limited to prevent API key enumeration)
app.get('/api/me', mw.authLimiter, requireAuth, (req, res) => {
  const stats = db.getUsageStats(req.user.id);
  res.json({
    success: true,
    data: {
      username: req.user.username,
      balance: req.user.balance,
      usage_stats: stats,
    },
  });
});

// ── Routes: Admin ───────────────────────────────────────────

// Admin stats (header-based auth only, rate limited before auth to prevent brute force)
app.get('/api/admin/stats', mw.adminLimiter, mw.requireAdmin, (_req, res) => {
  const users = db.getAllUsers();
  const stats = db.getUsageStats();
  res.json({
    success: true,
    data: { users, usage_stats: stats },
  });
});

// Admin recharge (header-based auth only, rate limited before auth)
app.post('/api/admin/recharge',
  mw.adminLimiter,
  mw.requireAdmin,
  mw.validate(mw.schemas.rechargeSchema),
  (req, res) => {
    const { username, points } = req.body;

    const user = db.getUserByUsername(username);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    db.addBalance(user.id, points);
    const updatedUser = db.getUserByApiKey(user.api_key);

    logger.info({
      adminAction: 'recharge',
      targetUser: username,
      points,
      requestId: req.requestId,
    }, 'Admin recharge');

    res.json({
      success: true,
      message: `已为 ${username} 充值 ${points} 点`,
      data: { username, balance_after: updatedUser.balance },
    });
  }
);

// ── Global Error Handler ────────────────────────────────────

app.use((err, _req, res, _next) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({
    success: false,
    error: '服务器内部错误，请稍后重试',
  });
});

// ── Start Server ────────────────────────────────────────────

db.init().then(() => {
  app.listen(config.port, () => {
    logger.info({
      port: config.port,
      env: config.nodeEnv,
      adminPanel: `http://localhost:${config.port}/admin`,
    }, 'DeepSeek API Service started');
  });
}).catch((err) => {
  logger.fatal({ err }, 'Failed to initialize database');
  process.exit(1);
});
