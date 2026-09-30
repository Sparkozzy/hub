import urllib.request
import json
import uuid
import sys

sys.stdout.reconfigure(encoding='utf-8')

url = "https://call-github.bkpxmb.easypanel.host/webhook"
headers = {
    "Content-Type": "application/json",
    "X-API-Key": "mf_sk_2026_pre_call_xK9v3Qm7bR4wT1nZ"
}

providers = ["555196506656", "+41996852463", "iatizeia"]

for p in providers:
    exec_id = f"exec_p_{uuid.uuid4().hex[:6]}"
    payload = {
        "workflow_name": "pre_call_processing",
        "execution_id": exec_id,
        "numero": "+5585984376811",
        "nome": "Ueine",
        "email": "ueine@exemplo.com",
        "agent_id": "agent_228be054d08159c00806646271",
        "Prompt_id": "10",
        "from_number": p,
        "contexto": ""
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read().decode())
            print(f"Provedor {p}: db_id {body.get('execution_db_id')}")
    except Exception as e:
        print(f"Provedor {p} erro:", e)
