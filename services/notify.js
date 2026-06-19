'use strict';

/**
 * Notification service — pushes admin alerts via Server酱 (WeChat).
 *
 * Setup:
 *   1. Go to https://sct.ftqq.com/
 *   2. Scan QR code with WeChat → get SendKey
 *   3. Set SERVERCHAN_SENDKEY in Railway env vars
 *
 * Supports multiple channels in the future (Telegram, email, etc.)
 */

const logger = require('../logger');

/**
 * @param {string} title - Notification title (plain text)
 * @param {string} content - Notification body (markdown supported)
 * @param {string} [sendKey] - Server酱 SendKey, falls back to env var
 * @returns {Promise<boolean>}
 */
async function sendServerChan(title, content, sendKey) {
  const key = sendKey || process.env.SERVERCHAN_SENDKEY || '';
  if (!key) {
    logger.warn('ServerChan SendKey not configured, skipping notification');
    return false;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`https://sctapi.ftqq.com/${key}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title,
        desp: content,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      const result = await response.json();
      if (result.code === 0) {
        logger.info({ title }, 'WeChat notification sent via ServerChan');
        return true;
      } else {
        logger.warn({ result }, 'ServerChan returned error');
        return false;
      }
    } else {
      logger.warn({ status: response.status }, 'ServerChan HTTP error');
      return false;
    }
  } catch (err) {
    logger.error({ err }, 'Failed to send ServerChan notification');
    return false;
  }
}

/**
 * Notify admin about a new payment proof submission.
 *
 * @param {object} params
 * @param {string} params.orderNo
 * @param {string} params.username
 * @param {number} params.amount
 * @param {string} params.packageLabel
 * @param {number} params.points
 * @param {number} params.bonusPoints
 * @param {string} params.transactionId
 * @param {string} [params.proofNote]
 * @param {string} [params.approveToken]
 */
async function notifyNewPaymentProof({ orderNo, username, amount, packageLabel, points, bonusPoints, transactionId, proofNote, approveToken }) {
  const title = `💰 新充值 - ¥${amount}`;
  const totalPoints = points + bonusPoints;

  const content = [
    `**用户**: ${username}`,
    `**订单号**: ${orderNo}`,
    `**套餐**: ${packageLabel}`,
    `**金额**: ¥${amount}`,
    `**点数**: ${totalPoints.toLocaleString()} 点` + (bonusPoints > 0 ? ` (含${bonusPoints}赠送)` : ''),
    `**交易单号**: ${transactionId}`,
  ];

  if (proofNote) {
    content.push(`**备注**: ${proofNote}`);
  }

  content.push('');

  if (approveToken) {
    const approveUrl = `https://deepseek-api-service-production.up.railway.app/approve/${approveToken}`;
    content.push(`[✅ 一键确认收款](${approveUrl})`);
    content.push('');
    content.push(`或打开管理面板: [admin](${approveUrl.replace('/approve/' + approveToken, '/admin')})`);
  } else {
    content.push(`[去管理面板审核](https://deepseek-api-service-production.up.railway.app/admin)`);
  }

  return sendServerChan(title, content.join('\n'));
}

/**
 * Notify admin about a new user registration.
 *
 * @param {object} params
 * @param {string} params.username
 * @param {string} params.inviteCode
 */
async function notifyNewUser({ username, inviteCode }) {
  const title = `👤 新用户注册 - ${username}`;
  const content = [
    `**用户名**: ${username}`,
    `**邀请码**: ${inviteCode}`,
    `**赠送**: 100 点`,
    '',
    `[查看用户列表](https://deepseek-api-service-production.up.railway.app/admin)`,
  ].join('\n');

  return sendServerChan(title, content);
}

module.exports = {
  sendServerChan,
  notifyNewPaymentProof,
  notifyNewUser,
};
