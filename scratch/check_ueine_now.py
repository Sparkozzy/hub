import urllib.request
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

supabase_url = "https://ghayhpwthdbmnpsptcnb.supabase.co"
supabase_key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoYXlocHd0aGRibW5wc3B0Y25iIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0NjcxMjcxMywiZXhwIjoyMDYyMjg4NzEzfQ.SQzloQpnsr5fIE_c-t9A565kZNgFtzIMyas0dxaTbeU"
retell_api_key = "key_982c1ff975eac1dcfb90dbcc1dcb"

db_ids = [
    ("+5585984376811 Sonax", "127bd68c-578d-4060-9aea-3df825a5b631"),
    ("+5585998436811 Sonax", "1b474461-304b-4a0b-b43b-23422f1fe3e7")
]

for label, db_id in db_ids:
    req_steps = urllib.request.Request(
        f"{supabase_url}/rest/v1/workflow_step_executions?execution_id=eq.{db_id}&step_name=eq.pre_call_processing_create_retell_call",
        headers={"apikey": supabase_key, "Authorization": f"Bearer {supabase_key}"},
        method="GET"
    )
    try:
        with urllib.request.urlopen(req_steps) as resp:
            steps_data = json.loads(resp.read().decode())
            if steps_data and len(steps_data) > 0:
                for s in steps_data:
                    out = s.get("output_data") or {}
                    retell_data = out.get("data") or {}
                    cid = retell_data.get("call_id")
                    if cid:
                        print(f"Call {label} | Retell Call ID: {cid}")
                        req_retell = urllib.request.Request(
                            f"https://api.retellai.com/v2/get-call/{cid}",
                            headers={"Authorization": f"Bearer {retell_api_key}"},
                            method="GET"
                        )
                        with urllib.request.urlopen(req_retell) as r_resp:
                            cinfo = json.loads(r_resp.read().decode())
                            print(f"  Status: {cinfo.get('call_status')} | Reason: {cinfo.get('disconnection_reason')}")
            else:
                print(f"Call {label} | Processando...")
    except Exception as e:
        print(f"Call {label} erro:", e)
