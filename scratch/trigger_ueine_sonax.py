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

exec_id = f"exec_ueine_sonax_{uuid.uuid4().hex[:8]}"

payload = {
    "workflow_name": "pre_call_processing",
    "execution_id": exec_id,
    "numero": "+55859984376811",
    "nome": "Ueine",
    "email": "ueine@exemplo.com",
    "agent_id": "agent_228be054d08159c00806646271",
    "Prompt_id": "10",
    "from_number": "+41996852463",
    "contexto": ""
}

req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method="POST")
try:
    with urllib.request.urlopen(req) as resp:
        body = json.loads(resp.read().decode())
        print("Disparo Sonax efetuado com sucesso!")
        print("Status:", resp.status)
        print("Execution DB ID:", body.get("execution_db_id"))
except Exception as e:
    print("Erro ao disparar:", e)
