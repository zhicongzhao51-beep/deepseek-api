'use strict';

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');

const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const mw = require('./middleware');
const notify = require('./services/notify');

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

  chat: {
    system: `你是一个智能AI助手，能够回答各种问题、提供建议、进行创作和分析。
规则：
- 回答准确、有用、安全
- 如果不知道答案，诚实地说明
- 保持对话连贯，理解上下文
- 使用中文回答（除非用户使用其他语言）
- 避免生成有害、违法或不道德的内容`,
    userTemplate: (messages) => null, // chat uses raw messages array
  },

  codegen: {
    system: `你是一位资深全栈软件工程师，精通多种编程语言和框架。
代码生成规则：
- 根据需求生成高质量、可运行的代码
- 遵循最佳实践和设计模式
- 包含必要的错误处理和边界检查
- 代码注释清晰（中文注释）
- 标注编程语言和依赖项
- 如果需求不明确，先澄清再生成
- 输出格式：先简要说明思路，再输出代码`,
    userTemplate: (input, language) => `请用 ${language} 生成以下代码：\n\n${input}`,
  },

  codereview: {
    system: `你是一位资深代码审查专家，擅长发现代码中的问题并提供改进建议。
审查规则：
- 检查代码正确性、性能、安全性和可维护性
- 发现潜在bug和边界条件问题
- 评估代码结构和命名
- 指出安全漏洞（SQL注入、XSS等）
- 提供具体的改进建议和示例
- 按严重程度排序：🔴严重 🟡警告 🟢建议
- 输出格式：先总结，再逐条列出问题`,
    userTemplate: (input) => `请审查以下代码：\n\n${input}`,
  },

  dataanalysis: {
    system: `你是一位资深数据分析师，擅长从数据中提取洞察。
分析规则：
- 先理解数据结构和含义
- 进行统计分析（趋势、分布、异常值等）
- 发现数据中的模式和关联
- 提供可操作的建议
- 使用表格和图表描述来呈现结果
- 标注数据质量和潜在问题
- 输出格式：数据概览 → 关键发现 → 详细分析 → 建议`,
    userTemplate: (input) => `请分析以下数据：\n\n${input}`,
  },
});

// ── Express App ─────────────────────────────────────────────

const app = express();

// Trust Railway proxy (fixes express-rate-limit X-Forwarded-For warning)
app.set('trust proxy', 1);

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

