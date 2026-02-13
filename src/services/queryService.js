const { tokegeClient } = require('../utils/http');
const config = require('../config');
const logger = require('../utils/logger');

// 需要重试的错误码
const RETRY_ERROR_CODE = 1000000; // Unknown error

/**
 * 查询单个商品详情
 * @param {Object} task - 任务对象
 * @returns {Object} { task, success, data }
 *   success=true  → 查询成功 或 已有明确结果（如1100002），需回调
 *   success=false → 未知错误（1000000）或网络异常，需重试
 */
async function querySingle(task) {
  try {
    const res = await tokegeClient.post('/request/shopee/pdp', {
      country: task.country,
      shop_id: task.shop_id,
      item_id: task.item_id,
      language: config.tokege.language,
    });

    const body = res.data;

    if (body && body._success === true) {
      return { task, success: true, data: body };
    }

    // HTTP 200 但 _success=false，当作有结果，直接回调
    logger.info(`查询返回(_success=false): shop_id=${task.shop_id} item_id=${task.item_id}`);
    return { task, success: true, data: body };
  } catch (err) {
    // HTTP 400 等错误，检查响应体中的错误码
    if (err.response && err.response.data) {
      const errBody = err.response.data;
      const errCode = errBody.error && errBody.error.code;
      const errMsg = errBody.error && errBody.error.message;

      if (errCode === RETRY_ERROR_CODE) {
        // code 1000000: Unknown error → 重试
        logger.warn(`查询失败(需重试): shop_id=${task.shop_id} item_id=${task.item_id} code=${errCode} msg=${errMsg}`);
        return { task, success: false, data: null };
      }

      // 其他错误码（如 1100002 Product is being processed）→ 不重试，直接回调
      logger.info(`查询返回(${errCode}): shop_id=${task.shop_id} item_id=${task.item_id} msg=${errMsg}`);
      return { task, success: true, data: errBody };
    }

    // 网络错误/超时等无响应体 → 重试
    logger.warn(`查询网络异常(需重试): shop_id=${task.shop_id} item_id=${task.item_id} err=${err.message}`);
    return { task, success: false, data: null };
  }
}

/**
 * 批量查询商品详情（并发控制）
 * @param {Array} tasks - 任务数组
 * @returns {Object} { successes: [{task, data}], failures: [task] }
 */
async function batchQuery(tasks) {
  const concurrency = config.scheduler.queryConcurrency;
  const successes = [];
  const failures = [];

  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(task => querySingle(task)));

    for (const result of results) {
      if (result.success) {
        successes.push({ task: result.task, data: result.data });
      } else {
        failures.push(result.task);
      }
    }
  }

  logger.info(`批量查询完成: 回调=${successes.length} 重试=${failures.length}`);
  return { successes, failures };
}

module.exports = { querySingle, batchQuery };
