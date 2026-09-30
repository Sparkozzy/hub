import urllib.request
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

supabase_url = "https://ghayhpwthdbmnpsptcnb.supabase.co"
supabase_key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoYXlocHd0aGRibW5wc3B0Y25iIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0NjcxMjcxMywiZXhwIjoyMDYyMjg4NzEzfQ.SQzloQpnsr5fIE_c-t9A565kZNgFtzIMyas0dxaTbeU"

req = urllib.request.Request(
    f"{supabase_url}/rest/v1/Prompts?id=eq.29",
    headers={
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}"
    },
    method="GET"
)
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode())
    item = data[0]
    for k, v in item.items():
        if k == 'Prompt_Text' and isinstance(v, str):
            print(f"{k}: length {len(v)} (starts with: {v[:100]}...)")
        else:
            print(f"{k}: {v}")
