'use strict';

const crypto = require('crypto');

const XORPAY_API = 'https://xorpay.com/api/pay';

/**
 * Generate MD5 signature for XorPay.
 * Algorithm: sort param keys alphabetically, concat values, append app_secret, MD5.
 *
 * @param {object} params - Key-value pairs to sign
 * @param {string} appSecret - XorPay app secret
 * @returns {string} MD5 hex signature
 */
function sign(params, appSecret) {
  const sortedKeys = Object.keys(params).sort();
  const raw = sortedKeys.map(k => String(params[k] || '')).join('') + appSecret;
  return crypto.createHash('md5').update(raw, 'utf8').digest('hex');
}

/**
 * Create a payment order via XorPay API.
 * Returns QR code URL for the user to scan.
 *
 * @param {object} opts
 * @param {string} opts.appId - XorPay app ID
 * @param {string} opts.appSecret - XorPay app secret
 * @param {string} opts.orderNo - Our internal order number
 * @param {number} opts.amount - Amount in CNY yuan (e.g. 10.00)
 * @param {string} opts.notifyUrl - Callback URL for payment notification
 * @param {string} [opts.name] - Payment description
 * @returns {Promise<{ qr_url: string, charge_id: string }>}
 */
async function createPayment({ appId, appSecret, orderNo, amount, notifyUrl, name }) {
  const params = {
    appid: appId,
    out_trade_no: orderNo,
    total_fee: Math.round(amount * 100), // XorPay expects amount in cents (分)
    notify_url: notifyUrl,
    name: name || `充值 ${amount} 元`,
    pay_type: 'native', // QR code payment
  };

  params.sign = sign(params, appSecret);

  const body = new URLSearchParams(params).toString();

  const response = await fetch(XORPAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`XorPay API error (${response.status}): ${errText}`);
  }

  const data = await response.json();

  if (data.status !== 'ok') {
    throw new Error(`XorPay error: ${data.info || JSON.stringify(data)}`);
  }

  return {
    qr_url: data.qr_url || data.pay_url || '',
    charge_id: data.charge_id || data.order_id || '',
  };
}

/**
 * Verify XorPay callback signature.
 * The callback includes all params + a `sign` field. Recompute and compare.
 *
 * @param {object} params - All callback params (excluding sign)
 * @param {string} receivedSign - The sign value from the callback
 * @param {string} appSecret - XorPay app secret
 * @returns {boolean} true if signature matches
 */
function verifySignature(params, receivedSign, appSecret) {
  const computed = sign(params, appSecret);
  return crypto.timingSafeEqual(
    Buffer.from(computed, 'utf8'),
    Buffer.from(receivedSign, 'utf8')
  );
}

module.exports = { createPayment, verifySignature, sign };
