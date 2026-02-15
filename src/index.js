const http = require('http');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');
const express = require('express');
const routes = require('./api/routes');
const { setupWebSocket } = require('./websocket');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/', routes);

// 全局未捕获异常处理
process.on('uncaughtException', (err) => {
  logger.error(`未捕获异常: ${err.message}\n${err.stack}`);
  process.exit(1);
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
server.listen(config.port, () => {
  logger.info(`xiapi 服务启动，端口: ${config.port}`);
  logger.info(`Web 控制面板: http://localhost:${config.port}`);
});

// 优雅退出
process.on('SIGINT', () => {
  logger.info('收到 SIGINT 信号，正在停止...');
  const scheduler = require('./scheduler/scheduler');
  scheduler.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('收到 SIGTERM 信号，正在停止...');
  const scheduler = require('./scheduler/scheduler');
  scheduler.stop();
  process.exit(0);
});
