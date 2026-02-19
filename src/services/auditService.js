const logger = require('../utils/logger');
const redis = require('../utils/redis');
const db = require('../utils/db');

const BUFFER_KEY = 'audit:buffer';
const BATCH_SIZE = 1000;
const SYNC_INTERVAL = 2000;
const MAX_BUFFER_LEN = 500000; // 缓冲上限 50 万条 (~40MB)，超过则丢弃新写入

let syncTimer = null;
let dailyTimer = null;
let lastDateStr = '';
let syncedCount = 0;
let failedCount = 0;
let droppedCount = 0;

// --- 日期工具 ---

function dateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function todayStr() {
  return dateStr(new Date());
}

function getRetainedDates() {
  const dates = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(dateStr(d));
  }
  return dates;
}

function tableName(ds) {
  return `audit_${ds}`;
}

// --- Redis 写入 ---

async function record(task) {
  try {
    if (!redis.isReady()) {
      logger.warn('[审计] Redis 不可用，存根丢弃');
      return;
    }
    const client = redis.getClient();

    // 检查缓冲水位，超限则丢弃
    const len = await client.llen(BUFFER_KEY);
    if (len >= MAX_BUFFER_LEN) {
      droppedCount++;
      if (droppedCount % 10000 === 1) {
        logger.warn(`[审计] Redis 缓冲已达上限 ${MAX_BUFFER_LEN}，丢弃新存根 (累计丢弃: ${droppedCount})`);
      }
      return;
    }

    const payload = JSON.stringify({
      trace_id: task.trace_id || '',
      shop_id: task.shop_id || '',
      good_id: task.good_id || '',
    });
    await client.lpush(BUFFER_KEY, payload);
  } catch (err) {
    logger.warn(`[审计] 写入 Redis 失败: ${err.message}`);
  }
}

// --- PG 表管理 ---

async function ensureTable(ds) {
  const tbl = tableName(ds);
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${tbl} (
      trace_id VARCHAR(32) NOT NULL,
      shop_id  VARCHAR(20) NOT NULL,
      good_id  VARCHAR(20) NOT NULL
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_${tbl}_trace ON ${tbl} (trace_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_${tbl}_shop_good ON ${tbl} (shop_id, good_id)`);
  logger.info(`[审计] 表 ${tbl} 已就绪`);
}

async function reconcileTables() {
  const retained = getRetainedDates();

  // 创建应有的 3 张表
  for (const ds of retained) {
    await ensureTable(ds);
  }

  // 查询所有 audit_* 表
  const res = await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'audit_%'`
  );

  const retainedSet = new Set(retained.map(tableName));
  for (const row of res.rows) {
    if (!retainedSet.has(row.tablename)) {
      await db.query(`DROP TABLE IF EXISTS ${row.tablename}`);
      logger.info(`[审计] 已删除旧表 ${row.tablename}`);
    }
  }

  lastDateStr = todayStr();
  logger.info(`[审计] 表校验完成，保留: ${retained.map(tableName).join(', ')}`);
}

// --- 同步 Worker (Redis → PG) ---

async function syncBatch() {
  let items = null;
  try {
    const client = redis.getClient();
    if (!redis.isReady()) return;

    // 原子批量取出
    const pipeline = client.pipeline();
    pipeline.lrange(BUFFER_KEY, 0, BATCH_SIZE - 1);
    pipeline.ltrim(BUFFER_KEY, BATCH_SIZE, -1);
    const results = await pipeline.exec();

    items = results[0][1]; // lrange 结果
    if (!items || items.length === 0) return;

    // 检测日期变化
    const today = todayStr();
    if (today !== lastDateStr) {
      logger.info('[审计] 检测到日期变化，重新校验表');
      await reconcileTables();
    }

    // 解析 JSON
    const rows = [];
    for (const raw of items) {
      try {
        const obj = JSON.parse(raw);
        rows.push(obj);
      } catch (e) {
        logger.warn(`[审计] JSON 解析失败: ${raw}`);
      }
    }

    if (rows.length === 0) return;

    // 批量 INSERT
    const tbl = tableName(today);
    const values = [];
    const placeholders = [];
    for (let i = 0; i < rows.length; i++) {
      const offset = i * 3;
      placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
      values.push(rows[i].trace_id, rows[i].shop_id, rows[i].good_id);
    }

    await db.query(
      `INSERT INTO ${tbl} (trace_id, shop_id, good_id) VALUES ${placeholders.join(',')}`,
      values
    );

    items = null; // INSERT 成功，清除引用，不需要回写
    syncedCount += rows.length;
    logger.info(`[审计] 同步 ${rows.length} 条到 ${tbl} (累计: ${syncedCount})`);
  } catch (err) {
    logger.error(`[审计] 同步失败: ${err.message}`);
    failedCount++;

    // PG 写入失败，将已取出的数据 RPUSH 回 Redis 防止丢失
    if (items && items.length > 0 && redis.isReady()) {
      try {
        await redis.getClient().rpush(BUFFER_KEY, ...items);
        logger.warn(`[审计] 已将 ${items.length} 条数据回写 Redis`);
      } catch (pushErr) {
        logger.error(`[审计] 回写 Redis 也失败，丢失 ${items.length} 条: ${pushErr.message}`);
      }
    }
  }
}

function startSyncWorker() {
  if (syncTimer) return;
  syncTimer = setInterval(syncBatch, SYNC_INTERVAL);
  logger.info(`[审计] 同步 Worker 已启动 (间隔 ${SYNC_INTERVAL}ms, 批量 ${BATCH_SIZE})`);
}

function stopSyncWorker() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

// --- 凌晨定时器 ---

function startDailyTimer() {
  if (dailyTimer) return;

  function scheduleNext() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 5, 0); // 00:00:05
    const delay = tomorrow.getTime() - now.getTime();

    dailyTimer = setTimeout(async () => {
      logger.info('[审计] 凌晨定时触发，校验表');
      try {
        await reconcileTables();
      } catch (err) {
        logger.error(`[审计] 凌晨校验失败: ${err.message}`);
      }
      scheduleNext();
    }, delay);

    logger.info(`[审计] 凌晨定时器已设置，${(delay / 1000 / 60).toFixed(0)} 分钟后触发`);
  }

  scheduleNext();
}

