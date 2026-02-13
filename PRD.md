# xiapi - 虾皮商品数据中转API服务 PRD

## 1. 项目概述

### 1.1 项目定位
xiapi 是一个数据中转 API 服务，作为桥梁连接上游任务分发系统（xp-login.szgps.cc）与 tokege 商品数据查询服务（api.tokege.com），实现虾皮（Shopee）商品详情的自动化批量采集与回传。

### 1.2 核心流程
定时拉取商品任务 → 内存队列缓冲 → 查询商品详情 → 立即回调上报

### 1.3 项目地址
D:\闲鱼开发\xiapi

---

## 2. 技术选型

| 类别 | 选型 | 说明 |
|------|------|------|
| 运行时 | Node.js | 异步IO天然优势，适合IO密集型中转服务 |
| Web框架 | Express | 提供健康检查和状态监控接口 |
| HTTP客户端 | axios | 支持拦截器、超时、并发控制 |
| 日志 | winston | 分级日志，支持文件和控制台输出 |
| 配置管理 | dotenv | 环境变量管理 |
| 数据存储 | 纯内存队列 | 无需数据库，重启数据丢失可接受 |

---

## 3. 系统架构

### 3.1 架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                        Scheduler 调度层                           │
│  ┌──────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────┐  │
│  │ pullLoop │ │  batchLoop   │ │ cleanupLoop  │ │callbackRetry│  │
│  │  每5秒    │ │  每2秒检查   │ │   每30秒     │ │Loop 每10秒  │  │
│  └────┬─────┘ └──────┬───────┘ └──────┬───────┘ └─────┬──────┘  │
└───────┼──────────────┼────────────────┼────────────────┼─────────┘
        │              │                │                │
┌───────┼──────────────┼────────────────┼────────────────┼─────────┐
│       v              v                v                v 服务层   │
│ ┌───────────┐  ┌─────────────┐  ┌──────────────┐                │
│ │pullService│  │queryService │  │callbackService│                │
│ │ 拉取任务   │  │ 商品查询     │  │ 回调+重试队列 │                │
│ └─────┬─────┘  └──────┬──────┘  └──────┬───────┘                │
└───────┼────────────────┼────────────────┼────────────────────────┘
        │                │                │
┌───────┼────────────────┼────────────────┼────────────────────────┐
│       v                v                v         基础设施层      │
│   ┌────────┐     ┌──────────┐     ┌────────┐                    │
│   │ http   │     │taskQueue │     │ logger │                    │
│   │HTTP客户端│     │ 内存队列  │     │  日志   │                    │
│   └────────┘     └──────────┘     └────────┘                    │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 四个定时循环

| 循环 | 间隔 | 职责 |
|------|------|------|
| pullLoop | 每5秒 | 从上游拉取10条任务，转换后入队（休眠模式下停止） |
| batchLoop | 每2秒检查 | 队列满100条时触发查询+立即回调；休眠模式下有任务就立即处理 |
| cleanupLoop | 每30秒 | 清理超过24分钟的超时任务 |
| callbackRetryLoop | 每10秒 | 处理回调失败的重试队列 |

---

## 4. 核心业务流程

### 4.1 流程图

```
[每5秒] 拉取上游任务 (10条/次)
         │
         v
    上游返回 { code:200, data:[...] } → 提取 data 数组
         │
         v
    good_id → item_id 转换（保留原good_id）
         │
         v
    入队 taskQueue（去重: shop_id:item_id:country）
         │
         v
    队列累积中...
         │
[每2秒] 检查队列 >= 100？（休眠模式下 > 0 即触发）
         │           │
         No          Yes
   (继续等待)         │
                     v
              取出任务 (dequeue)
                     │
                     v
         ┌─── 10并发处理 ───┐
         │  每个任务独立执行：  │
         │  查询tokege       │
         │      │            │
         │      v            │
         │  有结果？          │
         │   │       │       │
         │  Yes      No      │
         │   │    (code=1000000│
         │   │   或网络异常)   │
         │   v       v       │
         │ 立刻回调  重入队列  │
         └───────────────────┘
                     │
              ┌──────┴──────┐
              v              v
         回调成功        回调失败
              │              │
              v              v
        释放去重键     进入重试队列
                    [每10秒] 重试
                     最多重试5次
                         │
                  超限 → 丢弃并释放去重键

         ──── 休眠机制 ────
    回调成功累计达到50条 → 进入休眠模式
      ├─ 停止拉取新任务
      ├─ 队列中剩余任务立即处理（不等满100）
      └─ 回调和回调重试继续执行

         ──── 超时清理 ────
    [每30秒] 扫描队列
     超过24分钟 → 丢弃并释放去重键
```

