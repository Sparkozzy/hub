import urllib.request
import json

key = "key_982c1ff975eac1dcfb90dbcc1dcb"

def get(url):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())

print("=== PHONE NUMBERS ===")
try:
    nums = get("https://api.retellai.com/v2/list-phone-numbers")
    if isinstance(nums, list):
        for n in nums:
            print(n)
    else:
        print(nums)
except Exception as e:
    print("Error listing numbers:", e)

print("\n=== RECENT CALLS ===")
try:
    # POST to list-calls
    req = urllib.request.Request(
        "https://api.retellai.com/v2/list-calls",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        data=json.dumps({"limit": 10}).encode(),
        method="POST"
    )
    with urllib.request.urlopen(req) as r:
        calls = json.loads(r.read().decode())
        for c in calls:
            print(f"ID: {c.get('call_id')} | To: {c.get('to_number')} | From: {c.get('from_number')} | Status: {c.get('call_status')} | Reason: {c.get('disconnection_reason')}")
except Exception as e:
    print("Error listing calls:", e)
