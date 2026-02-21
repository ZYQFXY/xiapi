const config = require('../config');
const logger = require('../utils/logger');
const taskQueue = require('../queue/taskQueue');
const { pullSingleTask } = require('../services/pullService');
const { querySingle } = require('../services/queryService');
const {
  callbackSingle,
  getTotalSuccessCount,
  getRetryQueueLength,
  getTotalDroppedCount,
  processRetryQueue,
} = require('../services/callbackService');

let cleanupTimer = null;
let callbackRetryTimer = null;
let statsTimer = null;
let workersStopped = true;
let pullingPaused = false;
let autoPaused = false; // 队列背压自动暂停拉取
let creditExhausted = false; // API额度耗尽自动暂停
let activePullWorkers = 0;
let activeQueryWorkers = 0;
let activeCallbackWorkers = 0;
let hardStopped = false;            // 超时丢弃>20%紧急停止，不可自动恢复
let highWaterAlertSent = false;     // 高水位告警已发送标记

// 队列背压阈值
const QUEUE_HIGH_WATER = 200;
const QUEUE_LOW_WATER = 50;

// ======== 外部 API 健康检测 & 自动降级 ========
const HEALTH_WINDOW_MS = 60000;       // 60 秒统计窗口
const DEGRADE_TIMEOUT_RATE = 0.7;     // 超时率 ≥ 70% 触发降级
const RECOVER_TIMEOUT_RATE = 0.35;    // 超时率 < 35% 恢复正常
const CIRCUIT_BREAK_THRESHOLD = 200;  // 连续超时 ≥ 200 次触发熔断暂停
const CIRCUIT_BREAK_PAUSE_MS = 10000; // 熔断初始暂停 10 秒
const CIRCUIT_BREAK_MAX_PAUSE_MS = 60000; // 熔断最大暂停 60 秒
const CREDIT_PROBE_INTERVAL = 30000; // 额度探测间隔 30 秒

// ======== 超时丢弃率 → 联动降级 / 熔断 / 紧急停止 ========
const DISCARD_DEGRADE_RATE = 0.10;     // ≥10% → 降级拉取和查询
const DISCARD_CIRCUIT_RATE = 0.15;     // ≥15% → 熔断拉取和查询
const DISCARD_HARD_STOP_RATE = 0.20;   // ≥20% → 紧急停止，不可自动恢复
const DISCARD_CHECK_MIN_TOTAL = 100;   // 拉取总数未达此值时不检查丢弃率

// 查询服务健康状态（按秒聚合桶，避免高 QPS 下 O(n) shift）
const queryHealth = {
  buckets: new Map(),       // secondTimestamp -> { total, timeouts }
  windowTotal: 0,           // 窗口内总请求数
  windowTimeouts: 0,        // 窗口内超时数
  consecutiveTimeouts: 0,
  degraded: false,
  circuitPause: CIRCUIT_BREAK_PAUSE_MS,
};

// 回调服务健康状态
const callbackHealth = {
  buckets: new Map(),
  windowTotal: 0,
  windowTimeouts: 0,
  consecutiveTimeouts: 0,
  degraded: false,
  circuitPause: CIRCUIT_BREAK_PAUSE_MS,
};

/**
 * 记录一次请求结果并更新健康状态
 * 使用按秒聚合桶代替逐条 push/shift，O(1) 写入
 */
function recordSample(health, isTimeout, label) {
  const sec = Math.floor(Date.now() / 1000);

  // 写入当前秒桶
  let bucket = health.buckets.get(sec);
  if (!bucket) {
    bucket = { total: 0, timeouts: 0 };
    health.buckets.set(sec, bucket);
  }
  bucket.total++;
  health.windowTotal++;
  if (isTimeout) {
    bucket.timeouts++;
    health.windowTimeouts++;
    health.consecutiveTimeouts++;
  } else {
    health.consecutiveTimeouts = 0;
  }

  // 清理过期桶（60 秒窗口）
  const cutoff = sec - 60;
  for (const [s, b] of health.buckets) {
    if (s <= cutoff) {
      health.windowTotal -= b.total;
      health.windowTimeouts -= b.timeouts;
      health.buckets.delete(s);
    } else {
      break; // Map 按插入顺序遍历，可提前退出
    }
  }

  // 采样检查超时率（每 10 次检查一次减少开销）
  if (health.windowTotal < 100) return;
  if (health.windowTotal % 10 !== 0 && !isTimeout) return;

  const timeoutRate = health.windowTimeouts / health.windowTotal;

  // 状态切换
  if (!health.degraded && timeoutRate >= DEGRADE_TIMEOUT_RATE) {
    health.degraded = true;
    logger.warn(`[降级] ${label}超时率 ${(timeoutRate * 100).toFixed(0)}% (${health.windowTimeouts}/${health.windowTotal})，切换为串行模式`);
  } else if (health.degraded && timeoutRate < RECOVER_TIMEOUT_RATE) {
    health.degraded = false;
    health.circuitPause = CIRCUIT_BREAK_PAUSE_MS;
    logger.info(`[恢复] ${label}超时率 ${(timeoutRate * 100).toFixed(0)}% (${health.windowTimeouts}/${health.windowTotal})，恢复批量并发模式`);
  }
}