### 4.2 详细步骤说明

#### 步骤1：任务拉取
- 每5秒调用上游 API 拉取最多10条任务
- 上游返回格式为 `{ code: 200, message: "操作成功", data: [...] }`，从 `data` 字段提取任务数组
- 将返回数据中的 `good_id` 字段转换为 `item_id`（同时保留原 `good_id` 供回调使用）
- 存入内存任务队列，自动去重

#### 步骤2：任务累积
- 队列使用 `shop_id:item_id:country` 组合键进行去重
- 每个任务记录 `enqueue_time`（入队时间戳），用于超时计算

#### 步骤3：查询+立即回调
- 每2秒检查队列长度，达到100条时触发（休眠模式下有任务就触发）
- 从队列头部取出任务
- 以10个并发执行，每个任务独立完成 **查询→立即回调** 的完整流程，无需等待其他任务
- `language` 参数固定为 `"zh-Hant"`

#### 步骤4：tokege 结果分类处理

| tokege 响应 | 处理方式 |
|------------|----------|
| HTTP 200, `_success: true` | **立即回调**（查询成功） |
| HTTP 200, `_success: false` | **立即回调**（有明确结果） |
| HTTP 400, code 1100002 ("Product is being processed") | **立即回调**（不重试，将原始响应回传） |
| HTTP 400, code 1000000 ("Unknown error") | **重新入队**（等待下次批量重试） |
| HTTP 400, 其他 code | **立即回调**（有明确结果，不重试） |
| 网络超时/无响应 | **重新入队**（等待下次批量重试） |

#### 步骤5：回调失败处理
- 回调失败的任务进入**回调重试队列**（保留 task + data，不重新查询）
- 每10秒处理重试队列，最多重试5次
- 超过5次仍失败则丢弃，释放去重键

#### 步骤6：休眠模式
- 当回调成功的累计数量达到50条时，自动进入休眠模式
- 休眠模式行为：
  - **停止 pullLoop**：不再从上游拉取新任务
  - **batchLoop 降低阈值**：队列有任务就立即处理，不等满100条
  - **回调和重试继续**：callbackRetryLoop 正常运行
- 队列清空且重试队列为空后，服务空转等待

#### 步骤7：超时清理
- 每30秒扫描队列，移除 `enqueue_time` 距今超过24分钟的任务
- 超时任务直接丢弃，同时释放去重键

#### 步骤8：任务移除
- 任务在以下情况下从队列中移除：
  - **回调成功**：查询完成且回调上报成功后移除
  - **回调重试超限**：重试5次仍失败后丢弃
  - **超时丢弃**：入队超过24分钟后由清理循环移除

---

## 5. 外部接口规范

### 5.1 上游拉取接口

**GET** `https://xp-login.szgps.cc/good/detail/user/list`

#### 请求参数

| 名称 | 位置 | 类型 | 必选 | 说明 |
|------|------|------|------|------|
| down_stream_vendor_name | query | string | 是 | 固定值：`vendor_five` |
| Authorization | header | string | 是 | 固定Token（见配置参数章节） |
| pull_size | query | integer | 否 | 拉取数量，固定传10 |

#### 返回示例（200）

