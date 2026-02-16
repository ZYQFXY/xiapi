/**
 * 测试脚本：向上游重复回调同一条数据，观察返回值差异
 *
 * 因为当前没有可拉取的任务，使用一个虚构的 good_id 来测试。
 * 同一条数据回调两次，对比两次响应看上游是否有去重判断。
 */

const axios = require('axios');

const UPLOAD_BASE = 'http://103.207.68.206:9000';
const PHONE       = '18888888888';
const COUNTRY     = 'tw';

// 构造一条测试任务（使用随机 ID 确保第一次是新数据）
const testTask = {
  type: 'goods',
  shop_id: '100000_test',
  good_id: 'dup_test_' + Date.now(),
  country: COUNTRY,
  trace_id: 'trace_test_' + Date.now(),
  token: '',
};

async function callbackOnce(label) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`${label}`);
  console.log('='.repeat(50));

  const payload = {
    type: testTask.type,
    task: {
      shop_id: testTask.shop_id,
      good_id: testTask.good_id,
      country: testTask.country,
      trace_id: testTask.trace_id,
      content: { test: true, msg: 'duplicate-test', ts: Date.now() },
      phone: PHONE,
      token: testTask.token,
    },
  };

  console.log('请求 URL:', `${UPLOAD_BASE}/task/api/json/upload`);
  console.log('请求 payload:', JSON.stringify(payload, null, 2));

  try {
    const res = await axios.post(`${UPLOAD_BASE}/task/api/json/upload`, payload, {
      timeout: 15000,
      // 不让 axios 对非 2xx 抛异常，这样可以看到所有状态码的响应
      validateStatus: () => true,
    });
    console.log('\n--- 响应 ---');
    console.log('HTTP status:', res.status);
    console.log('响应 body:', JSON.stringify(res.data, null, 2));
    console.log('body 类型:', typeof res.data);
    if (typeof res.data === 'object' && res.data !== null) {
      console.log('body.status:', res.data.status);
      console.log('body.message:', res.data.message);
      console.log('body 所有 key:', Object.keys(res.data));
    }
    return { httpStatus: res.status, body: res.data };
  } catch (err) {
    console.error('请求异常:', err.message);
    return { error: err.message };
  }
}

async function main() {
  console.log('测试数据:');
  console.log('  shop_id:', testTask.shop_id);
  console.log('  good_id:', testTask.good_id);
  console.log('  trace_id:', testTask.trace_id);

  // 第一次回调
  const res1 = await callbackOnce('第 1 次回调（首次提交）');

  // 等 2 秒
  console.log('\n... 等待 2 秒 ...');
  await new Promise(r => setTimeout(r, 2000));

  // 第二次回调（完全相同的 good_id）
  const res2 = await callbackOnce('第 2 次回调（重复提交，相同 good_id）');

  // 等 2 秒
  console.log('\n... 等待 2 秒 ...');
  await new Promise(r => setTimeout(r, 2000));

  // 第三次回调（再来一次确认）
  const res3 = await callbackOnce('第 3 次回调（第三次重复）');

  // 对比
  console.log('\n' + '='.repeat(50));
  console.log('对比汇总');
  console.log('='.repeat(50));
  console.log('第1次 → HTTP:', res1.httpStatus, '| body.status:', res1.body?.status, '| msg:', res1.body?.message);
  console.log('第2次 → HTTP:', res2.httpStatus, '| body.status:', res2.body?.status, '| msg:', res2.body?.message);
  console.log('第3次 → HTTP:', res3.httpStatus, '| body.status:', res3.body?.status, '| msg:', res3.body?.message);

  const allSame = JSON.stringify(res1.body) === JSON.stringify(res2.body) && JSON.stringify(res2.body) === JSON.stringify(res3.body);
  console.log('\n三次响应完全相同:', allSame);
  if (!allSame) {
    console.log('>>> 上游有去重判断，重复数据返回不同响应！');
  } else {
    console.log('>>> 上游对重复数据返回完全相同的响应（无法通过响应体区分）');
  }
}

main().catch(console.error);
