const express = require('express');
const taskQueue = require('../queue/taskQueue');
const { getRetryQueueLength, getTotalSuccessCount, getCallbackQueueLength } = require('../services/callbackService');
const auditService = require('../services/auditService');

const router = express.Router();

// 健康检查
router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// 状态监控
router.get('/stats', (req, res) => {
  res.json({
    queue: taskQueue.getStats(),
    callbackQueue: getCallbackQueueLength(),
    callbackRetryQueue: getRetryQueueLength(),
    callbackTotalSuccess: getTotalSuccessCount(),
    memory: process.memoryUsage(),
    uptime: process.uptime(),
  });
});

// 审计 - 按 trace_id 查询
router.get('/audit/trace/:traceId', async (req, res) => {
  try {
    const rows = await auditService.findByTraceId(req.params.traceId);
    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 审计 - 按 shop_id + good_id 查询
router.get('/audit/shop/:shopId/good/:goodId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const rows = await auditService.findByShopAndGood(req.params.shopId, req.params.goodId, limit);
    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 审计 - 统计信息
router.get('/audit/stats', async (req, res) => {
  try {
    const stats = await auditService.getStats();
    res.json({ ok: true, ...stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
