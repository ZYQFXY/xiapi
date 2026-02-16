const axios = require('axios');
const http = require('http');
const https = require('https');
const config = require('../config');
const logger = require('./logger');

// 连接复用 Agent，各客户端独立 Agent 避免互相争抢连接
const pullHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 60 });
const pullHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 60 });
const uploadHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 200 });
const uploadHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 200 });
const tokegeHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 500 });
const tokegeHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 500 });

/**
 * 上游拉取任务 HTTP 客户端（103.207.68.206:3000）
 * 使用独立的 pullTimeout，避免被短超时误杀
 */
const pullClient = axios.create({
  baseURL: config.upstream.pullBaseUrl,
  timeout: config.pullTimeout,
  headers: { 'Content-Type': 'application/json' },
  httpAgent: pullHttpAgent,
  httpsAgent: pullHttpsAgent,
});

/**
 * 上游上传任务 HTTP 客户端（103.207.68.206:9000）
 */
const uploadClient = axios.create({
  baseURL: config.upstream.uploadBaseUrl,
  timeout: config.httpTimeout,
  headers: { 'Content-Type': 'application/json' },
  httpAgent: uploadHttpAgent,
  httpsAgent: uploadHttpsAgent,
});

/**
 * tokege HTTP 客户端（api.tokege.com）
 */
const tokegeClient = axios.create({
  baseURL: config.tokege.baseUrl,
  timeout: config.httpTimeout,
  headers: {
    Authorization: config.tokege.token,
    'Content-Type': 'application/json',
  },
  httpAgent: tokegeHttpAgent,
  httpsAgent: tokegeHttpsAgent,
});

// 请求拦截器 - 记录请求
[pullClient, uploadClient, tokegeClient].forEach(client => {
  client.interceptors.request.use(req => {
    logger.debug(`HTTP ${req.method.toUpperCase()} ${req.baseURL}${req.url}`);
    return req;
  });

  client.interceptors.response.use(
    res => {
      logger.debug(`HTTP ${res.status} ${res.config.url}`);
      return res;
    },
    err => {
      const url = err.config ? `${err.config.baseURL}${err.config.url}` : 'unknown';
      const status = err.response ? err.response.status : 'NETWORK_ERROR';
      logger.warn(`HTTP 错误 ${status} ${url}: ${err.message}`);
      return Promise.reject(err);
    }
  );
});

module.exports = { pullClient, uploadClient, tokegeClient };
