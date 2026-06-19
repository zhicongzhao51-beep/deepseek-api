'use strict';

const express = require('express');
const config = require('../config');
const logger = require('../logger');
const mw = require('../middleware');
const xorpay = require('../services/xorpay');

const router = express.Router();

// ── Helpers ─────────────────────────────────────────────────

function generateOrderNo() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `ORD-${date}-${rand}`;
}

// ── Routes: Public ──────────────────────────────────────────

router.get('/packages', (_req, res) => {
  res.json({
    success: true,
    data: {
      currency: 'cny',
      packages: config.pointsPackages,
      payment_methods: [
        {
          id: 'manual',
          name: '线下转账',
          description: '向管理员转账后提交凭证，管理员确认后到账',
          payee: config.manualPaymentInfo || '请联系管理员获取收款信息',
        },
        {
          id: 'xorpay',
          name: '在线支付',
          description: '微信/支付宝扫码支付，自动到账',
          available: !!(config.xorpayAppId && config.xorpayAppSecret),
        },
      ],
    },
  });
});

// ── Routes: Authenticated (API Key) ─────────────────────────

const requireAuth = mw.requireApiKey({ getUserByApiKey: require('../db').getUserByApiKey });

/**
 * POST /api/payments/create-order
 * Creates a payment order. Supports 'manual' (offline) and 'xorpay' (auto) methods.
 */
router.post('/create-order',
  mw.authLimiter,
  requireAuth,
  mw.validate(mw.schemas.createPaymentOrderSchema),
  async (req, res) => {
    const { package_id, method } = req.body;
    const db = require('../db');
    const paymentMethod = method || 'manual';

    const pkg = config.pointsPackages.find(p => p.id === package_id);
    if (!pkg) {
      return res.status(400).json({ success: false, error: '无效的套餐 ID' });
    }

    const orderNo = generateOrderNo();

    try {
      if (paymentMethod === 'xorpay') {
        // ── XorPay Online Payment ──
        if (!config.xorpayAppId || !config.xorpayAppSecret) {
          return res.status(400).json({ success: false, error: '在线支付暂未开通，请使用线下转账' });
        }

        db.createPaymentOrder(req.user.id, pkg, orderNo, 'xorpay');

        const result = await xorpay.createPayment({
          appId: config.xorpayAppId,
          appSecret: config.xorpayAppSecret,
          orderNo,
          amount: pkg.amount,
          notifyUrl: config.xorpayNotifyUrl,
          name: `DeepSeek API - ${pkg.label}`,
        });

        logger.info({ userId: req.user.id, orderNo, method: 'xorpay', amount: pkg.amount, requestId: req.requestId }, 'XorPay order created');

        res.json({
          success: true,
          data: {
            order_no: orderNo,
            method: 'xorpay',
            package_label: pkg.label,
            amount: pkg.amount,
            points: pkg.points,
            bonus_points: pkg.bonus || 0,
            qr_url: result.qr_url,
            charge_id: result.charge_id,
          },
        });
      } else {
        // ── Manual/Offline Payment ──
        db.createPaymentOrder(req.user.id, pkg, orderNo, 'manual');

        logger.info({ userId: req.user.id, orderNo, method: 'manual', amount: pkg.amount, requestId: req.requestId }, 'Manual payment order created');

        res.json({
          success: true,
          data: {
            order_no: orderNo,
            method: 'manual',
            package_label: pkg.label,
            amount: pkg.amount,
            points: pkg.points,
            bonus_points: pkg.bonus || 0,
            payee_info: config.manualPaymentInfo || '请联系管理员获取收款信息',
            next_step: '完成转账后，请提交转账凭证（交易单号或截图说明）',
          },
        });
      }
    } catch (err) {
      logger.error({ err, orderNo, userId: req.user.id, requestId: req.requestId }, 'Failed to create payment order');
      res.status(500).json({ success: false, error: '创建支付订单失败，请稍后重试' });
    }
  }
);

/**
 * POST /api/payments/submit-proof
 * User submits payment proof for a manual order.
 */
