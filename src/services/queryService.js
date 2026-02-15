const { tokegeClient } = require('../utils/http');
const config = require('../config');
const logger = require('../utils/logger');

// 需要重试的错误码
const RETRY_ERROR_CODE = 1000000; // Unknown error
const PROCESSING_ERROR_CODE = 1100002; // Product is being processed

// 数据提供方请求统计
const queryStats = {
  totalRequests: 0,
  successCount: 0,      // _success=true 且 data 包含 item
  processingCount: 0,   // HTTP 400, code=1100002（商品处理中）
  failureCount: 0,      // 网络异常或 code=1000000（需重试）
};

/**
 * 检查响应是否包含有效的商品数据
 */
function hasValidItemData(body) {
  try {
    return !!(body && body.response && body.response.data && body.response.data.item);
  } catch {
    return false;
  }
}

/**
 * 查询单个商品详情
 * @param {Object} task - 任务对象
 * @returns {Object} { task, success, data }
 *   success=true  → 查询成功 或 已有明确结果（如1100002），需回调
 *   success=false → 未知错误（1000000）或网络异常，需重试
 */
async function querySingle(task) {
  queryStats.totalRequests++;

  try {
    const res = await tokegeClient.post('/request/shopee/pdp', {
      country: task.country,
      shop_id: task.shop_id,
      item_id: task.item_id,
      language: config.tokege.language,
    });

    const body = res.data;

    if (body && body._success === true) {
      if (hasValidItemData(body)) {
        queryStats.successCount++;
      }
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
        queryStats.failureCount++;
        logger.warn(`查询失败(需重试): shop_id=${task.shop_id} item_id=${task.item_id} code=${errCode} msg=${errMsg}`);
        return { task, success: false, data: null };
      }

      if (errCode === PROCESSING_ERROR_CODE) {
        // code 1100002: Product is being processed → 商品处理中
        queryStats.processingCount++;
        logger.info(`查询返回(商品处理中): shop_id=${task.shop_id} item_id=${task.item_id}`);
        return { task, success: true, data: errBody };
      }

      // 其他错误码 → 不重试，直接回调
      logger.info(`查询返回(${errCode}): shop_id=${task.shop_id} item_id=${task.item_id} msg=${errMsg}`);
      return { task, success: true, data: errBody };
    }

    // 网络错误/超时等无响应体 → 重试
    queryStats.failureCount++;
    logger.warn(`查询网络异常(需重试): shop_id=${task.shop_id} item_id=${task.item_id} err=${err.message}`);
    return { task, success: false, data: null };
  }
}

/**
 * 获取数据提供方请求统计
 */
function getQueryStats() {
  return { ...queryStats };
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

module.exports = { querySingle, batchQuery, getQueryStats };
