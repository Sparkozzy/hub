import urllib.request
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

retell_api_key = "key_982c1ff975eac1dcfb90dbcc1dcb"
call_ids = ["call_9a6dd98615cea47d4f37c3fcad4", "call_329d5e64246f31466627c143c69"]

for cid in call_ids:
    req_retell = urllib.request.Request(
        f"https://api.retellai.com/v2/get-call/{cid}",
        headers={"Authorization": f"Bearer {retell_api_key}"},
        method="GET"
    )
    try:
        with urllib.request.urlopen(req_retell) as resp:
            cinfo = json.loads(resp.read().decode())
            print(f"Call ID: {cid}")
            print(f"  To Number: {cinfo.get('to_number')}")
            print(f"  From Number: {cinfo.get('from_number')}")
            print(f"  Status: {cinfo.get('call_status')}")
            print(f"  Reason: {cinfo.get('disconnection_reason')}")
            print(f"  Duration MS: {cinfo.get('duration_ms')}")
            print(f"  Transcript: {cinfo.get('transcript')}")
            print(f"  Summary: {cinfo.get('call_analysis', {}).get('call_summary')}")
    except Exception as e:
        print(f"Call ID {cid} error:", e)
