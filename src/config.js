require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  logLevel: process.env.LOG_LEVEL || 'info',

  upstream: {
    baseUrl: process.env.UPSTREAM_BASE_URL || 'https://xp-login.szgps.cc',
    token: process.env.UPSTREAM_TOKEN,
    vendorName: process.env.VENDOR_NAME || 'vendor_five',
  },

  tokege: {
    baseUrl: process.env.TOKEGE_BASE_URL || 'https://api.tokege.com',
    token: process.env.TOKEGE_TOKEN,
    language: 'zh-Hant',
  },

  scheduler: {
    pullInterval: parseInt(process.env.PULL_INTERVAL, 10) || 5000,
    pullSize: parseInt(process.env.PULL_SIZE, 10) || 10,
    batchSize: parseInt(process.env.BATCH_SIZE, 10) || 100,
    batchCheckInterval: parseInt(process.env.BATCH_CHECK_INTERVAL, 10) || 2000,
    taskTimeout: parseInt(process.env.TASK_TIMEOUT, 10) || 1500000,
    cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL, 10) || 30000,
    queryConcurrency: parseInt(process.env.QUERY_CONCURRENCY, 10) || 10,
    callbackConcurrency: parseInt(process.env.CALLBACK_CONCURRENCY, 10) || 5,
    callbackRetryInterval: parseInt(process.env.CALLBACK_RETRY_INTERVAL, 10) || 10000,
    callbackMaxRetry: parseInt(process.env.CALLBACK_MAX_RETRY, 10) || 5,
    callbackSuccessLimit: parseInt(process.env.CALLBACK_SUCCESS_LIMIT, 10) || 50,
  },

  httpTimeout: parseInt(process.env.HTTP_TIMEOUT, 10) || 30000,
  callbackTimeout: parseInt(process.env.CALLBACK_TIMEOUT, 10) || 60000,
};
