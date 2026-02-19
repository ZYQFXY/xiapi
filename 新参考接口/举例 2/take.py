import requests
# youdiannaozidoubuhuizhaochao
b0_url = "https://zb2.eqwofaygdsjko.uk:443/api/task/take"
b0_headers = {"Authorization": "Bearer tokenxxxxxxxxxx.xxxxxxxxxx.xxxxxxxxxx",
              "Accept": "application/json, text/plain, */*",
              "Content-Type": "application/json"
              }
res = requests.get(b0_url, headers=b0_headers)

print(res.text)
