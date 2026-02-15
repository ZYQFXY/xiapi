const { WebSocketServer } = require('ws');
const logger = require('./utils/logger');
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

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    logger.info('WebSocket 客户端已连接');

    // 发送历史日志
    const history = logger.getLogBuffer();
    if (history.length > 0) {
      const recent = history.slice(-MAX_LOGS_PER_BROADCAST);
      ws.send(JSON.stringify({ type: 'logs', data: recent }));
    }

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
  });

  // 每秒广播统计数据和增量日志
  setInterval(() => {
    if (wss.clients.size === 0) {
      logger.drainLogs(); // 即使无客户端也清空，防止堆积
      return;
    }

    const stats = collectStats();
    const statsMsg = JSON.stringify({ type: 'stats', data: stats });

    const newLogs = logger.drainLogs();
    let logsMsg = null;
    if (newLogs.length > 0) {
      // 日志过多时只保留最新的，防止浏览器卡死
      const logsToSend = newLogs.length > MAX_LOGS_PER_BROADCAST
        ? newLogs.slice(-MAX_LOGS_PER_BROADCAST)
        : newLogs;
      logsMsg = JSON.stringify({ type: 'logs', data: logsToSend });
    }

    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(statsMsg);
        if (logsMsg) client.send(logsMsg);
      }
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
