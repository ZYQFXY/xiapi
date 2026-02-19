import requests
# youdiannaozidoubuhuizhaochao
b0_url = "https://zb2.eqwofaygdsjko.uk:443/api/user/login"


b0_headers = {"Content-Type": "application/json",
              "Accept": "*/*",
              "Connection": "keep-alive"}
b0_json = {"password": "passsss",
           "username": "userrrrr"}

res = requests.post(b0_url, headers=b0_headers, json=b0_json)
print(res.text)