function stopDailyTimer() {
  if (dailyTimer) {
    clearTimeout(dailyTimer);
    dailyTimer = null;
  }
}

// --- 查询 ---

async function findByTraceId(traceId) {
  const dates = getRetainedDates();
  const parts = [];
  const params = [];
  let idx = 1;

  for (const ds of dates) {
    parts.push(`SELECT trace_id, shop_id, good_id FROM ${tableName(ds)} WHERE trace_id = $${idx}`);
    params.push(traceId);
    idx++;
  }

  const sql = parts.join(' UNION ALL ');
  const res = await db.query(sql, params);
  return res.rows;
}

async function findByShopAndGood(shopId, goodId, limit = 100) {
  const dates = getRetainedDates();
  const parts = [];
  const params = [];
  let idx = 1;

  for (const ds of dates) {
    parts.push(`SELECT trace_id, shop_id, good_id FROM ${tableName(ds)} WHERE shop_id = $${idx} AND good_id = $${idx + 1}`);
    params.push(shopId, goodId);
    idx += 2;
  }

  const sql = `${parts.join(' UNION ALL ')} LIMIT $${idx}`;
  params.push(limit);
  const res = await db.query(sql, params);
  return res.rows;
}

// --- 统计 ---

async function getStats() {
  const dates = getRetainedDates();
  const tables = {};

  for (const ds of dates) {
    try {
      const res = await db.query(`SELECT COUNT(*) AS cnt FROM ${tableName(ds)}`);
      tables[tableName(ds)] = parseInt(res.rows[0].cnt, 10);
    } catch {
      tables[tableName(ds)] = -1; // 表不存在
    }
  }

  let bufferLen = 0;
  try {
    if (redis.isReady()) {
      bufferLen = await redis.getClient().llen(BUFFER_KEY);
    }
  } catch {}

  return {
    redisBufferLength: bufferLen,
    maxBufferLength: MAX_BUFFER_LEN,
    syncedCount,
    failedCount,
    droppedCount,
    tables,
  };
}

// --- 优雅退出：flush 残留数据 ---

async function flush() {
  logger.info('[审计] 正在 flush 残留数据...');
  stopSyncWorker();
  stopDailyTimer();
  // 尝试最后一次同步
  try {
    await syncBatch();
  } catch (err) {
    logger.error(`[审计] flush 失败: ${err.message}`);
  }
}

module.exports = {
  record,
  reconcileTables,
  startSyncWorker,
  startDailyTimer,
  findByTraceId,
  findByShopAndGood,
  getStats,
  flush,
};
