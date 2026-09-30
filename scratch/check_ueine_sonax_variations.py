import urllib.request
import json
import time

key = "key_982c1ff975eac1dcfb90dbcc1dcb"
supabase_url = "https://ghayhpwthdbmnpsptcnb.supabase.co"
supabase_key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoYXlocHd0aGRibW5wc3B0Y25iIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0NjcxMjcxMywiZXhwIjoyMDYyMjg4NzEzfQ.SQzloQpnsr5fIE_c-t9A565kZNgFtzIMyas0dxaTbeU"

db_ids = [
    ("Option A: +5585998437681", "10a41caa-af99-42d4-9221-df4e95b13ee2"),
    ("Option B: +5585984376811", "6a253ebd-85ab-4ec0-b590-c024cdf45dab"),
    ("Option C: +5585998436811", "b75b474f-97b0-422c-88b9-26d949b3cd6a")
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
                        req_retell = urllib.request.Request(
                            f"https://api.retellai.com/v2/get-call/{cid}",
                            headers={"Authorization": f"Bearer {key}"},
                            method="GET"
                        )
                        with urllib.request.urlopen(req_retell) as r_resp:
                            cinfo = json.loads(r_resp.read().decode())
                            print(f"{label} | Call ID: {cid} | Status: {cinfo.get('call_status')} | Reason: {cinfo.get('disconnection_reason')}")
            else:
                print(f"{label} | Sem dados no Supabase ainda")
    except Exception as e:
        print(f"{label} erro:", e)

