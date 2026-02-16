const logger = require('../utils/logger');

/**
 * 已处理去重：滚动双桶策略
 * 维护 current + previous 两个 Set，查询时检查两桶。
 * 当 current 达到上限时，丢弃 previous，current 降级为 previous，新建空 current。
 * 始终保持 20万~40万 条覆盖，内存上限 ≈ 56MB。
 */
const PROCESSED_BUCKET_MAX = 200000;

class TaskQueue {
  constructor() {
    this.queue = [];          // 任务数组，头部出队尾部入队
    this.dedupeSet = new Set(); // 在途去重键（任务在处理管线中时持有）
    this._processedCurr = new Set(); // 已处理-当前桶
    this._processedPrev = new Set(); // 已处理-上一桶
    this.stats = {
      totalEnqueued: 0,
      totalDequeued: 0,
      totalRequeued: 0,
      totalExpired: 0,
      totalDuplicate: 0,
    };
  }

  /**
   * 生成去重键
   */
  _makeKey(task) {
    return `${task.shop_id}:${task.item_id}:${task.country}`;
  }

  /**
   * 检查 key 是否在已处理集合中（双桶查询）
   */
  _isProcessedKey(key) {
    return this._processedCurr.has(key) || this._processedPrev.has(key);
  }

  /**
   * 将 key 加入已处理集合，满时自动滚动
   */
  _addProcessedKey(key) {
    this._processedCurr.add(key);
    if (this._processedCurr.size >= PROCESSED_BUCKET_MAX) {
      const dropped = this._processedPrev.size;
      this._processedPrev = this._processedCurr;
      this._processedCurr = new Set();
      logger.info(`[去重] 已处理桶滚动: 淘汰 ${dropped} 条旧记录，保留 ${this._processedPrev.size} 条`);
    }
  }

  /**
   * 批量入队，自动去重
   * 同时检查在途集合和已处理集合，双重拦截
   * @param {Array} tasks - 任务数组
   * @returns {number} 实际入队数量
   */
  enqueue(tasks) {
    let added = 0;

    for (const task of tasks) {
      const key = this._makeKey(task);
      if (this.dedupeSet.has(key) || this._isProcessedKey(key)) {
        this.stats.totalDuplicate++;
        continue;
      }
      this.dedupeSet.add(key);
      this.queue.push({
        ...task,
        retry_count: 0,
        status: 'pending',
      });
      added++;
    }

    this.stats.totalEnqueued += added;
    if (added > 0) {
      logger.debug(`入队 ${added} 条任务，当前队列: ${this.queue.length}`);
    }
    return added;
  }

  /**
   * 从头部取出指定数量任务
   * @param {number} count - 取出数量
   * @returns {Array} 取出的任务
   */
  dequeue(count) {
    const batch = this.queue.splice(0, count);
    batch.forEach(t => { t.status = 'processing'; });
    this.stats.totalDequeued += batch.length;
    logger.debug(`出队 ${batch.length} 条任务，剩余队列: ${this.queue.length}`);
    return batch;
  }

  /**
   * 失败任务放回队尾（保留原 enqueue_time）
   * @param {Array} tasks - 需要重入队的任务
   */
  requeue(tasks) {
    for (const task of tasks) {
      task.status = 'pending';
      task.retry_count = (task.retry_count || 0) + 1;
      this.queue.push(task);
    }
    this.stats.totalRequeued += tasks.length;
    if (tasks.length > 0) {
      logger.debug(`重入队 ${tasks.length} 条任务，当前队列: ${this.queue.length}`);
    }
  }

  /**
   * 静默放回队尾（不增加 retry_count，用于退避等待）
   * @param {Object} task - 需要放回的任务
   */
  requeueSilent(task) {
    task.status = 'pending';
    this.queue.push(task);
  }

  /**
   * 清除超时任务，释放去重键
   * @param {number} timeoutMs - 超时时间（毫秒）
   * @returns {number} 清除的任务数
   */
  purgeExpired(timeoutMs) {
    // 不再使用基于时间的超时清理，由查询和回调阶段的实时检查处理
    return 0;
  }

  /**
   * 任务完成（成功/丢弃/超时），释放在途键并加入已处理集合
   * @param {Object} task - 已完成的任务
   */
  removeKey(task) {
    const key = this._makeKey(task);
    this.dedupeSet.delete(key);
    this._addProcessedKey(key);
  }

  /**
   * 检查任务是否已处理过（用于查询阶段二次拦截）
   * @param {Object} task
   * @returns {boolean}
   */
  isProcessed(task) {
    return this._isProcessedKey(this._makeKey(task));
  }

  /**
   * 当前待处理任务数量
   */
  get pendingCount() {
    return this.queue.length;
  }

  /**
   * 返回统计信息
   */
  getStats() {
    return {
      pending: this.queue.length,
      dedupeKeys: this.dedupeSet.size,
      processedKeys: this._processedCurr.size + this._processedPrev.size,
      ...this.stats,
    };
  }
}

// 导出单例
module.exports = new TaskQueue();
