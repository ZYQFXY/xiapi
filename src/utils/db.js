const { Pool } = require('pg');
const config = require('../config');
const logger = require('./logger');

let pool = null;

function getPool() {
  if (pool) return pool;

  pool = new Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    user: config.postgres.user,
    password: config.postgres.password,
    database: config.postgres.database,
    max: config.postgres.max,
  });

  pool.on('connect', () => logger.info('[PG] 连接池就绪'));
  pool.on('error', (err) => logger.error(`[PG] 连接池错误: ${err.message}`));

  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function shutdown() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
    logger.info('[PG] 连接池已关闭');
  }
}

module.exports = { getPool, query, shutdown };
