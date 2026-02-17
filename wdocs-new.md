
**批量获取新任务**
   ```bash
   GET http://103.207.68.206:3000/api/get/tasks?phone=xxx&limit=2
   ```

   - **phone**：必填，手机号
   - **limit**：选填，每次获取的任务数量，默认 10，最小 1，最大 50

   响应示例：
   ```json
   {
     "code": 200,
     "success": true,
     "tasks": [
       {
         "type": "任务类型",
         "data": {
           "id": 123456,
           "shop_id": "12345",
           "good_id": "67890",
           "country": "tw",
           "trace_id": "trace_001",
           "type": "some_type",
           "created_at": "2024-01-01 12:00:00",
           "token": "新增字段 token"
         }
       }
     ]
   }
  ```




**上传任务**
- **方法**: POST
- **URL**: `https://zb2.eqwofaygdsjko.uk/api/task/submit/v2`
- **说明**: 

- **headers**: 必填，请求头
```json
{
  "Content-Type": "application/json",
  "Authorization": `Bearer ${token}`,
  "Accept": "*/*"
}
```
- **appVersion**: 必填，版本号
- **url**: 必填，商品详情页URL
- **result**: 必填，商品数据JSON字符串
### 参数

```json
{
  "appVersion": "vv2",
  "url": "https://shopee.tw/api/v4/pdp/get_pc?display_model_id=0&item_id=${商品id}&model_selection_logic=3&shop_id=${店铺id}&tz_offset_in_minutes=480&detail_level=0",
  "result": "商品数据JSON字符串"
}
```

### 成功响应

- **状态码**: 200
- **响应体**:

```json
{
  "code": 200,
  "msg": null,
  "data": {
    "code": "SUCCESS",
    "msg": null,
    "taskId": "任务id"
  }
}
```