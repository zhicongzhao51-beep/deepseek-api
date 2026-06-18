require('dotenv').config();
const express = require('express');
const db = require('./db');
const path = require('path');

const PORT = process.env.PORT || 3456;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

// --- Prompt Templates ---

const PROMPTS = {
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
};

// --- Express App ---

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth Middleware ---

function requireApiKey(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: '缺少 API Key，请在 Authorization header 中使用 Bearer <your-api-key>' });
  }

  const apiKey = authHeader.slice(7);
  const user = db.getUserByApiKey(apiKey);
  if (!user) {
    return res.status(401).json({ success: false, error: '无效的 API Key' });
  }

  if (user.balance <= 0) {
    return res.status(402).json({ success: false, error: '余额不足，请充值后继续使用' });
  }

  req.user = user;
  next();
}

// --- DeepSeek API Call ---

async function callDeepSeek(systemPrompt, userMessage, maxTokens = 2048) {
  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`DeepSeek API error (${response.status}): ${errBody}`);
  }

  return response.json();
}

// --- Cost Calculation ---

// DeepSeek pricing: input ¥1/M tokens, output ¥2/M tokens
// We charge 1 point per 1000 output chars (~1500 output tokens)
// 1 point ≈ ¥0.01 worth of DeepSeek cost, user pays ¥0.10
function calculateCost(promptTokens, completionTokens) {
  const inputCost = (promptTokens / 1_000_000) * 1;   // ¥
  const outputCost = (completionTokens / 1_000_000) * 2; // ¥
  const totalCostYuan = inputCost + outputCost;

  // Charge minimum 1 point, or 1 point per ¥0.01 cost (10x markup)
  const points = Math.max(1, Math.ceil(totalCostYuan * 100));
  return { totalCostYuan, points };
}

// --- API Routes ---

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'DeepSeek API Service is running' });
});

// User registration (admin or self-service)
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: '请提供 username 和 password' });
  }
  if (username.length < 3 || password.length < 6) {
    return res.status(400).json({ success: false, error: '用户名至少3个字符，密码至少6个字符' });
  }

  const result = db.createUser(username, password);
  if (result.error) {
    return res.status(409).json({ success: false, error: result.error });
  }

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
});

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: '请提供 username 和 password' });
  }

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
});

// Generic AI endpoint
async function handleAiEndpoint(req, res, promptKey) {
  const { input, max_tokens } = req.body;
  if (!input || typeof input !== 'string') {
    return res.status(400).json({ success: false, error: '请提供 input 字段（字符串）' });
  }

  const prompt = PROMPTS[promptKey];
  const userMessage = prompt.userTemplate(input);

  try {
    const result = await callDeepSeek(prompt.system, userMessage, max_tokens || 2048);

    const promptTokens = result.usage?.prompt_tokens || 0;
    const completionTokens = result.usage?.completion_tokens || 0;
    const { points } = calculateCost(promptTokens, completionTokens);

    // Check balance
    const currentUser = db.getUserByApiKey(req.user.api_key);
    if (currentUser.balance < points) {
      return res.status(402).json({ success: false, error: `余额不足，本次需要 ${points} 点，当前余额 ${currentUser.balance} 点` });
    }

    // Deduct and log
    db.deductBalance(req.user.id, points);
    db.logUsage(req.user.id, promptKey, promptTokens, completionTokens, points);

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
    console.error(`[${promptKey}]`, err.message);
    res.status(500).json({ success: false, error: 'AI 服务暂时不可用，请稍后重试' });
  }
}

app.post('/api/writer', requireApiKey, (req, res) => handleAiEndpoint(req, res, 'writer'));
app.post('/api/translator', requireApiKey, (req, res) => handleAiEndpoint(req, res, 'translator'));
app.post('/api/summary', requireApiKey, (req, res) => handleAiEndpoint(req, res, 'summary'));

// User info / balance check
app.get('/api/me', requireApiKey, (req, res) => {
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

// --- Admin Routes ---

const ADMIN_PASSWORD = 'admin888';

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.admin_key;
  if (key !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, error: '管理员密码错误' });
  }
  next();
}

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const users = db.getAllUsers();
  const stats = db.getUsageStats();
  res.json({
    success: true,
    data: { users, usage_stats: stats },
  });
});

app.post('/api/admin/recharge', requireAdmin, (req, res) => {
  const { username, points } = req.body;
  if (!username || !points || points <= 0) {
    return res.status(400).json({ success: false, error: '请提供 username 和 points（正整数）' });
  }

  const user = db.getUserByUsername(username);
  if (!user) {
    return res.status(404).json({ success: false, error: '用户不存在' });
  }

  db.addBalance(user.id, points);
  const updatedUser = db.getUserByApiKey(user.api_key);
  res.json({
    success: true,
    message: `已为 ${username} 充值 ${points} 点`,
    data: { username, balance_after: updatedUser.balance },
  });
});

// --- Start Server ---

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║   🚀 DeepSeek API Service v1.0             ║
║   服务地址: http://localhost:${PORT}          ║
║   管理面板: http://localhost:${PORT}/admin   ║
║   健康检查: http://localhost:${PORT}/api/health ║
╚══════════════════════════════════════════════╝
    `);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
