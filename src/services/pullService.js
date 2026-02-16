const { pullClient } = require('../utils/http');
const config = require('../config');
const logger = require('../utils/logger');

// 拉取统计
const pullStats = {
  totalPulled: 0,
  pullExpired: 0,
};

// 每分钟拉取次数统计（按秒聚合桶）
const pullRateBuckets = new Map(); // secondTimestamp -> count

function updatePullRate() {
  const sec = Math.floor(Date.now() / 1000);
  pullRateBuckets.set(sec, (pullRateBuckets.get(sec) || 0) + 1);
}

/**
 * 从上游批量拉取任务
 * GET /api/get/task?phone=xxx&size=N
 * @param {number} size - 批量拉取数量
 * @returns {Array} 转换后的任务对象数组，无任务返回空数组
 * @throws {Error} 网络/服务器错误时抛出，由调用方处理
 */
async function pullBatchTask(size) {
  const res = await pullClient.get('/api/get/task', {
    params: {
      phone: config.upstream.phone,
      size: size || config.scheduler.batchSize,
    },
  });

  const body = res.data;

  if (!body || !body.success) {
    return [];
  }

  // 兼容两种响应格式：
  // 单个: { success: true, task: { type, data: { ... } } }
  // 批量: { success: true, tasks: [{ type, data: { ... } }, ...] }
  let rawTasks = [];
  if (body.tasks && Array.isArray(body.tasks)) {
    rawTasks = body.tasks;
  } else if (body.task && body.task.data) {
    rawTasks = [body.task];
  } else {
    return [];
  }

  const results = [];
  for (const raw of rawTasks) {
    if (!raw || !raw.data) continue;
    const taskData = raw.data;
    const taskType = raw.type;

    // 检查任务是否超时
    if (taskData.created_at) {
      const createdTime = new Date(taskData.created_at).getTime();
      if (Date.now() - createdTime > config.scheduler.pullTaskTimeout) {
        pullStats.pullExpired++;
        continue;
      }
    }

    pullStats.totalPulled++;
    updatePullRate();

    results.push({
      shop_id: taskData.shop_id,
      item_id: taskData.good_id,
      good_id: taskData.good_id,
      country: taskData.country,
      trace_id: taskData.trace_id,
      type: taskType,
      created_at: taskData.created_at,
      token: taskData.token,
    });
  }

  return results;
}

/**
 * 从上游拉取单个任务（兼容旧逻辑）
 * @returns {Object|null}
 * @throws {Error}
 */
async function pullSingleTask() {
  const tasks = await pullBatchTask(1);
  return tasks.length > 0 ? tasks[0] : null;
}

/**
 * 获取拉取统计
 */
function getPullStats() {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 120;
  let ratePerMin = 0;
  for (const [sec, count] of pullRateBuckets) {
    if (sec < cutoff) {
      pullRateBuckets.delete(sec);
    } else if (sec >= now - 60) {
      ratePerMin += count;
    }
  }
  return { ...pullStats, pullRatePerMin: ratePerMin };
}

module.exports = { pullSingleTask, pullBatchTask, getPullStats };
