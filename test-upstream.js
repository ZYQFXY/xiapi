const http = require('http');

const PULL_URL = 'http://103.207.68.206:3000/api/get/task?phone=18888888888';
const UPLOAD_URL = 'http://103.207.68.206:9000/task/api/json/upload';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

function httpPost(url, body) {
  const postData = JSON.stringify(body);
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(postData);
    req.end();
  });
}

async function main() {
  console.log('====== 上游接口连通性测试 ======\n');

  // 测试1: 拉取任务接口
  console.log(`[测试1] GET ${PULL_URL}`);
  try {
    const res = await httpGet(PULL_URL);
    console.log(`  状态码: ${res.status}`);
    console.log(`  响应体: ${res.body}`);
    try {
      const json = JSON.parse(res.body);
      if (json.success && json.task && json.task.data) {
        console.log('  结论: 有任务返回 ✓');
        console.log(`  任务详情: shop_id=${json.task.data.shop_id} good_id=${json.task.data.good_id} type=${json.task.type}`);
      } else if (json.success === false || !json.task) {
        console.log('  结论: 上游无可用任务');
      } else {
        console.log('  结论: 响应格式不符合预期，请检查');
      }
    } catch { console.log('  结论: 响应非JSON格式'); }
  } catch (err) {
    console.log(`  错误: ${err.message}`);
    console.log('  结论: 拉取接口不可达');
  }

  console.log();

  // 测试2: 上传接口连通性（发送一个空测试，预期会返回错误但能证明连通）
  console.log(`[测试2] POST ${UPLOAD_URL} (连通性测试)`);
  try {
    const res = await httpPost(UPLOAD_URL, { type: 'test', task: {} });
    console.log(`  状态码: ${res.status}`);
    console.log(`  响应体: ${res.body}`);
    console.log('  结论: 上传接口可达 ✓');
  } catch (err) {
    console.log(`  错误: ${err.message}`);
    console.log('  结论: 上传接口不可达');
  }

  console.log('\n====== 测试结束 ======');
}

main();