```json
{
  "code": 200,
  "message": "操作成功",
  "data": [
    {
      "shop_id": "22139022",
      "good_id": "16431643834",
      "country": "tw",
      "trace_id": "698f5118463506a6cb1373b4",
      "add_time": "2026-02-14 00:37:42"
    }
  ],
  "timestamp": 1771000662184
}
```

#### 返回字段

| 字段 | 类型 | 说明 |
|------|------|------|
| code | integer | 状态码，200表示成功 |
| message | string | 状态描述 |
| data | array | 任务数组 |
| data[].shop_id | string | 店铺ID |
| data[].good_id | string | 商品ID（入队时转换为item_id） |
| data[].country | string | 国家代码 |
| data[].trace_id | string | 追踪ID |
| data[].add_time | string | 任务添加时间 |

---

### 5.2 tokege 商品详情查询接口

**POST** `https://api.tokege.com/request/shopee/pdp`

#### 请求头

| 名称 | 值 |
|------|------|
| Authorization | `Bearer a06e09cddb60e69b117e227ca17fa96125c369f8` |
| Content-Type | `application/json` |

#### 请求体

```json
{
  "country": "tw",
  "shop_id": "30975269",
  "item_id": "40267390847",
  "language": "zh-Hant"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| country | string | 来自任务的country字段 |
| shop_id | string | 来自任务的shop_id字段 |
| item_id | string | 来自任务的item_id字段（由good_id转换） |
| language | string | 固定值 `"zh-Hant"` |

#### 返回示例（成功）

```json
{
  "_success": true,
  "response": {
    "data": {
      "item": {
        "item_id": 40267390847,
        "shop_id": 30975269,
        "title": "商品标题...",
        ...
      }
    }
  }
}
```

#### 返回示例（400 - 商品处理中，不重试）

```json
{
  "_success": false,
  "error": {
    "message": "Product is being processed. Please try again later",
    "code": 1100002,
    "data": {}
  }
}
```

#### 返回示例（400 - 未知错误，需重试）

```json
{
  "_success": false,
  "error": {
    "message": "Unknown error",
    "code": 1000000,
    "data": {}
  }
}
```

#### 关键返回字段

| 字段 | 类型 | 说明 |
|------|------|------|
| _success | boolean | 查询是否成功 |
| response | object | 完整的商品详情数据（成功时） |
| error.code | integer | 错误码（失败时） |
| error.message | string | 错误描述（失败时） |

#### 错误码处理策略

| 错误码 | 含义 | 处理 |
|--------|------|------|
| — (200) | 查询成功 | 立即回调 |
| 1100002 | 商品处理中 | 立即回调（不重试） |
| 1000000 | 未知错误 | 重新入队重试 |
| 其他 | 其他业务错误 | 立即回调（不重试） |

---

### 5.3 上游回调接口

**POST** `https://xp-login.szgps.cc/good/detail/user/callback/result`

#### 请求头

| 名称 | 值 |
|------|------|
| Authorization | 同上游拉取接口Token |
| Content-Type | `application/json` |

#### 请求体

```json
{
  "shop_id": "30975269",
  "good_id": "40267390847",
  "country": "tw",
  "trace_id": "abc123",
  "down_stream_vendor_name": "vendor_five",
  "content": "{\"_success\":true,\"response\":{...}}"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| shop_id | string | 店铺ID |
| good_id | string | 商品ID（注意：回调时用原始good_id，不是item_id） |
| country | string | 国家代码 |
| trace_id | string | 追踪ID |
| down_stream_vendor_name | string | 固定值 `"vendor_five"` |
| content | string | tokege API返回的完整JSON（JSON.stringify后的字符串，约110KB/条） |

---

### 5.4 上游统计接口（可选）

**GET** `https://xp-login.szgps.cc/good/detail/user/stats/vendor-submission`

#### 请求参数

| 名称 | 位置 | 类型 | 必选 | 说明 |
|------|------|------|------|------|
| down_stream_vendor_name | query | string | 是 | 供应商名称 |
| start_time | query | integer | 是 | 开始时间戳（毫秒） |
| end_time | query | integer | 是 | 结束时间戳（毫秒） |
| Authorization | header | string | 是 | Token |

