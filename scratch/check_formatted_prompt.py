import urllib.request
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

supabase_url = "https://ghayhpwthdbmnpsptcnb.supabase.co"
supabase_key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoYXlocHd0aGRibW5wc3B0Y25iIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0NjcxMjcxMywiZXhwIjoyMDYyMjg4NzEzfQ.SQzloQpnsr5fIE_c-t9A565kZNgFtzIMyas0dxaTbeU"

exec_id = "f84f9102-99ac-4371-8d72-a32d33790cd8"

req_steps = urllib.request.Request(
    f"{supabase_url}/rest/v1/workflow_step_executions?execution_id=eq.{exec_id}&step_name=eq.pre_call_processing_format_payload",
    headers={
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}"
    },
    method="GET"
)
with urllib.request.urlopen(req_steps) as resp:
    steps_data = json.loads(resp.read().decode())
    output_data = steps_data[0].get("output_data", {})
    data = output_data.get("data", {})
    prompt = data.get("agent_prompt", "")
    lines = prompt.split('\n')
    for idx, line in enumerate(lines):
        if "Pedro" in line or "customer_name" in line or "contexto" in line.lower():
            print(f"L{idx+1}: {line}")
