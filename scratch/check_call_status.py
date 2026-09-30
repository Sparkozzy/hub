import urllib.request
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

api_key = "key_982c1ff975eac1dcfb90dbcc1dcb"
call_id = "call_bdcb4d62544c7e5fdde3b755b06"

req = urllib.request.Request(
    f"https://api.retellai.com/v2/get-call/{call_id}",
    headers={"Authorization": f"Bearer {api_key}"},
    method="GET"
)
try:
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode())
        print("Call Status:", data.get("call_status"))
        print("Disconnection Reason:", data.get("disconnection_reason"))
        print("Transcript:", data.get("transcript"))
        print("Recording URL:", data.get("recording_url"))
except Exception as e:
    print("Error fetching call:", e)
