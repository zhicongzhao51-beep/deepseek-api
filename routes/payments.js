'use strict';

const express = require('express');
const config = require('../config');
const logger = require('../logger');
const mw = require('../middleware');
const xorpay = require('../services/xorpay');

const router = express.Router();

// ── Helpers ─────────────────────────────────────────────────

/**
 * Generate a human-readable order number.
 * Format: ORD-YYYYMMDD-XXXX (6 random chars)
 * @returns {string}
 */
function generateOrderNo() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `ORD-${date}-${rand}`;
}

// ── Routes: Public ──────────────────────────────────────────

/**
 * GET /api/payments/packages
 * Returns available recharge packages. No auth required.
 */
router.get('/packages', (_req, res) => {
  res.json({
    success: true,
    data: {
      currency: 'cny',
      packages: config.pointsPackages,
    },
  });
});

// ── Routes: Authenticated (API Key) ─────────────────────────

const requireAuth = mw.requireApiKey({ getUserByApiKey: require('../db').getUserByApiKey });

/**
 * POST /api/payments/create-order
 * Creates a payment order and returns XorPay QR code URL.
 * Requires valid API key.
 */
router.post('/create-order',
  mw.authLimiter,
  requireAuth,
  mw.validate(mw.schemas.createPaymentOrderSchema),
  async (req, res) => {
    const { package_id } = req.body;
    const db = require('../db');

    // Find the selected package
    const pkg = config.pointsPackages.find(p => p.id === package_id);
    if (!pkg) {
      return res.status(400).json({ success: false, error: '无效的套餐 ID' });
    }

    // Generate order
    const orderNo = generateOrderNo();

    try {
      // Create order in DB (status: pending)
      db.createPaymentOrder(req.user.id, pkg, orderNo);

      // Call XorPay to get QR code
      const result = await xorpay.createPayment({
        appId: config.xorpayAppId,
        appSecret: config.xorpayAppSecret,
        orderNo,
        amount: pkg.amount,
        notifyUrl: config.xorpayNotifyUrl,
        name: `DeepSeek API - ${pkg.label}`,
      });

      // Update with provider charge_id (still pending, just linking)
      db.getPaymentOrder(orderNo); // ensure it exists

      logger.info({
        userId: req.user.id,
        orderNo,
        packageId: package_id,
        amount: pkg.amount,
        points: pkg.points,
        requestId: req.requestId,
      }, 'Payment order created');

      res.json({
        success: true,
        data: {
          order_no: orderNo,
          package_label: pkg.label,
          amount: pkg.amount,
          points: pkg.points,
          bonus_points: pkg.bonus || 0,
          qr_url: result.qr_url,
          charge_id: result.charge_id,
        },
      });
    } catch (err) {
      logger.error({ err, orderNo, userId: req.user.id, requestId: req.requestId }, 'Failed to create payment order');
      res.status(500).json({ success: false, error: '创建支付订单失败，请稍后重试' });
    }
  }
);

/**
 * GET /api/payments/order/:orderNo
 * Query order status. Used by frontend polling.
 */
router.get('/order/:orderNo', requireAuth, (req, res) => {
  const db = require('../db');
  const order = db.getPaymentOrder(req.params.orderNo);

  if (!order) {
    return res.status(404).json({ success: false, error: '订单不存在' });
  }

  // Only the owner or admin can view
  if (order.user_id !== req.user.id) {
    return res.status(403).json({ success: false, error: '无权查看此订单' });
  }

  res.json({
    success: true,
    data: {
      order_no: order.order_no,
      package_id: order.package_id,
      amount: order.amount,
      points: order.points,
      bonus_points: order.bonus_points,
      status: order.status,
      paid_at: order.paid_at,
      created_at: order.created_at,
    },
  });
});

/**
 * GET /api/payments/orders
 * List user's payment orders (history).
 */
router.get('/orders', requireAuth, (req, res) => {
  const db = require('../db');
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;

  const orders = db.getUserPaymentOrders(req.user.id, limit, offset);

  res.json({
    success: true,
    data: { orders },
  });
});

// ── Routes: Webhook (XorPay signature) ─────────────────────

/**
 * POST /api/payments/notify
 * XorPay payment callback.
 * No API key required — verified by XorPay MD5 signature.
 *
 * IMPORTANT: This route needs the raw body for signature verification.
 * The raw body is captured via express.json({ verify: ... }) in server.js
 * and stored in req.rawBody.
 */
router.post('/notify', (req, res) => {
  const db = require('../db');

  // Parse raw body for signature verification
  /** @type {string|Buffer|undefined} */
  const rawBody = req.rawBody;
  if (!rawBody) {
    logger.error('Payment notify: missing raw body');
    return res.status(400).send('fail');
  }

  // Parse the form-encoded callback body
  let params;
  try {
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    params = Object.fromEntries(new URLSearchParams(bodyStr));
  } catch (err) {
    logger.error({ err }, 'Payment notify: failed to parse body');
    return res.status(400).send('fail');
  }

  const receivedSign = params.sign;
  if (!receivedSign) {
    logger.error('Payment notify: missing sign');
    return res.status(400).send('fail');
  }

  // Remove sign from params for verification
  const { sign: _sign, ...paramsWithoutSign } = params;

  // Verify signature
  if (!xorpay.verifySignature(paramsWithoutSign, receivedSign, config.xorpayAppSecret)) {
    logger.error({ orderNo: params.out_trade_no }, 'Payment notify: invalid signature');
    return res.status(403).send('fail');
  }

  const orderNo = params.out_trade_no;
  const chargeId = params.charge_id || '';
  const totalFee = parseInt(params.total_fee) || 0;

  // Look up order
  const order = db.getPaymentOrder(orderNo);
  if (!order) {
    logger.error({ orderNo }, 'Payment notify: order not found');
    return res.status(404).send('fail');
  }

  // Verify amount matches (prevent tampering)
  const expectedFee = Math.round(order.amount * 100); // cents
  if (totalFee !== expectedFee) {
    logger.error({ orderNo, expectedFee, receivedFee: totalFee }, 'Payment notify: amount mismatch');
    return res.status(400).send('fail');
  }

  // Idempotent completion: only process if pending
  const completed = db.completePaymentOrder(orderNo, chargeId);
  if (!completed) {
    // Already processed — return success to stop XorPay retry
    logger.info({ orderNo }, 'Payment notify: order already processed (idempotent)');
    return res.send('success');
  }

  // Add points to user balance (atomic with order completion)
  db.addBalance(order.user_id, order.points + (order.bonus_points || 0));

  logger.info({
    orderNo,
    userId: order.user_id,
    amount: order.amount,
    points: order.points,
    bonus: order.bonus_points,
    chargeId,
  }, 'Payment completed successfully');

  res.send('success');
});

module.exports = router;
