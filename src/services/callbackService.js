const { uploadClient } = require('../utils/http');
const config = require('../config');
const logger = require('../utils/logger');
const taskQueue = require('../queue/taskQueue');

// 回调待处理队列: [{ task, data }]
const callbackQueue = [];

// 回调重试队列: [{ task, data, retryCount }]
const retryQueue = [];

// 回调成功总计数
let totalSuccessCount = 0;

// 废弃任务总计数（重试超限丢弃）
let totalDroppedCount = 0;

// 每分钟回调次数统计（用于计算速率）
const callbackCountHistory = []; // [{ timestamp: number, count: number }]

function updateCallbackRate() {
  const now = Date.now();
  callbackCountHistory.push({ timestamp: now, count: 1 });
  while (callbackCountHistory.length > 0 && now - callbackCountHistory[0].timestamp > 120000) {
    callbackCountHistory.shift();
  }
}

/**
 * 回调单个结果
 * POST /task/api/json/upload
 * @param {Object} task - 任务对象
 * @param {Object} data - tokege 返回的完整数据
 * @returns {boolean} 是否成功
 * @throws {Error} 网络/服务器错误时抛出，由调用方判断是否为上游故障
 */
async function callbackSingle(task, data) {
  await uploadClient.post('/task/api/json/upload', {
    type: task.type,
    task: {
      shop_id: task.shop_id,
      good_id: task.good_id,
      country: task.country,
      trace_id: task.trace_id,
      content: data && data.response ? data.response : data,
      phone: config.upstream.phone,
      token: task.token,
    },
  }, {
    timeout: config.callbackTimeout,
  });

  // 回调成功，释放去重键
  taskQueue.removeKey(task);
  totalSuccessCount++;
  updateCallbackRate();
  logger.info(`回调成功: shop_id=${task.shop_id} good_id=${task.good_id} (累计成功: ${totalSuccessCount})`);
  return true;
}

/**
 * 将查询成功的结果加入回调队列
 */
function addToCallbackQueue(task, data) {
  callbackQueue.push({ task, data });
}

/**
 * 处理回调队列（独立管道，自有并发控制）
 */
async function processCallbackQueue() {
  if (callbackQueue.length === 0) return { processed: 0, succeeded: 0, failed: 0 };

  const concurrency = config.scheduler.callbackConcurrency;
  const items = callbackQueue.splice(0, callbackQueue.length);
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async ({ task, data }) => {
        try {
          await callbackSingle(task, data);
          succeeded++;
        } catch (err) {
          logger.warn(`回调失败: shop_id=${task.shop_id} good_id=${task.good_id} err=${err.message}`);
          retryQueue.push({ task, data, retryCount: 1 });
          failed++;
        }
      })
    );
  }

  if (items.length > 0) {
    logger.info(`回调处理完成: 成功=${succeeded} 失败=${failed} 回调队列剩余=${callbackQueue.length} 重试队列=${retryQueue.length}`);
  }
  return { processed: items.length, succeeded, failed };
}

/**
 * 将失败的回调加入重试队列
 */
function addToRetryQueue(task, data) {
  retryQueue.push({ task, data, retryCount: 1 });
}

/**
 * 处理回调重试队列
 */
async function processRetryQueue() {
  if (retryQueue.length === 0) return { retried: 0, succeeded: 0, failed: 0, dropped: 0 };

  const maxRetry = config.scheduler.callbackMaxRetry;
  const concurrency = config.scheduler.callbackConcurrency;

  const items = retryQueue.splice(0, retryQueue.length);
  let succeeded = 0;
  let failed = 0;
  let dropped = 0;

  logger.info(`开始回调重试: ${items.length} 条`);

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (item) => {
        try {
          await callbackSingle(item.task, item.data);
          succeeded++;
        } catch (err) {
          logger.warn(`回调重试失败: shop_id=${item.task.shop_id} good_id=${item.task.good_id} err=${err.message}`);
          if (item.retryCount >= maxRetry) {
            taskQueue.removeKey(item.task);
            totalDroppedCount++;
            logger.error(`回调重试超限丢弃: shop_id=${item.task.shop_id} good_id=${item.task.good_id} 已重试${item.retryCount}次`);
            dropped++;
          } else {
            retryQueue.push({ ...item, retryCount: item.retryCount + 1 });
            failed++;
          }
        }
      })
    );
  }

  logger.info(`回调重试完成: 成功=${succeeded} 再次失败=${failed} 丢弃=${dropped} 剩余重试队列=${retryQueue.length}`);
  return { retried: items.length, succeeded, failed, dropped };
}

/**
 * 获取回调队列长度
 */
function getCallbackQueueLength() {
  return callbackQueue.length;
}

/**
 * 获取重试队列长度
 */
function getRetryQueueLength() {
  return retryQueue.length;
}

/**
 * 获取回调成功总数
 */
function getTotalSuccessCount() {
  return totalSuccessCount;
}

/**
 * 获取废弃任务总数
 */
function getTotalDroppedCount() {
  return totalDroppedCount;
}

function getCallbackRatePerMin() {
  const now = Date.now();
  const oneMinAgo = now - 60000;
  const recentCount = callbackCountHistory
    .filter(item => item.timestamp > oneMinAgo)
    .reduce((sum, item) => sum + item.count, 0);
  return recentCount;
}

module.exports = {
  callbackSingle,
  addToCallbackQueue,
  processCallbackQueue,
  addToRetryQueue,
  processRetryQueue,
  getCallbackQueueLength,
  getRetryQueueLength,
  getTotalSuccessCount,
  getTotalDroppedCount,
  getCallbackRatePerMin,
};
