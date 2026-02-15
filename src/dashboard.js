const blessed = require('blessed');
const config = require('./config');
const scheduler = require('./scheduler/scheduler');
const taskQueue = require('./queue/taskQueue');
const { getQueryStats } = require('./services/queryService');
const { getPullStats } = require('./services/pullService');
const {
  getTotalSuccessCount,
  getTotalDroppedCount,
  getRetryQueueLength,
} = require('./services/callbackService');
const logger = require('./utils/logger');

function createDashboard() {
  const screen = blessed.screen({
    smartCSR: true,
    title: '虾皮数据服务控制台',
    fullUnicode: true,
  });

  // ========== 标题栏 ==========
  const titleBox = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: '{center}{bold}虾皮数据服务控制台{/bold}{/center}',
    tags: true,
    border: { type: 'line' },
    style: {
      fg: 'white',
      bg: 'blue',
      border: { fg: 'blue' },
    },
  });

  // ========== 统计面板 - 左列：数据提供方请求统计 ==========
  const providerBox = blessed.box({
    top: 3,
    left: 0,
    width: '34%',
    height: 10,
    label: ' 数据提供方请求统计 ',
    tags: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'cyan', bold: true },
    },
    padding: { left: 1 },
  });

  // ========== 统计面板 - 中列：客户接口统计 ==========
  const customerBox = blessed.box({
    top: 3,
    left: '34%',
    width: '33%',
    height: 10,
    label: ' 客户接口统计 ',
    tags: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'yellow' },
      label: { fg: 'yellow', bold: true },
    },
    padding: { left: 1 },
  });

  // ========== 统计面板 - 右列：队列状态 ==========
  const queueBox = blessed.box({
    top: 3,
    left: '67%',
    width: '33%+1',
    height: 10,
    label: ' 队列状态 ',
    tags: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'green' },
      label: { fg: 'green', bold: true },
    },
    padding: { left: 1 },
  });

  // ========== 控制栏 ==========
  const controlBox = blessed.box({
    top: 13,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'white' },
    },
    padding: { left: 1 },
  });

  // ========== 实时日志 ==========
  const logBox = blessed.log({
    top: 16,
    left: 0,
    width: '100%',
    height: '100%-16',
    label: ' 实时日志 ',
    tags: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'magenta' },
      label: { fg: 'magenta', bold: true },
    },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      style: { bg: 'blue' },
    },
    mouse: true,
    keys: true,
    vi: true,
    padding: { left: 1 },
  });

  // 添加所有组件到屏幕
  screen.append(titleBox);
  screen.append(providerBox);
  screen.append(customerBox);
  screen.append(queueBox);
  screen.append(controlBox);
  screen.append(logBox);

  // ========== 键盘控制 ==========
  screen.key(['q', 'C-c'], () => {
    scheduler.stop();
    return process.exit(0);
  });

  screen.key(['1'], () => {
    if (!scheduler.isRunning()) {
      scheduler.start();
    }
    screen.render();
  });

  screen.key(['2'], () => {
    if (scheduler.isRunning()) {
      scheduler.stop();
    }
    screen.render();
  });

  screen.key(['3'], () => {
    if (scheduler.isRunning()) {
      scheduler.startPulling();
    }
    screen.render();
  });

  screen.key(['4'], () => {
    scheduler.stopPulling();
    screen.render();
  });

  // ========== 数据更新 ==========
  let lastLogIndex = 0;

  function stripTags(str) {
    return String(str).replace(/\{[^}]+\}/g, '');
  }

  function padLabel(label, value, width) {
    const valueStr = String(value);
    const visibleLen = label.length + stripTags(valueStr).length;
    const padding = Math.max(1, width - visibleLen);
    return label + ' '.repeat(padding) + valueStr;
  }

  function updateDashboard() {
    const qs = getQueryStats();
    const ps = getPullStats();
    const ss = scheduler.getStats();
    const tqs = taskQueue.getStats();
    const cbSuccess = getTotalSuccessCount();
    const cbDropped = getTotalDroppedCount();

    // 数据提供方请求统计
    const endpointTotal = qs.successCount + qs.failureCount + qs.offlineCount;
    const colWidth = 24;
    providerBox.setContent(
      `${padLabel('请求总数:', qs.totalRequests, colWidth)}\n` +
      `${padLabel('成功数:', `{green-fg}${qs.successCount}{/green-fg}`, colWidth)}\n` +
      `${padLabel('失败数:', `{red-fg}${qs.failureCount}{/red-fg}`, colWidth)}\n` +
      `${padLabel('商品下架:', `{gray-fg}${qs.offlineCount}{/gray-fg}`, colWidth)}\n` +
      `${padLabel('商品处理中:', `{yellow-fg}${qs.processingCount}{/yellow-fg}`, colWidth)}\n` +
      `${padLabel('端口总和:', endpointTotal, colWidth)}`
    );

    // 客户接口统计
    const abandonedCount = cbDropped + ss.querySkipCount + tqs.totalExpired;
    customerBox.setContent(
      `${padLabel('拉取任务总数:', ps.totalPulled, colWidth)}\n` +
      `${padLabel('拉取时已过期:', `{yellow-fg}${ps.pullExpired}{/yellow-fg}`, colWidth)}\n` +
      `${padLabel('数据回传成功:', `{green-fg}${cbSuccess}{/green-fg}`, colWidth)}\n` +
      `${padLabel('成功任务数:', `{green-fg}${qs.successCount}{/green-fg}`, colWidth)}\n` +
      `${padLabel('废弃任务数:', `{red-fg}${abandonedCount}{/red-fg}`, colWidth)}`
    );

    // 队列状态
    const activeWorkers = ss.activePullWorkers + ss.activeQueryWorkers + ss.activeCallbackWorkers;
    const totalWorkerConfig = config.scheduler.pullSize + config.scheduler.queryConcurrency + config.scheduler.callbackConcurrency;
    const pullTTL = config.scheduler.pullTaskTimeout;
    const queueTTL = config.scheduler.queueTaskTimeout;
    const formatTime = (ms) => ms >= 60000 ? Math.floor(ms / 60000) + '分' : Math.floor(ms / 1000) + '秒';

    let pullModeText;
    if (ss.workersStopped) {
      pullModeText = '{red-fg}已停止{/red-fg}';
    } else if (ss.sleeping || ss.pullingPaused) {
      pullModeText = '{yellow-fg}已暂停{/yellow-fg}';
    } else {
      pullModeText = '{green-fg}正常{/green-fg}';
    }

    const col3Width = 24;
    queueBox.setContent(
      `${padLabel('当前队列大小:', tqs.pending, col3Width)}\n` +
      `${padLabel('活跃任务数:', activeWorkers, col3Width)}\n` +
      `拉取模式:       ${pullModeText}\n` +
      `${padLabel('拉取时间限制:', formatTime(pullTTL), col3Width)}\n` +
      `${padLabel('队列处理限制:', formatTime(queueTTL), col3Width)}\n` +
      `${padLabel('工作线程数:', totalWorkerConfig, col3Width)}`
    );

    // 控制栏
    const running = scheduler.isRunning();
    const pulling = running && !ss.sleeping && !ss.pullingPaused;
    const statusText = running
      ? '{green-fg}{bold}● 运行中{/bold}{/green-fg}'
      : '{red-fg}{bold}● 已停止{/bold}{/red-fg}';
    const pullText = pulling
      ? '{green-fg}{bold}● 拉取中{/bold}{/green-fg}'
      : '{yellow-fg}{bold}● 已暂停{/bold}{/yellow-fg}';

    controlBox.setContent(
      `${statusText}  ${pullText}  {white-fg}|{/white-fg}  ` +
      `{cyan-fg}[1]{/cyan-fg} 启动任务  ` +
      `{cyan-fg}[2]{/cyan-fg} 停止任务  ` +
      `{cyan-fg}[3]{/cyan-fg} 启动拉取  ` +
      `{cyan-fg}[4]{/cyan-fg} 停止拉取  ` +
      `{white-fg}|{/white-fg}  按 {bold}q{/bold} 退出`
    );

    // 更新日志
    const buffer = logger.getLogBuffer();
    while (lastLogIndex < buffer.length) {
      const line = buffer[lastLogIndex];
      // 根据日志级别添加颜色
      let coloredLine = line;
      if (line.includes('[ERROR]')) {
        coloredLine = `{red-fg}${line}{/red-fg}`;
      } else if (line.includes('[WARN]')) {
        coloredLine = `{yellow-fg}${line}{/yellow-fg}`;
      } else if (line.includes('[控制]')) {
        coloredLine = `{cyan-fg}${line}{/cyan-fg}`;
      }
      logBox.log(coloredLine);
      lastLogIndex++;
    }

    screen.render();
  }

  // 每秒刷新一次
  const updateTimer = setInterval(updateDashboard, 1000);

  // 初始渲染
  updateDashboard();
  screen.render();

  // 屏幕销毁时清理定时器
  screen.on('destroy', () => {
    clearInterval(updateTimer);
  });

  return screen;
}

module.exports = { createDashboard };
