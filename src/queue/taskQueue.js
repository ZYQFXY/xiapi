const logger = require('../utils/logger');

class TaskQueue {
  constructor() {
    this.queue = [];          // 任务数组，头部出队尾部入队
    this.dedupeSet = new Set(); // 去重键集合
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
   * 批量入队，自动去重，设置 enqueue_time
   * @param {Array} tasks - 任务数组
   * @returns {number} 实际入队数量
   */
  enqueue(tasks) {
    let added = 0;
    const now = Date.now();

    for (const task of tasks) {
      const key = this._makeKey(task);
      if (this.dedupeSet.has(key)) {
        this.stats.totalDuplicate++;
        continue;
      }
      this.dedupeSet.add(key);
      this.queue.push({
        ...task,
        enqueue_time: now,
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
    const now = Date.now();
    const before = this.queue.length;

    this.queue = this.queue.filter(task => {
      const expired = (now - task.enqueue_time) > timeoutMs;
      if (expired) {
        this.dedupeSet.delete(this._makeKey(task));
        logger.info(`任务超时丢弃: shop_id=${task.shop_id} item_id=${task.item_id} retry=${task.retry_count}`);
      }
      return !expired;
    });

    const purged = before - this.queue.length;
    this.stats.totalExpired += purged;
    return purged;
  }

  /**
   * 回调成功后释放去重键
   * @param {Object} task - 已完成的任务
   */
  removeKey(task) {
    this.dedupeSet.delete(this._makeKey(task));
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
      ...this.stats,
    };
  }
}

// 导出单例
module.exports = new TaskQueue();
