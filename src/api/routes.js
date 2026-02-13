const express = require('express');
const taskQueue = require('../queue/taskQueue');
const { getRetryQueueLength, getTotalSuccessCount, getCallbackQueueLength } = require('../services/callbackService');

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

module.exports = router;