router.post('/submit-proof',
  mw.authLimiter,
  requireAuth,
  mw.validate(mw.schemas.submitProofSchema),
  (req, res) => {
    const db = require('../db');
    const { order_no, transaction_id, proof_note } = req.body;

    const order = db.getPaymentOrder(order_no);
    if (!order) {
      return res.status(404).json({ success: false, error: '订单不存在' });
    }
    if (order.user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: '无权操作此订单' });
    }
    if (order.provider !== 'manual') {
      return res.status(400).json({ success: false, error: '此订单为在线支付订单，无需提交凭证' });
    }
    if (order.status !== 'pending') {
      return res.status(400).json({ success: false, error: '订单状态不允许提交凭证' });
    }

    db.submitPaymentProof(order_no, transaction_id, proof_note);

    logger.info({ userId: req.user.id, orderNo: order_no, transactionId: transaction_id, requestId: req.requestId }, 'Payment proof submitted');

    res.json({
      success: true,
      message: '凭证已提交，请等待管理员审核',
      data: { order_no, status: 'submitted' },
    });
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
      provider: order.provider,
      transaction_id: order.transaction_id,
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

// ── Routes: Admin Order Review ─────────────────────────────

/**
 * GET /api/payments/admin/pending
 * Admin: list orders awaiting review (submitted manual payments).
 */
router.get('/admin/pending', mw.adminLimiter, mw.requireAdmin, (_req, res) => {
  const db = require('../db');
  const orders = db.getPendingProofOrders();
  res.json({ success: true, data: { orders } });
});

/**
 * POST /api/payments/admin/approve
 * Admin: approve a manual payment order (adds points to user).
 */
router.post('/admin/approve',
  mw.adminLimiter,
  mw.requireAdmin,
  mw.validate(mw.schemas.approveOrderSchema),
  (req, res) => {
    const db = require('../db');
    const { order_no } = req.body;

    const result = db.adminApproveOrder(order_no);
    if (!result) {
      return res.status(400).json({ success: false, error: '订单不存在或状态不允许审核' });
    }

    logger.info({ orderNo: order_no, userId: result.userId, points: result.points }, 'Admin approved payment order');

    res.json({
      success: true,
      message: `已确认收款，${result.points} 点已到账`,
      data: { order_no, points_added: result.points },
    });
  }
);

/**
 * POST /api/payments/admin/reject
 * Admin: reject a manual payment proof (returns order to pending).
 */
router.post('/admin/reject',
  mw.adminLimiter,
  mw.requireAdmin,
  mw.validate(mw.schemas.approveOrderSchema),
  (req, res) => {
    const db = require('../db');
    const { order_no } = req.body;

    db.adminRejectOrder(order_no);

    logger.info({ orderNo: order_no }, 'Admin rejected payment proof');

    res.json({
      success: true,
      message: '已驳回，订单恢复为待支付状态',
      data: { order_no },
    });
  }
);

// ── Routes: Webhook (XorPay signature) ─────────────────────

router.post('/notify', (req, res) => {
  const db = require('../db');

  const rawBody = req.rawBody;
  if (!rawBody) {
    logger.error('Payment notify: missing raw body');
    return res.status(400).send('fail');
  }

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

  const { sign: _sign, ...paramsWithoutSign } = params;

  if (!xorpay.verifySignature(paramsWithoutSign, receivedSign, config.xorpayAppSecret)) {
    logger.error({ orderNo: params.out_trade_no }, 'Payment notify: invalid signature');
    return res.status(403).send('fail');
  }

  const orderNo = params.out_trade_no;
  const chargeId = params.charge_id || '';
  const totalFee = parseInt(params.total_fee) || 0;

  const order = db.getPaymentOrder(orderNo);
  if (!order) {
    logger.error({ orderNo }, 'Payment notify: order not found');
    return res.status(404).send('fail');
  }

  const expectedFee = Math.round(order.amount * 100);
  if (totalFee !== expectedFee) {
    logger.error({ orderNo, expectedFee, receivedFee: totalFee }, 'Payment notify: amount mismatch');
    return res.status(400).send('fail');
  }

  const completed = db.completePaymentOrder(orderNo, chargeId);
  if (!completed) {
    logger.info({ orderNo }, 'Payment notify: order already processed (idempotent)');
    return res.send('success');
  }

  db.addBalance(order.user_id, order.points + (order.bonus_points || 0));

  logger.info({
    orderNo, userId: order.user_id, amount: order.amount,
    points: order.points, bonus: order.bonus_points, chargeId,
  }, 'Payment completed successfully (XorPay)');

  res.send('success');
});

module.exports = router;
