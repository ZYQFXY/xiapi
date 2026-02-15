const config = require('../config');
const logger = require('../utils/logger');
const taskQueue = require('../queue/taskQueue');
const { pullSingleTask } = require('../services/pullService');
const { querySingle } = require('../services/queryService');
const {
  callbackSingle,
  getTotalSuccessCount,
  getRetryQueueLength,
  processRetryQueue,
} = require('../services/callbackService');

let cleanupTimer = null;
let callbackRetryTimer = null;
let statsTimer = null;
let sleeping = false;
let workersStopped = true;
let pullingPaused = false;
let activePullWorkers = 0;
let activeQueryWorkers = 0;
let activeCallbackWorkers = 0;

// 回调队列（scheduler 内部管理）
const callbackQueue = [];

// 吞吐量统计（累计值）
let statsLastTime = Date.now();
let statsLastSuccess = 0;
let pullCount = 0;
let pullDupCount = 0;
let querySkipCount = 0;

// 上次统计输出时的快照（用于计算增量）
let lastStatsPullCount = 0;
let lastStatsPullDupCount = 0;
let lastStatsQuerySkipCount = 0;

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
 */
async function pullWorker(workerId) {
  activePullWorkers++;
  while (!workersStopped && !sleeping && !pullingPaused) {
    try {
      const task = await pullSingleTask();
      if (task) {
        pullCount++;
        const added = taskQueue.enqueue([task]);
        if (added === 0) pullDupCount++;
      } else {
        await sleep(100);
      }
    } catch (err) {
      await sleep(300);
    }
  }
  activePullWorkers--;
}

/**
 * 查询工作线程：持续从队列取任务查询，互不阻塞
 * 重试任务带 retry_after 时间戳，未到时间的跳过
 */
async function queryWorker(workerId) {
  activeQueryWorkers++;
  while (!workersStopped) {
    if (!sleeping && getTotalSuccessCount() >= config.scheduler.callbackSuccessLimit) {
      enterSleepMode();
    }

    if (taskQueue.pendingCount === 0) {
      if (sleeping) break;
      await sleep(30);
      continue;
    }

    const tasks = taskQueue.dequeue(1);
    if (tasks.length === 0) {
      await sleep(30);
      continue;
    }

    const task = tasks[0];

    // 检查队列中的任务是否超时（入队超过4分40秒直接丢弃）
    if (task.enqueue_time) {
      const age = Date.now() - task.enqueue_time;
      if (age > config.scheduler.queueTaskTimeout) {
        logger.info(`队列任务已超时丢弃: shop_id=${task.shop_id} good_id=${task.good_id} age=${(age / 1000).toFixed(0)}s`);
        taskQueue.removeKey(task);
        querySkipCount++;
        continue;
      }
    }

    // 重试退避：未到 retry_after 时间的放回队尾
    if (task.retry_after && Date.now() < task.retry_after) {
      taskQueue.requeueSilent(task);
      await sleep(10);
      continue;
    }

    try {
      const result = await querySingle(task);
      if (result.success) {
        callbackQueue.push({ task: result.task, data: result.data });
      } else {
        // 重试退避：根据重试次数递增等待时间（1s, 2s, 3s...最大5s）
        const retryCount = (task.retry_count || 0);
        task.retry_after = Date.now() + Math.min((retryCount + 1) * 1000, 5000);
        taskQueue.requeue([task]);
      }
    } catch (err) {
      taskQueue.requeue([task]);
    }
  }
  activeQueryWorkers--;
}

/**
 * 回调工作线程：持续从回调队列取任务发送，无需定时器驱动
 */
async function callbackWorker(workerId) {
  activeCallbackWorkers++;
  while (!workersStopped) {
    if (callbackQueue.length === 0) {
      if (sleeping && taskQueue.pendingCount === 0) break;
      await sleep(20);
      continue;
    }

    const item = callbackQueue.shift();
    if (!item) continue;

    try {
      const ok = await callbackSingle(item.task, item.data);
      if (!ok) {
        // 失败放入重试队列（callbackService 内部管理）
        const { addToRetryQueue } = require('../services/callbackService');
        addToRetryQueue(item.task, item.data);
      }
    } catch (err) {
      // 异常也放入重试
      const { addToRetryQueue } = require('../services/callbackService');
      addToRetryQueue(item.task, item.data);
    }

    if (!sleeping && getTotalSuccessCount() >= config.scheduler.callbackSuccessLimit) {
      enterSleepMode();
    }
  }
  activeCallbackWorkers--;
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

  const deltaPull = pullCount - lastStatsPullCount;
  const deltaDup = pullDupCount - lastStatsPullDupCount;
  const deltaSkip = querySkipCount - lastStatsQuerySkipCount;

  logger.info(`[统计] 回调: ${currentSuccess} (+${delta}) ${rate}条/分 | 拉取: ${pullCount}(+${deltaPull}) 去重: ${pullDupCount}(+${deltaDup}) 超时丢弃: ${querySkipCount}(+${deltaSkip}) | 队列: ${taskQueue.pendingCount} | 回调队列: ${callbackQueue.length} | 重试: ${getRetryQueueLength()} | pull=${activePullWorkers} query=${activeQueryWorkers} cb=${activeCallbackWorkers}`);

  statsLastTime = now;
  statsLastSuccess = currentSuccess;
  lastStatsPullCount = pullCount;
  lastStatsPullDupCount = pullDupCount;
  lastStatsQuerySkipCount = querySkipCount;
}

