const axios = require('axios');
const config = require('../config');
const logger = require('./logger');

/**
 * 上游 HTTP 客户端（xp-login.szgps.cc）
 */
const upstreamClient = axios.create({
  baseURL: config.upstream.baseUrl,
  timeout: config.httpTimeout,
  headers: {
    Authorization: config.upstream.token,
    'Content-Type': 'application/json',
  },
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
});

// 请求拦截器 - 记录请求
[upstreamClient, tokegeClient].forEach(client => {
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

module.exports = { upstreamClient, tokegeClient };
