const config = require('../config');
const logger = require('../utils/logger');
const taskQueue = require('../queue/taskQueue');
const { pullTasks } = require('../services/pullService');
const { querySingle } = require('../services/queryService');
const { callbackSingle, addToRetryQueue, processRetryQueue, getTotalSuccessCount } = require('../services/callbackService');

let pullTimer = null;
let batchTimer = null;
let cleanupTimer = null;
let callbackRetryTimer = null;
let batchRunning = false;
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
 * 处理单个任务：查询 → 立刻回调
 * @returns {string} 'callbackOk' | 'callbackFail' | 'retry'
 */
async function processOneTask(task) {
  // 查询
  const result = await querySingle(task);

  if (!result.success) {
    // 需要重试（code 1000000 或网络异常）
    return 'retry';
  }

  // 查询有结果，立刻回调
  const ok = await callbackSingle(task, result.data);
  if (ok) {
    return 'callbackOk';
  } else {
    // 回调失败，加入重试队列
    addToRetryQueue(task, result.data);
    return 'callbackFail';
  }
}

/**
 * 拉取循环：每5秒从上游拉取任务
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
 * 批量处理循环
 * 每个任务：查询 → 立刻回调，并发执行
 */
async function batchLoop() {
  if (batchRunning) {
    logger.debug('批量处理正在执行中，跳过本次检查');
    return;
  }

  // 检查是否需要进入休眠
  if (!sleeping && getTotalSuccessCount() >= config.scheduler.callbackSuccessLimit) {
    enterSleepMode();
  }

  const pending = taskQueue.pendingCount;

  if (sleeping) {
    if (pending === 0) {
      logger.debug('休眠模式: 队列已空，等待回调重试完成');
      return;
    }
  } else {
    if (pending < config.scheduler.batchSize) {
      logger.debug(`队列 ${pending}/${config.scheduler.batchSize}，未达阈值`);
      return;
    }
  }

  batchRunning = true;
  try {
    const count = sleeping ? pending : config.scheduler.batchSize;
    const tasks = taskQueue.dequeue(count);
    logger.info(`开始批量处理: ${tasks.length} 条任务${sleeping ? ' (休眠模式)' : ''}`);

    const concurrency = config.scheduler.queryConcurrency;
    let callbackOk = 0;
    let callbackFail = 0;
    const retryTasks = [];

    // 按并发数分批，每个任务查询完立刻回调
    for (let i = 0; i < tasks.length; i += concurrency) {
      const batch = tasks.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(task => processOneTask(task)));

      for (let j = 0; j < results.length; j++) {
        if (results[j] === 'callbackOk') callbackOk++;
        else if (results[j] === 'callbackFail') callbackFail++;
        else retryTasks.push(batch[j]); // retry
      }
    }

    // 需要重试的任务重入队
    if (retryTasks.length > 0) {
      taskQueue.requeue(retryTasks);
    }

    logger.info(`批量处理完成: 回调成功=${callbackOk} 回调失败=${callbackFail} 重试=${retryTasks.length}`);

    // 检查是否刚触发休眠阈值
    if (!sleeping && getTotalSuccessCount() >= config.scheduler.callbackSuccessLimit) {
      enterSleepMode();
    }
  } catch (err) {
    logger.error(`batchLoop 异常: ${err.message}`);
  } finally {
    batchRunning = false;
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
 * 回调重试循环：每10秒处理失败的回调
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
  logger.info(`配置: 拉取间隔=${config.scheduler.pullInterval}ms 批量阈值=${config.scheduler.batchSize} 回调成功上限=${config.scheduler.callbackSuccessLimit} 超时=${config.scheduler.taskTimeout}ms`);

  pullTimer = setInterval(pullLoop, config.scheduler.pullInterval);
  batchTimer = setInterval(batchLoop, config.scheduler.batchCheckInterval);
  cleanupTimer = setInterval(cleanupLoop, config.scheduler.cleanupInterval);
  callbackRetryTimer = setInterval(callbackRetryLoop, config.scheduler.callbackRetryInterval);

  pullLoop();
}

/**
 * 停止调度器
 */
function stop() {
  if (pullTimer) clearInterval(pullTimer);
  if (batchTimer) clearInterval(batchTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (callbackRetryTimer) clearInterval(callbackRetryTimer);
  pullTimer = null;
  batchTimer = null;
  cleanupTimer = null;
  callbackRetryTimer = null;
  sleeping = false;
  logger.info('调度器已停止');
}

module.exports = { start, stop };
