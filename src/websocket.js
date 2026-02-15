const { WebSocketServer } = require('ws');
const logger = require('./utils/logger');
const { getQueryStats } = require('./services/queryService');
const { getPullStats } = require('./services/pullService');
const {
  getTotalSuccessCount,
  getTotalDroppedCount,
  getRetryQueueLength,
} = require('./services/callbackService');
const scheduler = require('./scheduler/scheduler');
const taskQueue = require('./queue/taskQueue');

let lastLogIndex = 0;

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    logger.info('WebSocket 客户端已连接');

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
    if (wss.clients.size === 0) return;

    const stats = collectStats();
    const statsMsg = JSON.stringify({ type: 'stats', data: stats });

    const logBuffer = logger.getLogBuffer();
    let logsMsg = null;
    if (logBuffer.length > lastLogIndex) {
      const newLogs = logBuffer.slice(lastLogIndex);
      lastLogIndex = logBuffer.length;
      logsMsg = JSON.stringify({ type: 'logs', data: newLogs });
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
