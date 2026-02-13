const config = require('./config');
const logger = require('./utils/logger');
const express = require('express');
const routes = require('./api/routes');
const scheduler = require('./scheduler/scheduler');

const app = express();
app.use(express.json());
app.use('/', routes);

// 全局未捕获异常处理
process.on('uncaughtException', (err) => {
  logger.error(`未捕获异常: ${err.message}\n${err.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`未处理Promise拒绝: ${reason}`);
});

// 启动服务
app.listen(config.port, () => {
  logger.info(`xiapi 服务启动，端口: ${config.port}`);
  scheduler.start();
});

// 优雅退出
process.on('SIGINT', () => {
  logger.info('收到 SIGINT 信号，正在停止...');
  scheduler.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('收到 SIGTERM 信号，正在停止...');
  scheduler.stop();
  process.exit(0);
});
