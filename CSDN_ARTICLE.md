# DeepSeek API 中转服务搭建全记录｜Node.js + Railway 零成本部署，7大AI能力一站式封装

> 从零到上线：一个完整的 SaaS 项目复盘，附注册福利 🎁

---

## 一、为什么要做这个项目？

最近 DeepSeek 大模型很火，但直接用官方 API 有几个痛点：

1. **注册门槛**：需要海外手机号或企业认证
2. **计费复杂**：token 计费看不懂，花多少钱心里没底
3. **缺乏封装**：每次调用都要自己写 Prompt 模板
4. **支付不便**：需要绑定海外信用卡

于是我用一个周末，搭建了一个 **DeepSeek API 中转服务**，把这些痛点都解决了。

---

## 二、技术架构

```
用户 → API Key 认证 → Express 服务 → DeepSeek API
                ↓
           SQLite (点数余额)
```

### 技术栈

| 层 | 技术 | 理由 |
|---|------|------|
| 运行时 | Node.js 18+ | 异步 I/O，适合 API 代理 |
| 框架 | Express 4.x | 轻量，中间件生态成熟 |
| 数据库 | SQL.js | 纯 JS 实现的 SQLite，无需安装 |
| 部署 | Railway | 支持 Volume 持久化，有免费额度 |
| AI 模型 | DeepSeek V4 Flash | 推理模型，性价比极高 |

### 为什么用 SQL.js 而不是 MySQL/PostgreSQL？

因为部署在 Railway 上，SQL.js 是一个 **纯 JavaScript 的 SQLite 实现**，不需要单独的数据库服务。数据存在 Railway Volume 里，零配置，零额外费用。

```javascript
// db.js — 初始化数据库
const initSQL = require('sql.js');
const fs = require('fs');

async function init() {
  const SQL = await initSQL();
  const db = new SQL.Database();
  // 如果持久化文件存在则加载
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  }
  // 建表...
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    balance INTEGER DEFAULT 100
  )`);
  return db;
}
```

---

## 三、核心功能

### 1. 7 大 AI 端点

不仅仅是聊天，我封装了 7 个场景化端点：

| 端点 | 路径 | 用途 |
|------|------|------|
| AI 写作 | `/api/writer` | 文章、文案、社交媒体内容 |
| 翻译 | `/api/translator` | 中英双向专业翻译 |
| 摘要 | `/api/summary` | 长文提炼核心观点 |
| 多轮对话 | `/api/chat` | 自由对话，支持上下文 |
| 代码生成 | `/api/codegen` | 自然语言→代码 |
| 代码审查 | `/api/codereview` | AI Review 你的代码 |
| 数据分析 | `/api/dataanalysis` | 从数据中提取洞察 |

每个端点都预设了专业的 System Prompt，用户不需要自己写提示词模板。

### 2. 点数计费系统

```
1 点 ≈ ¥0.01 价值
按实际 token 消耗扣点
用多少扣多少，不浪费
```

```javascript
// 计费逻辑
function calculateCost(promptTokens, completionTokens) {
  const total = promptTokens + completionTokens;
  const points = Math.max(1, Math.ceil(total / 1000));
  return { points };
}
```

### 3. 邀请制注册 + 支付

```
用户获取邀请码 → 注册得 API Key + 100点
→ 选择套餐 → 扫码转账 → 提交凭证
→ 管理员手机确认 → 点数自动到账
```

管理面板支持手机端一键审核（通过微信通知点击链接即可批准）。

---

## 四、一行代码接入

### cURL
```bash
curl -X POST https://deepseek-api-service-production.up.railway.app/api/writer \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": "写一篇AI行业趋势分析", "max_tokens": 2048}'
```

### Python
```python
import requests

response = requests.post(
    "https://deepseek-api-service-production.up.railway.app/api/writer",
    headers={"Authorization": "Bearer YOUR_API_KEY"},
    json={"input": "写一篇AI行业趋势分析", "max_tokens": 2048}
)
print(response.json()["data"]["result"])
```

### JavaScript
```javascript
const res = await fetch('https://deepseek-api-service-production.up.railway.app/api/writer', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ input: '写一篇AI行业趋势分析', max_tokens: 2048 })
});
const data = await res.json();
console.log(data.data.result);
```

---

## 五、部署细节

### Railway 配置

```toml
# railway.toml
[build]
  builder = "nixpacks"

[deploy]
  startCommand = "node server.js"
  healthcheckPath = "/api/health"
```

### 环境变量

```bash
DEEPSEEK_API_KEY=sk-xxxxx
DEEPSEEK_MODEL=deepseek-v4-flash
ADMIN_PASSWORD=your-strong-password
PORT=3456
DB_PATH=/app/data/data.db
```

### 踩坑记录

1. **推理模型特殊处理**：DeepSeek V4 Flash 是推理模型，AI 生成的内容在 `reasoning_content` 字段而非 `content`，需要做兼容处理：
```javascript
function extractContent(choice) {
  return choice?.message?.content || choice?.message?.reasoning_content || '';
}
```

2. **Volume 持久化**：不要用 `railway up` 部署，会重置 Volume 数据。要用 GitHub 自动部署。

---

## 六、项目开源

全部代码已开源 👉 https://github.com/zhicongzhao51-beep/deepseek-api

欢迎 Star ⭐ 和 PR！

---

## 🎁 读者福利

为感谢阅读，给大家准备了专属福利：

✅ **注册即送 100 点免费额度**（够调用 10 次左右）
✅ **10 元起充**，无最低消费
✅ **永久有效**，不过期

👉 注册地址：https://deepseek-api-service-production.up.railway.app/recharge
🔑 CSDN 读者专属邀请码：**8838NTGM**

---

## 七、后续计划

- [ ] WebSocket 流式输出支持
- [ ] 多模型切换（DeepSeek / 通义千问 / GLM）
- [ ] 用量统计仪表盘
- [ ] 团队/企业账号

---

*如果这篇文章对你有帮助，欢迎点赞、收藏、转发！有任何问题欢迎在评论区留言交流。*
