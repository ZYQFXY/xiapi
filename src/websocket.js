const { WebSocketServer } = require('ws');
const logger = require('./utils/logger');
const { curnumClient, tokegeClient } = require('./utils/http');
const config = require('./config');
const { getQueryStats } = require('./services/queryService');
const { getPullStats } = require('./services/pullService');
const {
  getTotalSuccessCount,
  getTotalDroppedCount,
  getRetryQueueLength,
  getCallbackRatePerMin,
} = require('./services/callbackService');
const scheduler = require('./scheduler/scheduler');
const taskQueue = require('./queue/taskQueue');

let lastLogIndex = 0;

const MAX_LOGS_PER_BROADCAST = 50;

const HEARTBEAT_INTERVAL = 30000; // 30秒发一次心跳

// ======== curnum 当天任务量轮询 ========
const curnumData = { initial: null, current: 0, sessionIncrement: 0 };
let curnumTimer = null;

function getTodayDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function fetchCurnum() {
  try {
    const phone = config.upstream.phone;
    const date = getTodayDate();
    const res = await curnumClient.get(`/api/curnum?phone=${phone}&date=${date}`);
    if (res.data && res.data.status === 200 && typeof res.data.data === 'number') {
      const val = res.data.data;
      if (curnumData.initial === null) {
        curnumData.initial = val;
      }
      curnumData.current = val;
      curnumData.sessionIncrement = val - curnumData.initial;
    }
  } catch (err) {
    // 轮询失败静默忽略，不影响主业务
  }
}

function startCurnumPolling() {
  fetchCurnum();
  curnumTimer = setInterval(fetchCurnum, 10000);
}

startCurnumPolling();

// ======== tokege 余额轮询 ========
let tokegeCredits = null;

async function fetchCredits() {
  try {
    const res = await tokegeClient.get('/tokens/credits', { timeout: 10000 });
    if (res.data && res.data._success && Array.isArray(res.data.credits) && res.data.credits.length > 0) {
      tokegeCredits = Math.abs(res.data.credits[0].credit);
    }
  } catch (err) {
    // 轮询失败静默忽略
  }
}

fetchCredits();
setInterval(fetchCredits, 30000);

function safeSend(ws, data) {
  try {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  } catch (err) {
    // 发送失败，忽略（连接即将关闭）
  }
}

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    logger.info('WebSocket 客户端已连接');

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // 发送历史日志
    const history = logger.getLogBuffer();
    if (history.length > 0) {
      const recent = history.slice(-MAX_LOGS_PER_BROADCAST);
      safeSend(ws, JSON.stringify({ type: 'logs', data: recent }));
    }

    // 发送任务日志历史
    const taskHistory = scheduler.getTaskLogHistory();
    safeSend(ws, JSON.stringify({ type: 'taskLogs', data: taskHistory }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'command') {
          handleCommand(msg.command);
        }
      } catch (err) {
        logger.warn(`WebSocket 消息解析失败: ${err.message}`);
      }
    });

    ws.on('close', () => {
      logger.info('WebSocket 客户端已断开');
    });

    ws.on('error', (err) => {
      logger.warn(`WebSocket 连接错误: ${err.message}`);
    });
  });

  // 心跳检测：每30秒 ping 一次，清除无响应的死连接
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        // 上一轮 ping 没收到 pong，判定为死连接
        return ws.terminate();
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    });
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  // 每秒广播统计数据和增量日志
  setInterval(() => {
    if (wss.clients.size === 0) {
      logger.drainLogs();
      scheduler.drainTaskLogs(); // 无客户端也清空，防止堆积
      return;
    }

    let statsMsg;
    try {
      const stats = collectStats();
      statsMsg = JSON.stringify({ type: 'stats', data: stats });
    } catch (err) {
      logger.warn(`统计数据收集失败: ${err.message}`);
      statsMsg = null;
    }

    const newLogs = logger.drainLogs();
    let logsMsg = null;
    if (newLogs.length > 0) {
      const logsToSend = newLogs.length > MAX_LOGS_PER_BROADCAST
        ? newLogs.slice(-MAX_LOGS_PER_BROADCAST)
        : newLogs;
      logsMsg = JSON.stringify({ type: 'logs', data: logsToSend });
    }

    // 任务级日志
    const newTaskLogs = scheduler.drainTaskLogs();
    let taskLogsMsg = null;
    if (newTaskLogs.pull.length || newTaskLogs.query.length || newTaskLogs.callback.length) {
      taskLogsMsg = JSON.stringify({ type: 'taskLogs', data: newTaskLogs });
    }

    wss.clients.forEach((client) => {
      if (statsMsg) safeSend(client, statsMsg);
      if (logsMsg) safeSend(client, logsMsg);
      if (taskLogsMsg) safeSend(client, taskLogsMsg);
    });
  }, 1000);

  return wss;
}

function collectStats() {
  return {
    callbackSuccess: getTotalSuccessCount(),
    callbackDropped: getTotalDroppedCount(),
    callbackRatePerMin: getCallbackRatePerMin(),
    retryQueueLength: getRetryQueueLength(),
    queuePending: taskQueue.pendingCount,
    queueStats: taskQueue.getStats(),
    queryStats: getQueryStats(),
    pullStats: getPullStats(),
    schedulerStats: scheduler.getStats(),
    schedulerRunning: scheduler.isRunning(),
    curnumData: { ...curnumData },
    tokegeCredits,
  };
}

function handleCommand(command) {
  switch (command) {
    case 'startScheduler':
      if (!scheduler.isRunning()) {
        scheduler.start();
        logger.info('[控制] Web 面板启动调度器');
      }
      break;
    case 'stopScheduler':
      if (scheduler.isRunning()) {
        scheduler.stop();
        logger.info('[控制] Web 面板停止调度器');
      }
      break;
    case 'startPulling':
      scheduler.startPulling();
      logger.info('[控制] Web 面板启动拉取');
      break;
    case 'stopPulling':
      scheduler.stopPulling();
      logger.info('[控制] Web 面板停止拉取');
      break;
    default:
      logger.warn(`未知控制命令: ${command}`);
  }
}

module.exports = { setupWebSocket };