#### 返回示例

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "vendorName": "vendor_five",
    "takeCount": 1000,
    "completeCount": 950,
    "checkSuccessCount": 900,
    "checkFailCount": 50,
    "completeRate": "95%",
    "checkSuccessRate": "94.7%",
    "startTime": "2026-02-13 00:00:00",
    "endTime": "2026-02-13 23:59:59"
  },
  "timestamp": 1739462400000
}
```

---

## 6. 内部数据结构

### 6.1 Task 对象

```javascript
{
  shop_id: "30975269",        // 店铺ID
  item_id: "40267390847",     // 商品ID（由good_id转换）
  good_id: "40267390847",     // 原始商品ID（回调时使用）
  country: "tw",              // 国家代码
  trace_id: "abc123",         // 追踪ID
  add_time: "2026-02-13 22:55:11", // 上游返回的添加时间
  enqueue_time: 1739462111000, // 入队时间戳（ms），用于超时计算
  retry_count: 0,             // 重试次数（仅用于日志统计）
  status: "pending"           // 状态：pending | processing
}
```

### 6.2 TaskQueue 队列操作

| 方法 | 说明 |
|------|------|
| `enqueue(tasks)` | 批量入队，自动去重，设置enqueue_time |
| `dequeue(count)` | 从头部取出指定数量任务 |
| `requeue(tasks)` | 失败任务放回队尾（保留原enqueue_time） |
| `purgeExpired(timeoutMs)` | 清除超时任务，释放去重键 |
| `removeKey(task)` | 回调成功后释放去重键 |
| `pendingCount` | 当前待处理任务数量 |
| `getStats()` | 返回统计信息 |

### 6.3 回调重试队列

```javascript
// callbackService 内部维护
retryQueue: [{ task, data, retryCount }]
```

| 操作 | 说明 |
|------|------|
| `addToRetryQueue(task, data)` | 回调失败时加入，retryCount 初始为 1 |
| `processRetryQueue()` | 每10秒执行，重试失败的回调 |
| 最大重试次数 | 5次，超限后丢弃并释放去重键 |

### 6.4 去重策略

- 去重键：`${shop_id}:${item_id}:${country}`
- 入队时检查，重复则跳过
- 释放时机：回调成功后 / 回调重试超限后 / 超时丢弃后

---

## 7. 配置参数

### 7.1 可调参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3000 | 服务监听端口 |
| LOG_LEVEL | info | 日志级别 |
| PULL_INTERVAL | 5000ms | 拉取任务间隔 |
| PULL_SIZE | 10 | 每次拉取数量 |
| BATCH_SIZE | 100 | 批量查询阈值（休眠模式下忽略） |
| BATCH_CHECK_INTERVAL | 2000ms | 检查队列间隔 |
| TASK_TIMEOUT | 24min (1440000ms) | 任务超时时间 |
| CLEANUP_INTERVAL | 30000ms | 超时清理间隔 |
| QUERY_CONCURRENCY | 10 | tokege查询并发数 |
| CALLBACK_CONCURRENCY | 5 | 回调重试并发数 |
| HTTP_TIMEOUT | 30000ms | 通用HTTP请求超时 |
| CALLBACK_TIMEOUT | 20000ms | 回调专用超时（单条约110KB数据） |
| CALLBACK_RETRY_INTERVAL | 10000ms | 回调重试检查间隔 |
| CALLBACK_MAX_RETRY | 5 | 回调最大重试次数 |
| CALLBACK_SUCCESS_LIMIT | 50 | 回调成功上限，达到后进入休眠模式 |

### 7.2 认证信息

| 参数 | 值 |
|------|------|
| UPSTREAM_BASE_URL | `https://xp-login.szgps.cc` |
| UPSTREAM_TOKEN | `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ2ZW5kb3JfZml2ZSIsImlhdCI6MTc3MDcwODUzOSwiZXhwIjo0OTI0MzA4NTM5LCJ0eXBlIjoic3lzdGVtIiwibmFtZSI6InZlbmRvcl9maXZlIn0.ZJbtVKUiK4SlDs5ECY0ytvS9HW2KcLKqbz-TrORcB8Y` |
| VENDOR_NAME | `vendor_five` |
| TOKEGE_BASE_URL | `https://api.tokege.com` |
| TOKEGE_TOKEN | `Bearer a06e09cddb60e69b117e227ca17fa96125c369f8` |
| LANGUAGE | `zh-Hant`（固定值） |

