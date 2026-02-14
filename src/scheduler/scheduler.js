const config = require('../config');
const logger = require('../utils/logger');
const taskQueue = require('../queue/taskQueue');
const { pullSingleTask } = require('../services/pullService');
const { querySingle } = require('../services/queryService');
const {
  addToCallbackQueue,
  processCallbackQueue,
  processRetryQueue,
  getTotalSuccessCount,
  getCallbackQueueLength,
  getRetryQueueLength,
} = require('../services/callbackService');

let callbackProcessTimer = null;
let cleanupTimer = null;
let callbackRetryTimer = null;
let statsTimer = null;
let callbackRunning = false;
let sleeping = false;
let workersStopped = false;
let activePullWorkers = 0;
let activeQueryWorkers = 0;

// 吞吐量统计
let statsLastTime = Date.now();
let statsLastSuccess = 0;
let pullCount = 0;
let pullDupCount = 0;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 进入休眠模式：停止拉取新任务
 */
function enterSleepMode() {
  if (sleeping) return;
  sleeping = true;
  logger.info(`=== 进入休眠模式 === 回调成功已达 ${config.scheduler.callbackSuccessLimit} 条，停止拉取新任务，处理剩余队列`);
}

/**
 * 拉取工作线程：串行拉取，避免并发竞争同一个任务
 * 每个 worker 独立循环：拉取 → 入队 → 立即拉取下一个
 */
async function pullWorker(workerId) {
  activePullWorkers++;
  while (!workersStopped && !sleeping) {
    try {
      const task = await pullSingleTask();
      if (task) {
        pullCount++;
        const added = taskQueue.enqueue([task]);
        if (added === 0) pullDupCount++;
      } else {
        // 无任务时短暂等待避免空转
        await sleep(200);
      }
    } catch (err) {
      logger.warn(`pullWorker[${workerId}] 异常: ${err.message}`);
      await sleep(500);
    }
  }
  activePullWorkers--;
}

/**
 * 查询工作线程：持续从队列取任务查询，互不阻塞
 */
async function queryWorker(workerId) {
  activeQueryWorkers++;
  while (!workersStopped) {
    // 检查休眠阈值
    if (!sleeping && getTotalSuccessCount() >= config.scheduler.callbackSuccessLimit) {
      enterSleepMode();
    }

    if (taskQueue.pendingCount === 0) {
      if (sleeping) break;
      await sleep(50);
      continue;
    }

    const tasks = taskQueue.dequeue(1);
    if (tasks.length === 0) {
      await sleep(50);
      continue;
    }

    const task = tasks[0];
    try {
      const result = await querySingle(task);
      if (result.success) {
        addToCallbackQueue(result.task, result.data);
      } else {
        taskQueue.requeue([result.task]);
      }
    } catch (err) {
      logger.error(`queryWorker[${workerId}] 异常: ${err.message}`);
      taskQueue.requeue([task]);
    }
  }
  activeQueryWorkers--;
}

/**
 * 回调处理循环
 */
async function callbackProcessLoop() {
  if (callbackRunning) return;

  callbackRunning = true;
  try {
    await processCallbackQueue();

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
 * 清理循环：定期清理超时任务
 */
function cleanupLoop() {
  const purged = taskQueue.purgeExpired(config.scheduler.taskTimeout);
  if (purged > 0) {
    logger.info(`清理超时任务: ${purged} 条`);
  }
}

/**
 * 回调重试循环
 */
async function callbackRetryLoop() {
  try {
    await processRetryQueue();
  } catch (err) {
    logger.error(`callbackRetryLoop 异常: ${err.message}`);
  }
}

/**
 * 吞吐量统计日志（每 10 秒输出一次）
 */
function statsLoop() {
  const now = Date.now();
  const elapsed = (now - statsLastTime) / 1000;
  const currentSuccess = getTotalSuccessCount();
  const delta = currentSuccess - statsLastSuccess;
  const rate = (delta / elapsed * 60).toFixed(1);

  logger.info(`[统计] 回调: ${currentSuccess} (+${delta}) ${rate}条/分 | 拉取: ${pullCount} 去重: ${pullDupCount} | 队列: ${taskQueue.pendingCount} | 回调队列: ${getCallbackQueueLength()} | 重试: ${getRetryQueueLength()} | pull=${activePullWorkers} query=${activeQueryWorkers}`);

  statsLastTime = now;
  statsLastSuccess = currentSuccess;
  pullCount = 0;
  pullDupCount = 0;
}

/**
 * 启动调度器
 */
function start() {
  const pullWorkerCount = config.scheduler.pullSize;
  const queryWorkerCount = config.scheduler.queryConcurrency;

  logger.info('调度器启动');
  logger.info(`配置: pull_worker=${pullWorkerCount} query_worker=${queryWorkerCount} 回调并发=${config.scheduler.callbackConcurrency} 休眠阈值=${config.scheduler.callbackSuccessLimit}`);

  workersStopped = false;

  // 启动拉取工作线程池（PULL_SIZE = pull worker 数量）
  logger.info(`启动 ${pullWorkerCount} 个拉取工作线程`);
  for (let i = 0; i < pullWorkerCount; i++) {
    pullWorker(i);
  }

  // 启动查询工作线程池
  logger.info(`启动 ${queryWorkerCount} 个查询工作线程`);
  for (let i = 0; i < queryWorkerCount; i++) {
    queryWorker(i);
  }

  // 启动回调、清理、重试定时器
  callbackProcessTimer = setInterval(callbackProcessLoop, config.scheduler.callbackProcessInterval);
  cleanupTimer = setInterval(cleanupLoop, config.scheduler.cleanupInterval);
  callbackRetryTimer = setInterval(callbackRetryLoop, config.scheduler.callbackRetryInterval);

  // 启动统计日志
  statsTimer = setInterval(statsLoop, 10000);
}

/**
 * 停止调度器
 */
function stop() {
  workersStopped = true;
  if (callbackProcessTimer) clearInterval(callbackProcessTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (callbackRetryTimer) clearInterval(callbackRetryTimer);
  if (statsTimer) clearInterval(statsTimer);
  callbackProcessTimer = null;
  cleanupTimer = null;
  callbackRetryTimer = null;
  statsTimer = null;
  sleeping = false;
  logger.info('调度器已停止');
}

module.exports = { start, stop };
