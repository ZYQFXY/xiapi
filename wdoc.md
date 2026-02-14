**获取新任务**
   ```bash
   GET http://101.34.226.247/api/get/newtask?phone=18888888888&country=tw
   ```
   

   响应示例：
   ```json
   {
     "code": 200,
     "success": true,
     "task": {
       "type": "some_type",
       "data": {
         "id": 123456,
         "shop_id": "12345",
         "good_id": "67890",
         "country": "tw",
         "trace_id": "trace_001",
         "type": "some_type",
         "created_at": "2024-01-01 12:00:00"
       }
     }
   }
   ```


**上传任务**
- **方法**: POST
- **URL**: `http://118.25.45.42:9000/task/api/complete/upload`
- **说明**: 

### 参数

```json
{
  "type": "任务类型",
  "task": {
    "shop_id": "店铺id",
    "good_id": "商品id",
    "country": "国家",
    "trace_id": "任务id",
    "content": "商品数据内容json字符串",
    "phone": "18888888888"
  }
}
```

### 成功响应

- **状态码**: 200
- **响应体**:

```json
{
  "code": 200,
  "success": true,
  "data": {}
}
```