// 拉取服务健康状态（与 queryHealth/callbackHealth 统一体系）
const pullHealth = {
  buckets: new Map(),
  windowTotal: 0,
  windowTimeouts: 0,
  consecutiveTimeouts: 0,
  degraded: false,
  circuitPause: CIRCUIT_BREAK_PAUSE_MS,
};

/**
 * 判断错误是否为上游故障（超时、408、5xx、网络断开等）
 */
function isUpstreamError(err) {
  if (!err) return false;
  const msg = err.message || '';
  // 客户端超时
  if (msg.includes('timeout')) return true;
  // 网络层错误
  if (msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET') || msg.includes('ENOTFOUND') || msg.includes('EPIPE') || msg.includes('socket hang up')) return true;
  // HTTP 状态码：408(Request Timeout)、429(Too Many Requests)、5xx(服务器错误)
  const status = err.response && err.response.status;
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return true;
  return false;
}

// 回调队列（scheduler 内部管理）
const callbackQueue = [];

// 吞吐量统计（累计值）
let statsLastTime = Date.now();
let statsLastSuccess = 0;
let pullCount = 0;
let querySkipCount = 0;
let queueTimeoutCount = 0;  // 队列中超时统计
let creditExhaustedCount = 0;  // 额度耗尽触发次数
let callbackTimeoutDiscards = 0;  // 回调阶段超时丢弃计数
let queryStaleCount = 0;          // 查询阶段过期丢弃（不计入超时丢弃率）
let discardDegradeTriggered = false;  // 丢弃率降级已触发
let discardCircuitTriggered = false;  // 丢弃率熔断已触发

// 上次统计输出时的快照（用于计算增量）
let lastStatsPullCount = 0;
let lastStatsQuerySkipCount = 0;
let lastStatsQueueTimeoutCount = 0;

// ======== 任务级结构化日志（供 Web 面板三窗口展示）========
const TASK_LOG_HISTORY = 100;
const TASK_LOG_PER_BROADCAST = 50;
const taskLogHistory = { pull: [], query: [], callback: [] };
const taskLogPending = { pull: [], query: [], callback: [] };

function logTask(channel, ok, shopId, itemId) {
  const entry = { ts: Date.now(), ok, sid: String(shopId || ''), iid: String(itemId || '') };
  taskLogPending[channel].push(entry);
  taskLogHistory[channel].push(entry);
  if (taskLogHistory[channel].length > TASK_LOG_HISTORY) {
    taskLogHistory[channel].shift();
  }
}

function drainTaskLogs() {
  const result = {};
  for (const ch of ['pull', 'query', 'callback']) {
    const arr = taskLogPending[ch].splice(0);
    result[ch] = arr.length > TASK_LOG_PER_BROADCAST ? arr.slice(-TASK_LOG_PER_BROADCAST) : arr;
  }
  return result;
}

function getTaskLogHistory() {
  return {
    pull: taskLogHistory.pull.slice(-TASK_LOG_PER_BROADCAST),
    query: taskLogHistory.query.slice(-TASK_LOG_PER_BROADCAST),
    callback: taskLogHistory.callback.slice(-TASK_LOG_PER_BROADCAST),
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 发送企业微信机器人告警
 */
async function sendWecomAlert(message) {
  const webhookKey = config.wecom && config.wecom.webhookKey;
  if (!webhookKey) {
    logger.warn('[企业微信] 未配置 WECOM_WEBHOOK_KEY，跳过通知');
    return;
  }
  try {
    const axios = require('axios');
    await axios.post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${webhookKey}`, {
      msgtype: 'text',
      text: { content: message },
    }, { timeout: 10000 });
    logger.info('[企业微信] 告警通知已发送');
  } catch (err) {
    logger.error(`[企业微信] 通知发送失败: ${err.message}`);
  }
}

/**
 * 检查超时丢弃率，联动降级 / 熔断 / 紧急停止
 * 丢弃率 = 超时丢弃任务 / (回调成功 + 超时丢弃)
 */
function checkTimeoutDiscardRate() {
  const totalDiscards = querySkipCount + queueTimeoutCount + callbackTimeoutDiscards + getTotalDroppedCount();
  const successCount = getTotalSuccessCount();
  const total = successCount + totalDiscards;
  if (total < DISCARD_CHECK_MIN_TOTAL) return;

  const rate = totalDiscards / total;

  // ≥20%：紧急停止，不可自动恢复
  if (rate >= DISCARD_HARD_STOP_RATE && !hardStopped) {
    hardStopped = true;
    logger.error(`[紧急停止] 超时丢弃率 ${(rate * 100).toFixed(1)}% 超过 20%，停止所有拉取和查询，需人工恢复`);
    sendWecomAlert(
      `⚠️ 虾皮任务系统紧急告警\n\n` +
      `超时丢弃率: ${(rate * 100).toFixed(1)}%（阈值 20%）\n` +
      `回调成功: ${successCount}\n` +
      `超时丢弃: ${totalDiscards}\n\n` +
      `系统已自动停止拉取和查询，需人工介入恢复。`
    );
    return;
  }

  // ≥15%：熔断拉取和查询
  if (rate >= DISCARD_CIRCUIT_RATE) {
    if (!discardCircuitTriggered) {
      discardCircuitTriggered = true;
      logger.warn(`[超时熔断] 超时丢弃率 ${(rate * 100).toFixed(1)}% 超过 15%，拉取和查询熔断`);
    }
    pullHealth.consecutiveTimeouts = CIRCUIT_BREAK_THRESHOLD;
    queryHealth.consecutiveTimeouts = CIRCUIT_BREAK_THRESHOLD;
    return;
  } else {
    discardCircuitTriggered = false;
  }

  // ≥10%：降级拉取和查询
  if (rate >= DISCARD_DEGRADE_RATE) {
    if (!discardDegradeTriggered) {
      discardDegradeTriggered = true;
      logger.warn(`[超时降级] 超时丢弃率 ${(rate * 100).toFixed(1)}% 超过 10%，拉取和查询降级`);
    }
    if (!pullHealth.degraded) pullHealth.degraded = true;
    if (!queryHealth.degraded) queryHealth.degraded = true;
  } else {
    discardDegradeTriggered = false;
  }
}

/**
 * 全局降级检查：当多个服务同时降级时，系统处于严重故障状态
 * 返回降级的服务数量（0-3）
 */
function getGlobalDegradeLevel() {
  let level = 0;
  if (pullHealth.degraded || pullHealth.consecutiveTimeouts >= CIRCUIT_BREAK_THRESHOLD) level++;
  if (queryHealth.degraded || queryHealth.consecutiveTimeouts >= CIRCUIT_BREAK_THRESHOLD) level++;
  if (callbackHealth.degraded || callbackHealth.consecutiveTimeouts >= CIRCUIT_BREAK_THRESHOLD) level++;
  return level;
}

/**
 * 检查队列背压，自动控制拉取
 */
function checkBackpressure() {
  const pending = taskQueue.pendingCount;
  if (!autoPaused && pending > QUEUE_HIGH_WATER) {
    autoPaused = true;
    highWaterAlertSent = true;
    logger.info(`=== 队列背压 === 堆积任务 ${pending} 超过 ${QUEUE_HIGH_WATER}，自动停止拉取`);
    sendWecomAlert(
      `⚠️ 虾皮任务系统队列告警\n\n` +
      `队列堆积任务: ${pending}（高水位阈值 ${QUEUE_HIGH_WATER}）\n` +
      `数据方接口出现问题，已自动停止拉取任务。\n\n` +
      `系统将在队列降至 ${QUEUE_LOW_WATER} 以下时自动恢复。`
    );
  } else if (autoPaused && pending < QUEUE_LOW_WATER) {
    autoPaused = false;
    highWaterAlertSent = false;
    logger.info(`=== 队列恢复 === 堆积任务 ${pending} 低于 ${QUEUE_LOW_WATER}，自动恢复拉取`);
    sendWecomAlert(
      `✅ 虾皮任务系统队列恢复\n\n` +
      `队列剩余任务: ${pending}（低水位阈值 ${QUEUE_LOW_WATER}）\n` +
      `系统已自动恢复拉取任务。`
    );
    // 补足已退出的拉取线程
    const pullNeeded = config.scheduler.pullSize - activePullWorkers;
    for (let i = 0; i < pullNeeded; i++) {
      pullWorker(i);
    }
  }
}

/**
 * 额度探测：定期尝试一个查询以检测 API 额度是否恢复
 */
async function creditProbe() {
  await sleep(CREDIT_PROBE_INTERVAL);
  if (workersStopped || !creditExhausted) return;

  // 尝试拉取一个任务来探测
  let task = null;
  if (taskQueue.pendingCount > 0) {
    const tasks = taskQueue.dequeue(1);
    if (tasks.length > 0) task = tasks[0];
  }
  if (!task) {
    try {
      task = await pullSingleTask();
    } catch (e) {
      logger.info('[额度探测] 拉取探测任务失败，等待下次探测...');
      return;
    }
  }
  if (!task) {
    logger.info('[额度探测] 无可用任务，等待下次探测...');
    return;
  }

  try {
    const result = await querySingle(task);
    if (result.creditExhausted) {
      taskQueue.removeKey(task);
      logger.info('[额度探测] API 额度仍未恢复，继续等待...');
    } else {
      creditExhausted = false;
      logger.info('[额度恢复] tokege API 额度已恢复，自动恢复拉取和查询');
      if (result.success) {
        logTask('query', true, task.shop_id, task.item_id);
        callbackQueue.push({ task: result.task, data: result.data });
      } else {
        logTask('query', false, task.shop_id, task.item_id);
        taskQueue.requeue([task]);
      }
      // 恢复拉取工作线程
      const pullNeeded = config.scheduler.pullSize - activePullWorkers;
      for (let i = 0; i < pullNeeded; i++) {
        pullWorker(i);
      }
    }
  } catch (err) {
    taskQueue.removeKey(task);
    logger.warn(`[额度探测] 探测异常: ${err.message}`);
  }
}

/**
 * 拉取工作线程：内部并发拉取，带健康检测 / 降级 / 熔断
 *   正常模式 → 每轮并发 5 个请求
 *   降级模式 → 每轮单个请求
 */
async function pullWorker(workerId) {
  activePullWorkers++;
  const PULL_CONCURRENCY = 5; // 每个 worker 内部并发数

  while (!workersStopped && !pullingPaused && !autoPaused && !creditExhausted && !hardStopped) {
    // 熔断：上游连续故障过多，暂停等待恢复（递增暂停）
    if (pullHealth.consecutiveTimeouts >= CIRCUIT_BREAK_THRESHOLD) {
      if (workerId === 0) {
        logger.warn(`[熔断] 拉取连续故障 ${pullHealth.consecutiveTimeouts} 次，暂停 ${pullHealth.circuitPause / 1000} 秒`);
      }
      await sleep(pullHealth.circuitPause);
      // 递增下次暂停时长，上限 60 秒
      pullHealth.circuitPause = Math.min(pullHealth.circuitPause * 2, CIRCUIT_BREAK_MAX_PAUSE_MS);
      pullHealth.consecutiveTimeouts = 0;
      if (!pullHealth.degraded) {
        pullHealth.degraded = true;
        logger.warn(`[熔断→降级] 拉取熔断恢复，进入降级模式`);
      }
      continue;
    }

    if (pullHealth.degraded || callbackHealth.degraded) {
      const globalLevel = getGlobalDegradeLevel();
      try {
        const task = await pullSingleTask();
        recordSample(pullHealth, false, '拉取');
        if (task) {
          pullCount++;
          taskQueue.enqueue([task]);
          logTask('pull', true, task.shop_id, task.item_id);
        } else {
          await sleep(100);
        }
      } catch (err) {
        recordSample(pullHealth, isUpstreamError(err), '拉取');
        logTask('pull', false, '', '');
        await sleep(globalLevel >= 2 ? 2000 : 500);
      }
    } else {
      // 正常模式：并发拉取
      const promises = [];
      for (let i = 0; i < PULL_CONCURRENCY; i++) {
        promises.push(
          pullSingleTask()
            .then(task => ({ ok: true, task }))
            .catch(err => ({ ok: false, err }))
        );
      }

      const results = await Promise.all(promises);
      let gotTask = false;

      for (const r of results) {
        if (r.ok) {
          recordSample(pullHealth, false, '拉取');
          if (r.task) {
            gotTask = true;
            pullCount++;
            taskQueue.enqueue([r.task]);
            logTask('pull', true, r.task.shop_id, r.task.item_id);
          }
        } else {
          recordSample(pullHealth, isUpstreamError(r.err), '拉取');
          logTask('pull', false, '', '');
        }
      }

      if (!gotTask) {
        await sleep(30);
      }
    }
  }
  activePullWorkers--;
}

/**
 * 查询工作线程：
 *   正常模式 → 批量取 5 个任务 Promise.all 并发处理（高吞吐）
 *   降级模式 → 串行逐个处理（保护 event loop）
 *   熔断    → 连续超时过多时暂停等待网络恢复
 */
async function queryWorker(workerId) {
  activeQueryWorkers++;
  while (!workersStopped && !hardStopped) {
    checkBackpressure();

    // 额度耗尽：worker 0 做探测，其他休眠
    if (creditExhausted) {
      if (workerId === 0) {
        await creditProbe();
      } else {
        await sleep(CREDIT_PROBE_INTERVAL);
      }
      continue;
    }

    // 熔断：连续超时过多，暂停等待恢复（递增暂停）
    if (queryHealth.consecutiveTimeouts >= CIRCUIT_BREAK_THRESHOLD) {
      if (workerId === 0) {
        logger.warn(`[熔断] 查询连续超时 ${queryHealth.consecutiveTimeouts} 次，暂停 ${queryHealth.circuitPause / 1000} 秒`);
      }
      await sleep(queryHealth.circuitPause);
      queryHealth.circuitPause = Math.min(queryHealth.circuitPause * 2, CIRCUIT_BREAK_MAX_PAUSE_MS);
      queryHealth.consecutiveTimeouts = 0;
      // 熔断恢复后强制进入降级模式，避免批量并发再次打死 event loop
      if (!queryHealth.degraded) {
        queryHealth.degraded = true;
        logger.warn(`[熔断→降级] 查询熔断恢复，强制进入串行模式`);
      }
      continue;
    }

    if (taskQueue.pendingCount === 0) {
      await sleep((queryHealth.degraded || callbackHealth.degraded) ? 50 : 2);
      continue;
    }

    if (queryHealth.degraded || callbackHealth.degraded) {
      // ===== 降级模式：串行处理单个任务 =====
      // 全局多服务降级时，进一步降低处理速度
      const globalLevel = getGlobalDegradeLevel();
      if (globalLevel >= 2) {
        await sleep(100); // 多服务故障时每轮额外等待
      }
      await queryProcessOne();
    } else {
      // ===== 正常模式：批量并发处理 =====
      await queryProcessBatch();
    }
  }
  activeQueryWorkers--;
}

/** 检查任务是否查询前过期（>4分钟），不计入超时丢弃率 */
function isTaskStale(task) {
  if (!task.created_at) return false;
  const age = Date.now() - new Date(task.created_at).getTime();
  if (age > 240000) {
    logger.info(`查询前过期丢弃: shop_id=${task.shop_id} item_id=${task.item_id} age=${(age / 1000).toFixed(0)}s`);
    taskQueue.removeKey(task);
    queryStaleCount++;
    return true;
  }
  return false;
}

/** 检查任务是否队列中超时，超时返回 true */
function isTaskExpired(task) {
  if (!task.created_at) return false;
  const age = Date.now() - new Date(task.created_at).getTime();
  if (age > 290000) {
    logger.info(`队列任务已超时丢弃: shop_id=${task.shop_id} item_id=${task.item_id} created_at=${task.created_at} age=${(age / 1000).toFixed(0)}s`);
    taskQueue.removeKey(task);
    querySkipCount++;
    return true;
  }
  return false;
}

/** 正常模式：批量取任务并发处理 */
async function queryProcessBatch() {
  // 有其他服务降级时，缩小批量避免过多并发 Promise
  const globalLevel = getGlobalDegradeLevel();
  const batchSize = globalLevel >= 1 ? 5 : 10;
  const tasks = taskQueue.dequeue(batchSize);
  if (tasks.length === 0) {
    await sleep(2);
    return;
  }

  const promises = tasks.map(async (task) => {
    if (isTaskStale(task)) return null;

    if (task.retry_after && Date.now() < task.retry_after) {
      taskQueue.requeueSilent(task);
      return null;
    }

    try {
      const result = await querySingle(task);
      // API 有响应（包括业务错误），视为健康
      recordSample(queryHealth, false, '查询');
      if (result.creditExhausted) {
        return { type: 'creditExhausted', task };
      }
      if (result.success) {
        logTask('query', true, task.shop_id, task.item_id);
        return { type: 'callback', task: result.task, data: result.data };
      } else {
        logTask('query', false, task.shop_id, task.item_id);
        const retryCount = (task.retry_count || 0);
        task.retry_after = Date.now() + Math.min((retryCount + 1) * 500, 3000);
        return { type: 'retry', task };
      }
    } catch (err) {
      // 网络错误/超时 → 喂给健康检测
      logTask('query', false, task.shop_id, task.item_id);
      recordSample(queryHealth, isUpstreamError(err), '查询');
      logger.warn(`查询网络异常: shop_id=${task.shop_id} item_id=${task.item_id} err=${err.message}`);
      return { type: 'retry', task };
    }
  });

  const results = await Promise.all(promises);

  for (const result of results) {
    if (!result) continue;
    if (result.type === 'callback') {
      callbackQueue.push({ task: result.task, data: result.data });
    } else if (result.type === 'creditExhausted') {
      taskQueue.removeKey(result.task);
      if (!creditExhausted) {
        creditExhausted = true;
        creditExhaustedCount++;
        logger.warn('[额度耗尽] tokege API 额度不足，自动停止拉取和查询，结果已丢弃，每 30 秒探测一次...');
      }
    } else if (result.type === 'retry') {
      taskQueue.requeue([result.task]);
    }
  }
}

/** 降级模式：小批量串行处理 */
async function queryProcessOne() {
  const globalLevel = getGlobalDegradeLevel();
  const batchSize = globalLevel >= 2 ? 1 : 3;
  const tasks = taskQueue.dequeue(batchSize);
  if (tasks.length === 0) {
    await sleep(50);
    return;
  }

  for (const task of tasks) {
    if (isTaskStale(task)) continue;

    if (task.retry_after && Date.now() < task.retry_after) {
      taskQueue.requeueSilent(task);
      continue;
    }

    try {
      const result = await querySingle(task);
      // API 有响应（包括业务错误），视为健康
      recordSample(queryHealth, false, '查询');
      if (result.creditExhausted) {
        taskQueue.removeKey(task);
        if (!creditExhausted) {
          creditExhausted = true;
          creditExhaustedCount++;
          logger.warn('[额度耗尽] tokege API 额度不足，自动停止拉取和查询，结果已丢弃，每 30 秒探测一次...');
        }
        return;
      }
      if (result.success) {
        logTask('query', true, task.shop_id, task.item_id);
        callbackQueue.push({ task: result.task, data: result.data });
      } else {
        logTask('query', false, task.shop_id, task.item_id);
        const retryCount = (task.retry_count || 0);
        task.retry_after = Date.now() + Math.min((retryCount + 1) * 500, 3000);
        taskQueue.requeue([task]);
      }
    } catch (err) {
      // 网络错误/超时 → 喂给健康检测
      logTask('query', false, task.shop_id, task.item_id);
      recordSample(queryHealth, isUpstreamError(err), '查询');
      logger.warn(`查询网络异常: shop_id=${task.shop_id} item_id=${task.item_id} err=${err.message}`);
      taskQueue.requeue([task]);
      // 降级模式下出错后冷却，避免连续错误打爆 event loop
      await sleep(globalLevel >= 2 ? 1000 : 300);
    }
  }
}

/**
 * 回调工作线程：
 *   正常模式 → 批量取 8 个任务 Promise.all 并发处理
 *   降级模式 → 串行逐个处理
 *   熔断    → 连续超时过多时暂停
 */
async function callbackWorker(workerId) {
  activeCallbackWorkers++;
  while (!workersStopped) {
    // 熔断（递增暂停）
    if (callbackHealth.consecutiveTimeouts >= CIRCUIT_BREAK_THRESHOLD) {
      if (workerId === 0) {
        logger.warn(`[熔断] 回调连续超时 ${callbackHealth.consecutiveTimeouts} 次，暂停 ${callbackHealth.circuitPause / 1000} 秒`);
      }
      await sleep(callbackHealth.circuitPause);
      callbackHealth.circuitPause = Math.min(callbackHealth.circuitPause * 2, CIRCUIT_BREAK_MAX_PAUSE_MS);
      callbackHealth.consecutiveTimeouts = 0;
      // 熔断恢复后强制进入降级模式
      if (!callbackHealth.degraded) {
        callbackHealth.degraded = true;
        logger.warn(`[熔断→降级] 回调熔断恢复，强制进入串行模式`);
      }
      continue;
    }

    if (callbackQueue.length === 0) {
      await sleep(callbackHealth.degraded ? 50 : 2);
      continue;
    }

    if (callbackHealth.degraded) {
      // 全局多服务降级时额外等待
      const globalLevel = getGlobalDegradeLevel();
      if (globalLevel >= 2) {
        await sleep(100);
      }
      await callbackProcessOne();
    } else {
      await callbackProcessBatch();
    }
  }
  activeCallbackWorkers--;
}

/** 检查回调任务是否超时 */
function isCallbackTaskExpired(item) {
  if (!item.task.created_at) return false;
  const age = Date.now() - new Date(item.task.created_at).getTime();
  if (age > 290000) {
    logger.info(`回调任务已超时丢弃: shop_id=${item.task.shop_id} item_id=${item.task.item_id} created_at=${item.task.created_at} age=${(age / 1000).toFixed(0)}s`);
    taskQueue.removeKey(item.task);
    callbackTimeoutDiscards++;
    return true;
  }
  return false;
}

/** 回调失败处理 */
function handleCallbackFailure(item) {
  const { addToRetryQueue } = require('../services/callbackService');
  addToRetryQueue(item.task, item.data);
}

/** 正常模式：批量并发回调 */
async function callbackProcessBatch() {
  // 有其他服务降级时，缩小批量
  const globalLevel = getGlobalDegradeLevel();
  const maxBatch = globalLevel >= 1 ? 8 : 15;
  const batchSize = Math.min(maxBatch, callbackQueue.length);
  const items = [];
  for (let i = 0; i < batchSize; i++) {
    const item = callbackQueue.shift();
    if (item) items.push(item);
  }
  if (items.length === 0) return;

  const promises = items.map(async (item) => {
    if (isCallbackTaskExpired(item)) return;

    try {
      await callbackSingle(item.task, item.data);
      recordSample(callbackHealth, false, '回调');
      logTask('callback', true, item.task.shop_id, item.task.item_id);
    } catch (err) {
      recordSample(callbackHealth, isUpstreamError(err), '回调');
      logTask('callback', false, item.task.shop_id, item.task.item_id);
      logger.warn(`回调失败: shop_id=${item.task.shop_id} good_id=${item.task.good_id} err=${err.message}`);
      handleCallbackFailure(item);
    }
  });

  await Promise.all(promises);
}

/** 降级模式：小批量串行回调 */
async function callbackProcessOne() {
  const globalLevel = getGlobalDegradeLevel();
  const maxBatch = globalLevel >= 2 ? 1 : 3;
  const batchSize = Math.min(maxBatch, callbackQueue.length);
  const items = [];
  for (let i = 0; i < batchSize; i++) {
    const item = callbackQueue.shift();
    if (item) items.push(item);
  }
  if (items.length === 0) return;

  for (const item of items) {
    if (isCallbackTaskExpired(item)) continue;

    try {
      await callbackSingle(item.task, item.data);
      recordSample(callbackHealth, false, '回调');
      logTask('callback', true, item.task.shop_id, item.task.item_id);
    } catch (err) {
      recordSample(callbackHealth, isUpstreamError(err), '回调');
      logTask('callback', false, item.task.shop_id, item.task.item_id);
      logger.warn(`回调失败: shop_id=${item.task.shop_id} good_id=${item.task.good_id} err=${err.message}`);
      handleCallbackFailure(item);
      // 降级模式下出错后冷却
      await sleep(globalLevel >= 2 ? 1000 : 300);
    }
  }
}

/**
 * 清理循环：定期清理超时任务（4分50秒）
 */
function cleanupLoop() {
  const purged = taskQueue.purgeExpired(290000);  // 4分50秒 = 290000ms
  if (purged > 0) {
    queueTimeoutCount += purged;  // 队列中超时计数
    logger.info(`清理超时任务: ${purged} 条`);
  }
  checkTimeoutDiscardRate();
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
  checkTimeoutDiscardRate();

  const now = Date.now();
  const elapsed = (now - statsLastTime) / 1000;
  const currentSuccess = getTotalSuccessCount();
  const delta = currentSuccess - statsLastSuccess;
  const rate = (delta / elapsed * 60).toFixed(1);

  const deltaPull = pullCount - lastStatsPullCount;
  const deltaSkip = querySkipCount - lastStatsQuerySkipCount;
  const deltaTimeout = queueTimeoutCount - lastStatsQueueTimeoutCount;

  const totalDiscards = querySkipCount + queueTimeoutCount + callbackTimeoutDiscards + getTotalDroppedCount();
  const discardTotal = currentSuccess + totalDiscards;
  const discardRate = discardTotal > 0 ? (totalDiscards / discardTotal * 100).toFixed(1) : '0.0';

  const queryMode = creditExhausted ? '额度耗尽' : (queryHealth.degraded || callbackHealth.degraded) ? '降级' : '正常';
  const cbMode = callbackHealth.degraded ? '降级' : '正常';
  const pullMode = hardStopped ? '紧急停止' : (pullHealth.degraded || callbackHealth.degraded) ? '退避' : '正常';
  const globalLevel = getGlobalDegradeLevel();
  const globalTag = globalLevel >= 2 ? ` [全局降级L${globalLevel}]` : '';
  const hardTag = hardStopped ? ' [紧急停止]' : '';

  logger.info(`[统计]${globalTag}${hardTag} 回调: ${currentSuccess} (+${delta}) ${rate}条/分 | 拉取: ${pullCount}(+${deltaPull}) 超时丢弃: ${totalDiscards}(${discardRate}%) 队列中超时: ${queueTimeoutCount}(+${deltaTimeout}) | 队列: ${taskQueue.pendingCount} | 回调队列: ${callbackQueue.length} | 重试: ${getRetryQueueLength()} | pull=${activePullWorkers}(${pullMode}) query=${activeQueryWorkers}(${queryMode}) cb=${activeCallbackWorkers}(${cbMode})`);

  statsLastTime = now;
  statsLastSuccess = currentSuccess;
  lastStatsPullCount = pullCount;
  lastStatsQuerySkipCount = querySkipCount;
  lastStatsQueueTimeoutCount = queueTimeoutCount;
}

/**
 * 启动调度器
 */
function start() {
  const pullWorkerCount = config.scheduler.pullSize;
  const queryWorkerCount = config.scheduler.queryConcurrency;
  const callbackWorkerCount = config.scheduler.callbackConcurrency;

  workersStopped = false;
  autoPaused = false;
  pullingPaused = false;
  creditExhausted = false;

  logger.info('调度器启动');
  logger.info(`配置: pull_worker=${pullWorkerCount} query_worker=${queryWorkerCount} callback_worker=${callbackWorkerCount} 背压阈值=${QUEUE_HIGH_WATER}/${QUEUE_LOW_WATER}`);

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
  autoPaused = false;
  pullingPaused = false;
  logger.info('调度器已停止');
}

/**
 * 启动/恢复拉取
 */
function startPulling() {
  if (workersStopped) return;

  pullingPaused = false;
  autoPaused = false;
  creditExhausted = false;
  hardStopped = false;

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
  // 计算各阶段运行模式（联动回调降级）
  const pullMode = hardStopped ? '紧急停止'
    : creditExhausted ? '额度耗尽'
    : pullHealth.consecutiveTimeouts >= CIRCUIT_BREAK_THRESHOLD ? '熔断'
    : (pullHealth.degraded || callbackHealth.degraded) ? '降级' : '正常';
  const queryMode = hardStopped ? '紧急停止'
    : creditExhausted ? '额度耗尽'
    : queryHealth.consecutiveTimeouts >= CIRCUIT_BREAK_THRESHOLD ? '熔断'
    : (queryHealth.degraded || callbackHealth.degraded) ? '降级' : '正常';
  const callbackMode = callbackHealth.consecutiveTimeouts >= CIRCUIT_BREAK_THRESHOLD ? '熔断'
    : callbackHealth.degraded ? '降级' : '正常';

  const totalDiscards = querySkipCount + queueTimeoutCount + callbackTimeoutDiscards + getTotalDroppedCount();
  const successCount = getTotalSuccessCount();
  const discardTotal = successCount + totalDiscards;
  const discardRate = discardTotal > 0 ? (totalDiscards / discardTotal * 100).toFixed(1) : '0.0';

  return {
    autoPaused,
    workersStopped,
    pullingPaused,
    creditExhausted,
    hardStopped,
    activePullWorkers,
    activeQueryWorkers,
    activeCallbackWorkers,
    pullMode,
    queryMode,
    callbackMode,
    pullDegraded: pullHealth.degraded || callbackHealth.degraded,
    queryDegraded: queryHealth.degraded || callbackHealth.degraded,
    callbackDegraded: callbackHealth.degraded,
    callbackQueueLength: callbackQueue.length,
    pullCount,
    querySkipCount,
    queryStaleCount,
    queueTimeoutCount,
    callbackTimeoutDiscards,
    totalDiscards,
    discardRate: discardRate + '%',
    creditExhaustedCount,
  };
}

/**
 * 调度器是否在运行
 */
function isRunning() {
  return !workersStopped;
}

module.exports = { start, stop, startPulling, stopPulling, getStats, isRunning, drainTaskLogs, getTaskLogHistory };
