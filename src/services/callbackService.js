const { upstreamClient } = require('../utils/http');
const config = require('../config');
const logger = require('../utils/logger');
const taskQueue = require('../queue/taskQueue');

// 回调重试队列: [{ task, data, retryCount }]
const retryQueue = [];

// 回调成功总计数
let totalSuccessCount = 0;

/**
 * 回调单个结果
 * @param {Object} task - 任务对象
 * @param {Object} data - tokege 返回的完整数据
 * @returns {boolean} 是否成功
 */
async function callbackSingle(task, data) {
  try {
    await upstreamClient.post('/good/detail/user/callback/result', {
      shop_id: task.shop_id,
      good_id: task.good_id,
      country: task.country,
      trace_id: task.trace_id,
      down_stream_vendor_name: config.upstream.vendorName,
      content: JSON.stringify(data),
    }, {
      timeout: config.callbackTimeout, // 回调专用超时 60s
    });

    // 回调成功，释放去重键
    taskQueue.removeKey(task);
    totalSuccessCount++;
    logger.info(`回调成功: shop_id=${task.shop_id} good_id=${task.good_id} (累计成功: ${totalSuccessCount})`);
    return true;
  } catch (err) {
    logger.warn(`回调失败: shop_id=${task.shop_id} good_id=${task.good_id} err=${err.message}`);
    return false;
  }
}

/**
 * 将失败的回调加入重试队列
 */
function addToRetryQueue(task, data) {
  retryQueue.push({ task, data, retryCount: 1 });
}

/**
 * 批量回调结果（并发控制），失败的进入重试队列
 * @param {Array} results - [{ task, data }] 数组
 * @returns {Object} { successCount, failCount }
 */
async function batchCallback(results) {
  const concurrency = config.scheduler.callbackConcurrency;
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < results.length; i += concurrency) {
    const batch = results.slice(i, i + concurrency);
    const outcomes = await Promise.all(
      batch.map(async ({ task, data }) => {
        const ok = await callbackSingle(task, data);
        if (!ok) {
          // 失败，放入重试队列
          retryQueue.push({ task, data, retryCount: 1 });
        }
        return ok;
      })
    );

    for (const ok of outcomes) {
      if (ok) successCount++;
      else failCount++;
    }
  }

  logger.info(`批量回调完成: 成功=${successCount} 失败=${failCount} 重试队列=${retryQueue.length}`);
  return { successCount, failCount };
}

/**
 * 处理回调重试队列
 * @returns {Object} { retried, succeeded, failed, dropped }
 */
async function processRetryQueue() {
  if (retryQueue.length === 0) return { retried: 0, succeeded: 0, failed: 0, dropped: 0 };

  const maxRetry = config.scheduler.callbackMaxRetry;
  const concurrency = config.scheduler.callbackConcurrency;

  // 取出当前所有待重试项
  const items = retryQueue.splice(0, retryQueue.length);
  let succeeded = 0;
  let failed = 0;
  let dropped = 0;

  logger.info(`开始回调重试: ${items.length} 条`);

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (item) => {
        const ok = await callbackSingle(item.task, item.data);
        if (ok) {
          succeeded++;
        } else if (item.retryCount >= maxRetry) {
          // 超过最大重试次数，丢弃并释放去重键
          taskQueue.removeKey(item.task);
          logger.error(`回调重试超限丢弃: shop_id=${item.task.shop_id} good_id=${item.task.good_id} 已重试${item.retryCount}次`);
          dropped++;
        } else {
          // 继续放回重试队列
          retryQueue.push({ ...item, retryCount: item.retryCount + 1 });
          failed++;
        }
      })
    );
  }

  logger.info(`回调重试完成: 成功=${succeeded} 再次失败=${failed} 丢弃=${dropped} 剩余重试队列=${retryQueue.length}`);
  return { retried: items.length, succeeded, failed, dropped };
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

module.exports = { callbackSingle, addToRetryQueue, batchCallback, processRetryQueue, getRetryQueueLength, getTotalSuccessCount };
