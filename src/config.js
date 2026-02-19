require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3003,
  logLevel: process.env.LOG_LEVEL || 'info',

  upstream: {
    pullBaseUrl: process.env.UPSTREAM_PULL_URL || 'http://103.207.68.206:3000',
    uploadBaseUrl: process.env.UPSTREAM_UPLOAD_URL || 'https://zb2.eqwofaygdsjko.uk',
    phone: process.env.PHONE || '18888888888',
    country: process.env.COUNTRY || 'tw',
    curnumBaseUrl: process.env.CURNUM_BASE_URL || 'http://103.207.68.206:3600',
    curnumApiPath: process.env.CURNUM_API_PATH || '/api/curnum',
  },

  tokege: {
    baseUrl: process.env.TOKEGE_BASE_URL || 'https://api.tokege.com',
    token: process.env.TOKEGE_TOKEN,
    language: 'zh-Hant',
  },

  scheduler: {
    pullInterval: parseInt(process.env.PULL_INTERVAL, 10) || 2000,
    pullSize: parseInt(process.env.PULL_SIZE, 10) || 250,
    batchSize: parseInt(process.env.BATCH_SIZE, 10) || 200,
    batchCheckInterval: parseInt(process.env.BATCH_CHECK_INTERVAL, 10) || 2000,
    taskTimeout: parseInt(process.env.TASK_TIMEOUT, 10) || 1440000,
    pullTaskTimeout: parseInt(process.env.PULL_TASK_TIMEOUT, 10) || 180000,
    queueTaskTimeout: parseInt(process.env.QUEUE_TASK_TIMEOUT, 10) || 280000,
    cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL, 10) || 30000,
    queryConcurrency: parseInt(process.env.QUERY_CONCURRENCY, 10) || 50,
    callbackConcurrency: parseInt(process.env.CALLBACK_CONCURRENCY, 10) || 20,
    callbackProcessInterval: parseInt(process.env.CALLBACK_PROCESS_INTERVAL, 10) || 1000,
    callbackRetryInterval: parseInt(process.env.CALLBACK_RETRY_INTERVAL, 10) || 5000,
    callbackMaxRetry: parseInt(process.env.CALLBACK_MAX_RETRY, 10) || 5,
    callbackSuccessLimit: parseInt(process.env.CALLBACK_SUCCESS_LIMIT, 10) || 10000,
  },

  wecom: {
    webhookKey: process.env.WECOM_WEBHOOK_KEY || '',
  },

  httpTimeout: 0,
  pullTimeout: 0,
  callbackTimeout: 0,
};
