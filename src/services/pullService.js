const { pullClient } = require('../utils/http');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * 从上游拉取单个任务
 * GET /api/get/newtask?phone=xxx&country=xxx
 * @returns {Object|null} 转换后的任务对象，无任务返回 null
 */
async function pullSingleTask() {
  try {
    const res = await pullClient.get('/api/get/newtask', {
      params: {
        phone: config.upstream.phone,
        country: config.upstream.country,
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
        logger.info(`拉取任务已超时丢弃: shop_id=${taskData.shop_id} good_id=${taskData.good_id} created_at=${taskData.created_at}`);
        return null;
      }
    }

    return {
      shop_id: taskData.shop_id,
      item_id: taskData.good_id,   // good_id 转换为 item_id（tokege 查询使用）
      good_id: taskData.good_id,   // 保留原始 good_id 供回调使用
      country: taskData.country,
      trace_id: taskData.trace_id,
      type: taskType,              // 保留任务类型供回调使用
      created_at: taskData.created_at,
    };
  } catch (err) {
    logger.warn(`拉取任务失败: ${err.message}`);
    return null;
  }
}

module.exports = { pullSingleTask };
