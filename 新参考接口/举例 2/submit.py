import requests
# youdiannaozidoubuhuizhaochao
b0_url = "https://zb2.eqwofaygdsjko.uk:443/api/task/submit/v2"
b0_headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer tokenxxxxxxxxxx.xxxxxxxxxx.xxxxxxxxxx",
    "Accept": "*/*"
}
b0_json = {"appVersion": "vv2", "url": "https://shopee.tw/api/v4/pdp/get_pc?display_model_id=0&item_id=29580025419&model_selection_logic=3&shop_id=31188538&tz_offset_in_minutes=480&detail_level=0",
           "result": "xxxxxxxstrstrxxxxxxxxxx",
           }


requests.post(b0_url, headers=b0_headers, json=b0_json)
