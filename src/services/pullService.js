const { pullClient } = require('../utils/http');
const config = require('../config');
const logger = require('../utils/logger');

// 拉取统计
const pullStats = {
  totalPulled: 0,
  pullExpired: 0,
};

// 每分钟拉取次数统计（用于计算速率）
const pullCountHistory = []; // [{ timestamp: number, count: number }]

function updatePullRate() {
  const now = Date.now();
  pullCountHistory.push({ timestamp: now, count: 1 });
  while (pullCountHistory.length > 0 && now - pullCountHistory[0].timestamp > 120000) {
    pullCountHistory.shift();
  }
}

/**
 * 从上游拉取单个任务
 * GET /api/get/task?phone=xxx
 * @returns {Object|null} 转换后的任务对象，无任务返回 null
 */
async function pullSingleTask() {
  try {
    const res = await pullClient.get('/api/get/task', {
      params: {
        phone: config.upstream.phone,
      },
    });

    const body = res.data;

    // 响应格式: { code: 200, success: true, task: { type, data: { ... } } }
    if (!body || !body.success || !body.task || !body.task.data) {
      return null;
    }

    const taskData = body.task.data;
    const taskType = body.task.type;

    // 检查任务是否超时（created_at 超过24分钟则丢弃）
    if (taskData.created_at) {
      const createdTime = new Date(taskData.created_at).getTime();
      if (Date.now() - createdTime > config.scheduler.pullTaskTimeout) {
        pullStats.pullExpired++;
        logger.info(`拉取任务已超时丢弃: shop_id=${taskData.shop_id} good_id=${taskData.good_id} created_at=${taskData.created_at}`);
        return null;
      }
    }

    pullStats.totalPulled++;
    updatePullRate();

    return {
      shop_id: taskData.shop_id,
      item_id: taskData.good_id,   // good_id 转换为 item_id（tokege 查询使用）
      good_id: taskData.good_id,   // 保留原始 good_id 供回调使用
      country: taskData.country,
      trace_id: taskData.trace_id,
      type: taskType,              // 保留任务类型供回调使用
      created_at: taskData.created_at,
      token: taskData.token,
    };
  } catch (err) {
    logger.warn(`拉取任务失败: ${err.message}`);
    return null;
  }
}

/**
 * 获取拉取统计
 */
function getPullStats() {
  const now = Date.now();
  const oneMinAgo = now - 60000;
  const recentCount = pullCountHistory
    .filter(item => item.timestamp > oneMinAgo)
    .reduce((sum, item) => sum + item.count, 0);
  return { ...pullStats, pullRatePerMin: recentCount };
}

module.exports = { pullSingleTask, getPullStats };
