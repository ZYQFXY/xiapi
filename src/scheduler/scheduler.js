const config = require('../config');
const logger = require('../utils/logger');
const taskQueue = require('../queue/taskQueue');
const { pullTasks } = require('../services/pullService');
const { querySingle } = require('../services/queryService');
const {
  addToCallbackQueue,
  processCallbackQueue,
  processRetryQueue,
  getTotalSuccessCount,
  getCallbackQueueLength,
  getRetryQueueLength,
} = require('../services/callbackService');

let pullTimer = null;
let queryTimer = null;
let callbackProcessTimer = null;
let cleanupTimer = null;
let callbackRetryTimer = null;
let queryRunning = false;
let callbackRunning = false;
let sleeping = false;

/**
 * 进入休眠模式：停止拉取新任务
 */
function enterSleepMode() {
  if (sleeping) return;
  sleeping = true;

  if (pullTimer) {
    clearInterval(pullTimer);
    pullTimer = null;
  }

  logger.info(`=== 进入休眠模式 === 回调成功已达 ${config.scheduler.callbackSuccessLimit} 条，停止拉取新任务，处理剩余队列`);
}

/**
 * 拉取循环：从上游拉取任务
 */
async function pullLoop() {
  try {
    const tasks = await pullTasks();
    if (tasks.length > 0) {
      taskQueue.enqueue(tasks);
    }
  } catch (err) {
    logger.warn(`pullLoop 异常: ${err.message}`);
  }
}

/**
 * 查询循环（独立管道）：
 * 从 taskQueue 取出任务 → 查询 tokege → 成功结果推入 callbackQueue，失败重入 taskQueue
 */
async function queryLoop() {
  if (queryRunning) {
    logger.debug('查询管道正在执行中，跳过本次');
    return;
  }

  // 检查是否需要进入休眠
  if (!sleeping && getTotalSuccessCount() >= config.scheduler.callbackSuccessLimit) {
    enterSleepMode();
  }

  const pending = taskQueue.pendingCount;

  if (sleeping) {
    if (pending === 0) {
      logger.debug('休眠模式: 任务队列已空');
      return;
    }
  } else {
    if (pending < config.scheduler.batchSize) {
      logger.debug(`任务队列 ${pending}/${config.scheduler.batchSize}，未达阈值`);
      return;
    }
  }

  queryRunning = true;
  try {
    const count = sleeping ? pending : config.scheduler.batchSize;
    const tasks = taskQueue.dequeue(count);
    logger.info(`[查询管道] 开始: ${tasks.length} 条任务${sleeping ? ' (休眠模式)' : ''}`);

    const concurrency = config.scheduler.queryConcurrency;
    let queryOk = 0;
    const retryTasks = [];

    for (let i = 0; i < tasks.length; i += concurrency) {
      const batch = tasks.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(task => querySingle(task)));

      for (const result of results) {
        if (result.success) {
          addToCallbackQueue(result.task, result.data);
          queryOk++;
        } else {
          retryTasks.push(result.task);
        }
      }
    }

    if (retryTasks.length > 0) {
      taskQueue.requeue(retryTasks);
    }

    logger.info(`[查询管道] 完成: 查询成功=${queryOk} 重试=${retryTasks.length} 回调队列=${getCallbackQueueLength()}`);
  } catch (err) {
    logger.error(`queryLoop 异常: ${err.message}`);
  } finally {
    queryRunning = false;
  }
}

/**
 * 回调处理循环（独立管道）：
 * 从 callbackQueue 取出结果 → 回调上游，失败进入重试队列
 */
async function callbackProcessLoop() {
  if (callbackRunning) return;

  callbackRunning = true;
  try {
    await processCallbackQueue();

    // 回调后检查休眠
    if (!sleeping && getTotalSuccessCount() >= config.scheduler.callbackSuccessLimit) {
      enterSleepMode();
    }
  } catch (err) {
    logger.error(`callbackProcessLoop 异常: ${err.message}`);
  } finally {
    callbackRunning = false;
  }
}

/**
 * 清理循环：每30秒清理超时任务
 */
function cleanupLoop() {
  const purged = taskQueue.purgeExpired(config.scheduler.taskTimeout);
  if (purged > 0) {
    logger.info(`清理超时任务: ${purged} 条`);
  }
}

/**
 * 回调重试循环：处理失败的回调
 */
async function callbackRetryLoop() {
  try {
    await processRetryQueue();
  } catch (err) {
    logger.error(`callbackRetryLoop 异常: ${err.message}`);
  }
}

/**
 * 启动调度器
 */
function start() {
  logger.info('调度器启动');
  logger.info(`配置: 拉取=${config.scheduler.pullSize}条/${config.scheduler.pullInterval}ms 查询并发=${config.scheduler.queryConcurrency} 回调并发=${config.scheduler.callbackConcurrency} 批量阈值=${config.scheduler.batchSize} 休眠阈值=${config.scheduler.callbackSuccessLimit} 超时=${config.scheduler.taskTimeout}ms`);

  pullTimer = setInterval(pullLoop, config.scheduler.pullInterval);
  queryTimer = setInterval(queryLoop, config.scheduler.batchCheckInterval);
  callbackProcessTimer = setInterval(callbackProcessLoop, config.scheduler.callbackProcessInterval);
  cleanupTimer = setInterval(cleanupLoop, config.scheduler.cleanupInterval);
  callbackRetryTimer = setInterval(callbackRetryLoop, config.scheduler.callbackRetryInterval);

  // 立即执行第一次拉取
  pullLoop();
}

/**
 * 停止调度器
 */
function stop() {
  if (pullTimer) clearInterval(pullTimer);
  if (queryTimer) clearInterval(queryTimer);
  if (callbackProcessTimer) clearInterval(callbackProcessTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (callbackRetryTimer) clearInterval(callbackRetryTimer);
  pullTimer = null;
  queryTimer = null;
  callbackProcessTimer = null;
  cleanupTimer = null;
  callbackRetryTimer = null;
  sleeping = false;
  logger.info('调度器已停止');
}

module.exports = { start, stop };
