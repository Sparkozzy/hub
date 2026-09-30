import urllib.request
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

key = "key_982c1ff975eac1dcfb90dbcc1dcb"
cid = "call_9f7d978a6454a467175b45b77fe"

req = urllib.request.Request(
    f"https://api.retellai.com/v2/get-call/{cid}",
    headers={"Authorization": f"Bearer {key}"},
    method="GET"
)

with urllib.request.urlopen(req) as resp:
    info = json.loads(resp.read().decode())
    print("=== STATUS E RESUMO ===")
    print("Call ID:", info.get("call_id"))
    print("Status:", info.get("call_status"))
    print("Reason:", info.get("disconnection_reason"))
    print("Duration:", info.get("duration_ms"), "ms")
    print("Summary:", info.get("call_analysis", {}).get("call_summary"))
    print("\n=== TRANSCRICAO ===")
    print(info.get("transcript"))