// Body parsing with size limit + raw body capture for payment webhook verification
app.use(express.json({
  limit: config.maxBodySize,
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Static files (support extensionless .html access like /recharge, /admin)
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Payment routes (mounted before main routes for webhook priority)
const paymentRoutes = require('./routes/payments');
app.use('/api/payments', paymentRoutes);

// ── Quick Approve (one-click from WeChat notification) ──────

app.get('/approve/:token', (req, res) => {
  const order = db.getPaymentOrderByApproveToken(req.params.token);
  if (!order) {
    return res.status(404).send('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>链接无效</title><style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;text-align:center;padding:20px}</style></head><body><div><h1 style="font-size:48px;margin-bottom:16px">🔗</h1><h2>链接无效或已过期</h2><p style="color:#94a3b8">该审核链接不存在或已被使用</p></div></body></html>');
  }
  if (order.status === 'paid') {
    return res.send('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已审核</title><style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;text-align:center;padding:20px}</style></head><body><div><h1 style="font-size:48px;margin-bottom:16px">✅</h1><h2>此订单已审核通过</h2><p style="color:#94a3b8">订单 ${order.order_no}，¥${order.amount}，${order.points.toLocaleString()} 点已到账</p></div></body></html>');
  }
  if (order.status !== 'submitted') {
    return res.send('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>状态异常</title><style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;text-align:center;padding:20px}</style></head><body><div><h1 style="font-size:48px;margin-bottom:16px">⚠️</h1><h2>订单状态异常</h2><p style="color:#94a3b8">订单 ${order.order_no} 当前状态为 ${order.status}，无法审核</p></div></body></html>');
  }

  // Show confirmation page
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>确认收款</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;padding:20px;max-width:480px;margin:0 auto}
  .card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:24px;margin:24px 0}
  h2{font-size:22px;margin-bottom:4px}
  .row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #1e293b;font-size:15px}
  .row .l{color:#94a3b8}.row .v{font-weight:600}
  .btn{display:block;width:100%;padding:16px;border-radius:12px;font-size:18px;font-weight:700;border:none;cursor:pointer;margin-bottom:12px;text-align:center}
  .btn-approve{background:#22c55e;color:white}
  .btn-reject{background:#7f1d1d;color:#fca5a5}
  .toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:12px 24px;border-radius:8px;font-size:14px;z-index:999;display:none}
  .toast-success{background:#065f46;color:#6ee7b7}
  .toast-error{background:#7f1d1d;color:#fca5a5}
</style>
</head>
<body>
<h2 style="text-align:center;margin-top:32px">💰 确认收款</h2>
<p style="text-align:center;color:#94a3b8;margin-bottom:8px">请在微信/支付宝确认已收到款项</p>
<div class="card">
  <div class="row"><span class="l">订单号</span><span class="v" style="font-family:monospace;font-size:13px">${order.order_no}</span></div>
  <div class="row"><span class="l">套餐</span><span class="v">${order.package_id}</span></div>
  <div class="row"><span class="l">金额</span><span class="v" style="color:#f59e0b">¥${order.amount}</span></div>
  <div class="row"><span class="l">点数</span><span class="v">${(order.points + (order.bonus_points||0)).toLocaleString()} 点</span></div>
  <div class="row"><span class="l">交易单号</span><span class="v" style="font-size:13px">${order.transaction_id || '-'}</span></div>
  <div class="row"><span class="l">备注</span><span class="v" style="font-size:13px">${order.proof_note || '-'}</span></div>
</div>
<button class="btn btn-approve" onclick="approve()">✅ 确认已收款，立即到账</button>
<button class="btn btn-reject" onclick="reject()">❌ 驳回</button>
<div id="toast" class="toast"></div>
<script>
function toast(msg,type){var t=document.getElementById('toast');t.textContent=msg;t.className='toast toast-'+(type||'success');t.style.display='block';setTimeout(function(){t.style.display='none'},2000)}
function approve(){
  var btns=document.querySelectorAll('.btn');btns.forEach(function(b){b.disabled=true;b.style.opacity='0.5'});
  fetch('/approve/${order.approve_token}',{method:'POST'})
    .then(function(r){return r.text()})
    .then(function(html){
      document.body.innerHTML=html;
    });
}
function reject(){
  if(!confirm('确定驳回此订单吗？用户可重新提交凭证。'))return;
  var btns=document.querySelectorAll('.btn');btns.forEach(function(b){b.disabled=true;b.style.opacity='0.5'});
  fetch('/approve/${order.approve_token}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'reject'})})
    .then(function(r){return r.text()})
    .then(function(html){
      document.body.innerHTML=html;
    });
}
</script>
</body>
</html>`);
});

app.post('/approve/:token', (req, res) => {
  const { action } = req.body || {};

  if (action === 'reject') {
    const order = db.getPaymentOrderByApproveToken(req.params.token);
    if (!order) {
      return res.send('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>错误</title><style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;text-align:center;padding:20px}</style></head><body><div><h1 style="font-size:48px">❌</h1><h2>订单不存在</h2></div></body></html>');
    }
    const { adminRejectOrder } = require('./db');
    adminRejectOrder(order.order_no);
    return res.send('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已驳回</title><style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;text-align:center;padding:20px}</style></head><body><div><h1 style="font-size:48px">🚫</h1><h2>订单已驳回</h2><p style="color:#94a3b8">订单 ${order.order_no} 已驳回，用户可重新提交凭证</p></div></body></html>');
  }

  // Approve
  const result = db.quickApproveOrder(req.params.token);
  if (!result) {
    return res.send('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>审核失败</title><style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;text-align:center;padding:20px}</style></head><body><div><h1 style="font-size:48px">❌</h1><h2>审核失败</h2><p style="color:#94a3b8">链接无效或订单状态异常</p></div></body></html>');
  }

  logger.info({ orderNo: result.order_no, username: result.username, amount: result.amount }, 'Quick approved via WeChat link');

  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>审核成功</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;text-align:center;padding:20px}
  .card{background:#1e293b;border:2px solid #22c55e;border-radius:16px;padding:32px 24px;max-width:400px}
  h1{font-size:56px;margin-bottom:12px}
  h2{color:#22c55e;margin-bottom:8px}
  .info{margin-top:16px;color:#94a3b8;font-size:14px;line-height:1.8}
  .info span{color:#e2e8f0;font-weight:600}
</style>
</head>
<body>
<div class="card">
  <h1>✅</h1>
  <h2>收款确认成功！</h2>
  <p style="color:#94a3b8">点数已自动到账</p>
  <div class="info">
    <div>订单: <span>${result.order_no}</span></div>
    <div>用户: <span>${result.username}</span></div>
    <div>金额: <span style="color:#f59e0b">¥${result.amount}</span></div>
    <div>到账: <span>${(result.points + (result.bonus_points||0)).toLocaleString()} 点</span></div>
  </div>
</div>
</body>
</html>`);
});

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

/**
 * Calls DeepSeek chat API with raw messages array for multi-turn conversation.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} [maxTokens]
 * @param {number} [temperature]
 * @returns {Promise<object>}
 */
async function callDeepSeekChat(messages, maxTokens = 2048, temperature = 0.7) {
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
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const status = response.status;
      const errBody = await response.text().catch(() => '<unreadable>');
      logger.error({ status, errBodyLen: errBody.length }, 'DeepSeek API error (chat)');
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

// User registration (invite-only)
app.post('/api/register',
  mw.authLimiter,
  mw.validate(mw.schemas.registerSchema),
  (req, res) => {
    const { username, password, invite_code } = req.body; // already validated

    // Validate invite code
    const inviteResult = db.validateInviteCode(invite_code);
    if (!inviteResult) {
      return res.status(400).json({ success: false, error: '无效的邀请码' });
    }
    if (inviteResult.error) {
      return res.status(400).json({ success: false, error: inviteResult.error });
    }

    const result = db.createUser(username, password);
    if (result.error) {
      return res.status(409).json({ success: false, error: result.error });
    }

    // Consume the invite code
    db.consumeInviteCode(invite_code);

    logger.info({ username, inviteCode: invite_code, requestId: req.requestId }, 'New user registered (invite-only)');

    // Send WeChat notification to admin
    notify.notifyNewUser({ username, inviteCode: invite_code }).catch(() => {});

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

// Chat endpoint: multi-turn conversation
app.post('/api/chat',
  mw.aiLimiter,
  requireAuth,
  mw.validate(mw.schemas.chatSchema),
  async (req, res) => {
    const { messages, max_tokens, temperature } = req.body;

    try {
      const result = await callDeepSeekChat(messages, max_tokens, temperature);

      const promptTokens = result.usage?.prompt_tokens || 0;
      const completionTokens = result.usage?.completion_tokens || 0;
      const { points } = calculateCost(promptTokens, completionTokens);

      const currentUser = db.getUserByApiKey(req.user.api_key);
      if (!currentUser || currentUser.balance < points) {
        return res.status(402).json({
          success: false,
          error: `余额不足，本次需要 ${points} 点，当前余额 ${currentUser ? currentUser.balance : 0} 点`,
        });
      }

      db.deductBalance(req.user.id, points);
      db.logUsage(req.user.id, 'chat', promptTokens, completionTokens, points);

      logger.info({
        userId: req.user.id,
        endpoint: 'chat',
        promptTokens,
        completionTokens,
        points,
        requestId: req.requestId,
      }, 'Chat request completed');

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
      logger.error({ err, endpoint: 'chat', userId: req.user?.id, requestId: req.requestId }, 'Chat endpoint error');
      res.status(500).json({ success: false, error: 'AI 服务暂时不可用，请稍后重试' });
    }
  }
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
  const usageStats = db.getUsageStats();
  const paymentStats = db.getPaymentStats ? db.getPaymentStats() : null;
  const endpointBreakdown = db.getEndpointBreakdown ? db.getEndpointBreakdown() : null;

  // Aggregate stats
  const totalBalance = users.reduce((s, u) => s + u.balance, 0);
  const totalCalls = usageStats.reduce((s, u) => s + u.calls, 0);
  const totalPointsConsumed = usageStats.reduce((s, u) => s + u.total_cost, 0);

  // Recent registrations (last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentUsers = users.filter(u => new Date(u.created_at) >= sevenDaysAgo);

  res.json({
    success: true,
    data: {
      summary: {
        total_users: users.length,
        recent_users_7d: recentUsers.length,
        total_calls: totalCalls,
        total_points_consumed: totalPointsConsumed,
        total_user_balance: totalBalance,
      },
      payment_stats: paymentStats,
      endpoint_breakdown: endpointBreakdown,
      users,
      usage_stats: usageStats,
    },
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

// Admin: Invite Code Management
app.get('/api/admin/invite-codes', mw.adminLimiter, mw.requireAdmin, (_req, res) => {
  const codes = db.listInviteCodes();
  res.json({ success: true, data: { invite_codes: codes } });
});

app.post('/api/admin/invite-codes',
  mw.adminLimiter,
  mw.requireAdmin,
  mw.validate(mw.schemas.createInviteCodeSchema),
  (req, res) => {
    const { max_uses, note } = req.body;
    const invite = db.createInviteCode(max_uses, note);

    logger.info({ code: invite.code, maxUses: max_uses, requestId: req.requestId }, 'Invite code created');

    res.json({
      success: true,
      message: '邀请码已生成',
      data: { code: invite.code, max_uses: invite.max_uses, note: invite.note },
    });
  }
);

app.post('/api/admin/invite-codes/disable',
  mw.adminLimiter,
  mw.requireAdmin,
  mw.validate(mw.schemas.disableInviteCodeSchema),
  (req, res) => {
    const { code } = req.body;
    db.disableInviteCode(code);

    logger.info({ code, requestId: req.requestId }, 'Invite code disabled');

    res.json({ success: true, message: `邀请码 ${code} 已失效` });
  }
);

// ── New AI Endpoints ──────────────────────────────────────────

// Code Generation
app.post('/api/codegen',
  mw.aiLimiter,
  requireAuth,
  mw.validate(mw.schemas.codeGenSchema),
  async (req, res) => {
    const { input, language, max_tokens } = req.body;
    const prompt = PROMPTS.codegen;

    try {
      const result = await callDeepSeek(prompt.system, prompt.userTemplate(input, language), max_tokens);

      const promptTokens = result.usage?.prompt_tokens || 0;
      const completionTokens = result.usage?.completion_tokens || 0;
      const { points } = calculateCost(promptTokens, completionTokens);

      const currentUser = db.getUserByApiKey(req.user.api_key);
      if (!currentUser || currentUser.balance < points) {
        return res.status(402).json({
          success: false,
          error: `余额不足，本次需要 ${points} 点，当前余额 ${currentUser ? currentUser.balance : 0} 点`,
        });
      }

      db.deductBalance(req.user.id, points);
      db.logUsage(req.user.id, 'codegen', promptTokens, completionTokens, points);

      logger.info({ userId: req.user.id, endpoint: 'codegen', promptTokens, completionTokens, points, requestId: req.requestId }, 'CodeGen completed');

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
      logger.error({ err, endpoint: 'codegen', userId: req.user?.id, requestId: req.requestId }, 'CodeGen error');
      res.status(500).json({ success: false, error: 'AI 服务暂时不可用，请稍后重试' });
    }
  }
);

// Code Review
app.post('/api/codereview',
  mw.aiLimiter,
  requireAuth,
  mw.validate(mw.schemas.aiEndpointSchema),
  (req, res) => handleAiEndpoint(req, res, 'codereview')
);

// Data Analysis
app.post('/api/dataanalysis',
  mw.aiLimiter,
  requireAuth,
  mw.validate(mw.schemas.dataAnalysisSchema),
  async (req, res) => {
    const { input, max_tokens } = req.body;
    const prompt = PROMPTS.dataanalysis;

    try {
      const result = await callDeepSeek(prompt.system, prompt.userTemplate(input), max_tokens);

      const promptTokens = result.usage?.prompt_tokens || 0;
      const completionTokens = result.usage?.completion_tokens || 0;
      const { points } = calculateCost(promptTokens, completionTokens);

      const currentUser = db.getUserByApiKey(req.user.api_key);
      if (!currentUser || currentUser.balance < points) {
        return res.status(402).json({
          success: false,
          error: `余额不足，本次需要 ${points} 点，当前余额 ${currentUser ? currentUser.balance : 0} 点`,
        });
      }

      db.deductBalance(req.user.id, points);
      db.logUsage(req.user.id, 'dataanalysis', promptTokens, completionTokens, points);

      logger.info({ userId: req.user.id, endpoint: 'dataanalysis', promptTokens, completionTokens, points, requestId: req.requestId }, 'DataAnalysis completed');

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
      logger.error({ err, endpoint: 'dataanalysis', userId: req.user?.id, requestId: req.requestId }, 'DataAnalysis error');
      res.status(500).json({ success: false, error: 'AI 服务暂时不可用，请稍后重试' });
    }
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

// ── Export & Start ───────────────────────────────────────────

module.exports = app;

// Always init the database, then start if running as main module
db.init().then(() => {
  if (require.main === module) {
    app.listen(config.port, () => {
      logger.info({
        port: config.port,
        env: config.nodeEnv,
        adminPanel: `http://localhost:${config.port}/admin`,
      }, 'DeepSeek API Service started');
    });
  }
}).catch((err) => {
  logger.fatal({ err }, 'Failed to initialize database');
  process.exit(1);
});
