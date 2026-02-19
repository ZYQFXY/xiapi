const Redis = require('ioredis');
const config = require('../config');
const logger = require('./logger');

let client = null;

function getClient() {
  if (client) return client;

  const opts = {
    host: config.redis.host,
    port: config.redis.port,
    db: config.redis.db,
    retryStrategy(times) {
      const delay = Math.min(times * 2000, 100000);
      logger.warn(`[Redis] 第 ${times} 次重连，${delay}ms 后重试`);
      return delay;
    },
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  };

  if (config.redis.password) {
    opts.password = config.redis.password;
  }

  client = new Redis(opts);

  client.on('connect', () => logger.info('[Redis] 连接成功'));
  client.on('error', (err) => logger.error(`[Redis] 错误: ${err.message}`));
  client.on('close', () => logger.warn('[Redis] 连接关闭'));

  return client;
}

function isReady() {
  return client && client.status === 'ready';
}

async function shutdown() {
  if (client) {
    await client.quit().catch(() => {});
    client = null;
    logger.info('[Redis] 已关闭');
  }
}

module.exports = { getClient, isReady, shutdown };
