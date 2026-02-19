const http = require('http');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');
const express = require('express');
const routes = require('./api/routes');
const { setupWebSocket } = require('./websocket');
const auditService = require('./services/auditService');
const redisUtil = require('./utils/redis');
const dbUtil = require('./utils/db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/', routes);

// 全局未捕获异常处理
process.on('uncaughtException', (err) => {
  logger.error(`未捕获异常: ${err.message}\n${err.stack}`);
  // 仅在致命错误时退出，普通异常记录后继续运行
  if (err.code === 'ERR_SOCKET_EXHAUSTED' || err.message.includes('out of memory')) {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  logger.error(`未处理Promise拒绝: ${reason}`);
});

// 启用 dashboard 模式（缓冲日志供 Web 面板读取）
logger.enableDashboardMode();

// 创建 HTTP 服务器（WebSocket 共享）
const server = http.createServer(app);
setupWebSocket(server);

// 启动服务
async function start() {
  // 初始化 Redis 连接
  try {
    redisUtil.getClient();
    logger.info('[启动] Redis 客户端已初始化');
  } catch (err) {
    logger.error(`[启动] Redis 初始化失败: ${err.message}`);
  }

  // 校验/创建/清理 PG 审计表
  try {
    await auditService.reconcileTables();
    logger.info('[启动] 审计表校验完成');
  } catch (err) {
    logger.error(`[启动] 审计表校验失败: ${err.message}`);
  }

  // 启动同步 Worker 和凌晨定时器
  auditService.startSyncWorker();
  auditService.startDailyTimer();

  server.listen(config.port, () => {
    logger.info(`xiapi 服务启动，端口: ${config.port}`);
    logger.info(`Web 控制面板: http://localhost:${config.port}`);
  });
}

start().catch((err) => {
  logger.error(`启动失败: ${err.message}`);
  process.exit(1);
});

// 优雅退出
async function gracefulShutdown(signal) {
  logger.info(`收到 ${signal} 信号，正在停止...`);
  const scheduler = require('./scheduler/scheduler');
  scheduler.stop();

  // flush 审计残留数据，关闭 Redis 和 PG
  try {
    await auditService.flush();
  } catch {}
  try {
    await redisUtil.shutdown();
  } catch {}
  try {
    await dbUtil.shutdown();
  } catch {}

  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