---

## 8. 错误处理策略

| 错误场景 | 处理方式 |
|----------|----------|
| 上游拉取返回非200/网络超时 | WARN日志，跳过本次，5秒后重试 |
| 上游返回空数组 | 正常情况，DEBUG日志，继续等待 |
| tokege查询 `_success:true` | 立即回调 |
| tokege 400 code=1100002 (处理中) | 立即回调（原始响应回传，不重试） |
| tokege 400 code=1000000 (未知错误) | 任务重入队，WARN日志，等待重试 |
| tokege 400 其他code | 立即回调（原始响应回传，不重试） |
| tokege查询网络错误/超时 | 任务重入队，WARN日志，等待重试 |
| 回调接口超时/网络错误 | 进入回调重试队列，每10秒重试，最多5次 |
| 回调重试超限（5次） | 丢弃任务，释放去重键，ERROR日志 |
| 任务超时（24分钟） | INFO日志，任务丢弃 |
| 回调成功达50条 | 进入休眠模式，停止拉取新任务 |
| 未捕获异常 | 全局捕获，记录后退出进程 |
| 未处理Promise拒绝 | 全局捕获，记录后继续运行 |

---

## 9. 项目目录结构

```
xiapi/
├── package.json              # 项目依赖与脚本
├── .env                      # 环境变量（敏感配置，不提交git）
├── .env.example              # 环境变量模板
├── .gitignore                # Git忽略规则
├── PRD.md                    # 本文档
├── 回传数据样板.md             # 回调数据格式示例
├── 测试报告.md                # 运行测试报告
├── 虾皮项目-登录态.md          # 原始API接口文档（参考）
├── 虾皮例子.txt               # tokege API返回数据示例（参考）
│
├── src/
│   ├── index.js              # 应用入口：启动Express + 启动Scheduler
│   ├── config.js             # 集中配置管理
│   │
│   ├── queue/
│   │   └── taskQueue.js      # 内存任务队列（入队/出队/去重/超时清理）
│   │
│   ├── services/
│   │   ├── pullService.js    # 上游任务拉取 + good_id→item_id转换
│   │   ├── queryService.js   # tokege商品查询（错误码分类处理）
│   │   └── callbackService.js # 结果回调上报 + 回调重试队列
│   │
│   ├── scheduler/
│   │   └── scheduler.js      # 定时任务调度器（四个循环 + 休眠模式）
│   │
│   ├── api/
│   │   └── routes.js         # Express路由：健康检查/状态监控
│   │
│   └── utils/
│       ├── logger.js         # winston日志封装
│       └── http.js           # axios HTTP客户端封装
│
└── logs/                     # 日志文件目录（自动创建）
    ├── error.log
    └── combined.log
```

---

## 10. 实现顺序

1. 初始化项目：npm init，安装依赖（express, axios, dotenv, winston），创建目录结构
2. 实现 `config.js` + `logger.js` — 基础设施
3. 实现 `taskQueue.js` — 核心数据结构
4. 实现 `http.js` — HTTP客户端
5. 实现 `pullService.js` — 验证上游API连通性
6. 实现 `queryService.js` — 验证tokege API连通性
7. 实现 `callbackService.js` — 验证回调接口连通性 + 回调重试队列
8. 实现 `scheduler.js` — 串联全部流程（查询→立即回调 + 休眠模式）
9. 实现 `index.js` + `routes.js` — 启动完整服务
10. 端到端测试，调整并发参数
