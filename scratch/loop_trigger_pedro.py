import urllib.request
import json
import uuid
import time
import sys

sys.stdout.reconfigure(encoding='utf-8')

url = "https://call-github.bkpxmb.easypanel.host/webhook"
headers = {
    "Content-Type": "application/json",
    "X-API-Key": "mf_sk_2026_pre_call_xK9v3Qm7bR4wT1nZ"
}

retell_key = "key_982c1ff975eac1dcfb90dbcc1dcb"
supabase_url = "https://ghayhpwthdbmnpsptcnb.supabase.co"
supabase_key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoYXlocHd0aGRibW5wc3B0Y25iIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0NjcxMjcxMywiZXhwIjoyMDYyMjg4NzEzfQ.SQzloQpnsr5fIE_c-t9A565kZNgFtzIMyas0dxaTbeU"

target_number = "+5543996727285"
agent_id = "agent_228be054d08159c00806646271"
prompt_id = "10"
from_number = "+554823980162"

def trigger_call():
    exec_id = f"exec_loop_pedro_{uuid.uuid4().hex[:8]}"
    payload = {
        "workflow_name": "pre_call_processing",
        "execution_id": exec_id,
        "numero": target_number,
        "nome": "Pedro",
        "email": "pedro@exemplo.com",
        "agent_id": agent_id,
        "Prompt_id": prompt_id,
        "from_number": from_number,
        "contexto": ""
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method="POST")
    with urllib.request.urlopen(req) as resp:
        body = json.loads(resp.read().decode())
        return body.get("execution_db_id")

def get_call_id(db_id):
    for _ in range(10):
        time.sleep(2)
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
                            return cid
        except Exception:
            pass
    return None

def monitor_call(cid):
    print(f"Monitorando chamada {cid}...")
    for _ in range(30):
        time.sleep(3)
        try:
            req_retell = urllib.request.Request(
                f"https://api.retellai.com/v2/get-call/{cid}",
                headers={"Authorization": f"Bearer {retell_key}"},
                method="GET"
            )
            with urllib.request.urlopen(req_retell) as r_resp:
                cinfo = json.loads(r_resp.read().decode())
                status = cinfo.get("call_status")
                print(f"  Status atual: {status}")
                if status in ["ended", "not_connected", "error"]:
                    print(f"  Chamada finalizada! Motivo: {cinfo.get('disconnection_reason')}")
                    return cinfo
        except Exception as e:
            print("  Erro na monitoria:", e)
    return None

print("=== INICIANDO LOOP DE DISPAROS PARA PEDRO ===")
for i in range(1, 20):
    print(f"\n--- TENTATIVA #{i} ---")
    try:
        db_id = trigger_call()
        print(f"Disparo #{i} enviado com DB_ID: {db_id}")
        cid = get_call_id(db_id)
        if cid:
            res = monitor_call(cid)
        else:
            print("Não foi possível obter Retell Call ID.")
    except Exception as e:
        print("Erro no disparo:", e)
    
    print("Aguardando 10 segundos antes do próximo disparo...")
    time.sleep(10)

