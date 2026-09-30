import urllib.request
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

api_key = "key_982c1ff975eac1dcfb90dbcc1dcb"
agent_id = "agent_228be054d08159c00806646271"

req = urllib.request.Request(
    f"https://api.retellai.com/get-agent/{agent_id}",
    headers={"Authorization": f"Bearer {api_key}"},
    method="GET"
)
try:
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode())
        print(f"Agent {agent_id}:", json.dumps(data, indent=2, ensure_ascii=False))
except Exception as e:
    print("Error:", e)