/**
 * 启动调度器
 */
function start() {
  const pullWorkerCount = config.scheduler.pullSize;
  const queryWorkerCount = config.scheduler.queryConcurrency;
  const callbackWorkerCount = config.scheduler.callbackConcurrency;

  workersStopped = false;
  sleeping = false;
  pullingPaused = false;

  logger.info('调度器启动');
  logger.info(`配置: pull_worker=${pullWorkerCount} query_worker=${queryWorkerCount} callback_worker=${callbackWorkerCount} 休眠阈值=${config.scheduler.callbackSuccessLimit}`);

  // 启动拉取工作线程池（补足差额）
  const pullNeeded = pullWorkerCount - activePullWorkers;
  if (pullNeeded > 0) {
    logger.info(`启动 ${pullNeeded} 个拉取工作线程`);
    for (let i = 0; i < pullNeeded; i++) {
      pullWorker(i);
    }
  }

  // 启动查询工作线程池（补足差额）
  const queryNeeded = queryWorkerCount - activeQueryWorkers;
  if (queryNeeded > 0) {
    logger.info(`启动 ${queryNeeded} 个查询工作线程`);
    for (let i = 0; i < queryNeeded; i++) {
      queryWorker(i);
    }
  }

  // 启动回调工作线程池（补足差额）
  const callbackNeeded = callbackWorkerCount - activeCallbackWorkers;
  if (callbackNeeded > 0) {
    logger.info(`启动 ${callbackNeeded} 个回调工作线程`);
    for (let i = 0; i < callbackNeeded; i++) {
      callbackWorker(i);
    }
  }

  // 启动清理、重试定时器（如果未在运行）
  if (!cleanupTimer) cleanupTimer = setInterval(cleanupLoop, config.scheduler.cleanupInterval);
  if (!callbackRetryTimer) callbackRetryTimer = setInterval(callbackRetryLoop, config.scheduler.callbackRetryInterval);
  if (!statsTimer) statsTimer = setInterval(statsLoop, 10000);
}

/**
 * 停止调度器
 */
function stop() {
  workersStopped = true;
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (callbackRetryTimer) clearInterval(callbackRetryTimer);
  if (statsTimer) clearInterval(statsTimer);
  cleanupTimer = null;
  callbackRetryTimer = null;
  statsTimer = null;
  sleeping = false;
  pullingPaused = false;
  logger.info('调度器已停止');
}

/**
 * 启动/恢复拉取
 */
function startPulling() {
  if (workersStopped) return;

  pullingPaused = false;
  sleeping = false;

  // 补足已退出的工作线程
  const pullNeeded = config.scheduler.pullSize - activePullWorkers;
  if (pullNeeded > 0) {
    for (let i = 0; i < pullNeeded; i++) {
      pullWorker(i);
    }
  }

  const queryNeeded = config.scheduler.queryConcurrency - activeQueryWorkers;
  if (queryNeeded > 0) {
    for (let i = 0; i < queryNeeded; i++) {
      queryWorker(i);
    }
  }

  const callbackNeeded = config.scheduler.callbackConcurrency - activeCallbackWorkers;
  if (callbackNeeded > 0) {
    for (let i = 0; i < callbackNeeded; i++) {
      callbackWorker(i);
    }
  }

  logger.info('拉取已启动');
}

/**
 * 暂停拉取
 */
function stopPulling() {
  pullingPaused = true;
  logger.info('拉取已暂停');
}

/**
 * 获取调度器状态
 */
function getStats() {
  return {
    sleeping,
    workersStopped,
    pullingPaused,
    activePullWorkers,
    activeQueryWorkers,
    activeCallbackWorkers,
    callbackQueueLength: callbackQueue.length,
    pullCount,
    pullDupCount,
    querySkipCount,
  };
}

/**
 * 调度器是否在运行
 */
function isRunning() {
  return !workersStopped;
}

module.exports = { start, stop, startPulling, stopPulling, getStats, isRunning };
