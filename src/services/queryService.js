const { tokegeClient } = require('../utils/http');
const config = require('../config');
const logger = require('../utils/logger');

// 需要重试的错误码（视为正常，API 在工作）
const RETRY_HEALTHY_CODES = [
  1100002  // Product is being processed
];

// 需要重试的错误码（视为异常，计入健康检测）
const RETRY_UNHEALTHY_CODES = [
  1000000, // Unknown error — API 端异常
];

// 额度耗尽错误码 → 不重试，不回调，不算下架
const CREDIT_EXHAUSTED_CODES = [
  1070102,  // Insufficient credit
];

// 数据请求统计
const queryStats = {
  totalRequests: 0,     // 总请求数（包括重试）
  successCount: 0,      // 查询成功（_success=true 且有 item 数据）
  failureCount: 0,      // 查询失败（需要重试的请求：1000000、1100002、网络异常）
  offlineCount: 0,      // 商品下架（_success=false 无 item、其他错误码等）
  processingCount: 0,   // 商品处理中的次数（1100002，包含在 failureCount 中）
  creditExhaustedCount: 0, // 额度耗尽次数
};

// 每分钟查询次数统计（按秒聚合桶，避免高 QPS 下 O(n) shift）
const queryRateBuckets = new Map(); // secondTimestamp -> count

function updateQueryRate() {
  const sec = Math.floor(Date.now() / 1000);
  queryRateBuckets.set(sec, (queryRateBuckets.get(sec) || 0) + 1);
}

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
 * @returns {Object} { task, success, data, creditExhausted, processing }
 *   success=true  → 查询成功，需回调
 *   success=false → 未知错误（1000000）、商品处理中（1100002），需重试
 *   processing=true → 商品处理中（1100002），健康检测视为正常
 * @throws {Error} 网络错误/超时等无响应体时抛出，由调用方处理健康检测
 */
async function querySingle(task) {
  queryStats.totalRequests++;
  updateQueryRate();

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
        return { task, success: true, data: body };
      }
    }

    // HTTP 200 但 _success=false 或无 item 数据，当作商品下架，直接回调
    queryStats.offlineCount++;
    logger.info(`查询返回(商品下架): shop_id=${task.shop_id} item_id=${task.item_id}`);
    return { task, success: true, data: body };
  } catch (err) {
    // HTTP 400 等错误，检查响应体中的错误码
    if (err.response && err.response.data) {
      const errBody = err.response.data;
      const errCode = errBody.error && errBody.error.code;
      const errMsg = errBody.error && errBody.error.message;

      // 商品处理中 → 正常返回，健康检测视为正常
      if (RETRY_HEALTHY_CODES.includes(errCode)) {
        queryStats.failureCount++;
        queryStats.processingCount++;
        logger.warn(`查询失败(商品处理中，需重试): shop_id=${task.shop_id} item_id=${task.item_id}`);
        return { task, success: false, data: null, processing: true };
      }

      // Unknown error 等 → 抛出，健康检测视为异常，scheduler 负责重试
      if (RETRY_UNHEALTHY_CODES.includes(errCode)) {
        queryStats.failureCount++;
        logger.warn(`查询失败(API异常，需重试): shop_id=${task.shop_id} item_id=${task.item_id} code=${errCode} msg=${errMsg}`);
        throw err;
      }

      // 检查是否为额度耗尽
      if (CREDIT_EXHAUSTED_CODES.includes(errCode)) {
        queryStats.creditExhaustedCount++;
        logger.warn(`查询失败(额度耗尽): shop_id=${task.shop_id} item_id=${task.item_id} code=${errCode} msg=${errMsg}`);
        return { task, success: false, data: null, creditExhausted: true };
      }

      // 其他错误码 → 不重试，当作商品下架，直接回调
      queryStats.offlineCount++;
      logger.info(`查询返回(商品下架): shop_id=${task.shop_id} item_id=${task.item_id} code=${errCode} msg=${errMsg}`);
      return { task, success: true, data: errBody };
    }

    // 网络错误/超时等无响应体 → 抛出，由 scheduler 处理健康检测
    queryStats.failureCount++;
    throw err;
  }
}

/**
 * 获取数据请求统计
 */
function getQueryStats() {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 120;
  let ratePerMin = 0;
  for (const [sec, count] of queryRateBuckets) {
    if (sec < cutoff) {
      queryRateBuckets.delete(sec);
    } else if (sec >= now - 60) {
      ratePerMin += count;
    }
  }
  return { ...queryStats, queryRatePerMin: ratePerMin };
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
