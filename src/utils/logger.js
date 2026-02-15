const winston = require('winston');
const path = require('path');
const { Writable } = require('stream');
const config = require('../config');

const logDir = path.resolve(__dirname, '../../logs');

// Dashboard 日志缓冲区
const logBuffer = [];
const MAX_LOG_BUFFER = 500;
let dashboardMode = false;

const consoleTransport = new winston.transports.Console({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level}] ${message}`;
    })
  ),
});

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [
    consoleTransport,
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
    }),
  ],
});

/**
 * 启用 Dashboard 模式：将控制台输出重定向到缓冲区
 */
logger.enableDashboardMode = function () {
  if (dashboardMode) return;
  dashboardMode = true;
  logger.remove(consoleTransport);

  const bufferStream = new Writable({
    write(chunk, encoding, callback) {
      const msg = chunk.toString().trim();
      if (msg) {
        logBuffer.push(msg);
        if (logBuffer.length > MAX_LOG_BUFFER) {
          logBuffer.shift();
        }
      }
      callback();
    },
  });

  logger.add(new winston.transports.Stream({
    stream: bufferStream,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message }) => {
        return `${timestamp} [${level.toUpperCase()}] ${message}`;
      })
    ),
  }));
};

/**
 * 获取日志缓冲区（供 Dashboard 读取）
 */
logger.getLogBuffer = function () {
  return logBuffer;
};

module.exports = logger;
