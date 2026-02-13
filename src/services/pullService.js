const { upstreamClient } = require('../utils/http');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * 从上游拉取任务，并将 good_id 转换为 item_id（保留原 good_id）
 * @returns {Array} 转换后的任务数组
 */
async function pullTasks() {
  try {
    const res = await upstreamClient.get('/good/detail/user/list', {
      params: {
        down_stream_vendor_name: config.upstream.vendorName,
        pull_size: config.scheduler.pullSize,
      },
    });

    // 上游返回格式: { code: 200, message: "操作成功", data: [...] }
    const body = res.data;
    const tasks = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : []);

    if (tasks.length === 0) {
      logger.debug('上游返回空任务列表');
      return [];
    }

    // good_id → item_id 转换，同时保留原 good_id
    const converted = tasks.map(task => ({
      shop_id: task.shop_id,
      item_id: task.good_id,   // good_id 转换为 item_id
      good_id: task.good_id,   // 保留原始 good_id 供回调使用
      country: task.country,
      trace_id: task.trace_id,
      add_time: task.add_time,
    }));

    logger.info(`拉取到 ${converted.length} 条任务`);
    return converted;
  } catch (err) {
    logger.warn(`拉取任务失败: ${err.message}`);
    return [];
  }
}

module.exports = { pullTasks };
