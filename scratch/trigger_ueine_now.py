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

# Números formatados E.164 com 11 dígitos para o Brasil (+5585...)
numbers_to_try = [
    "+5585984376811",
    "+5585998436811"
]

providers = ["+41996852463", "+554823980162"]

for num in numbers_to_try:
    for prov in providers:
        exec_id = f"exec_ueine_now_{uuid.uuid4().hex[:6]}"
        payload = {
            "workflow_name": "pre_call_processing",
            "execution_id": exec_id,
            "numero": num,
            "nome": "Ueine",
            "email": "ueine@exemplo.com",
            "agent_id": "agent_228be054d08159c00806646271",
            "Prompt_id": "10",
            "from_number": prov,
            "contexto": ""
        }
        req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req) as resp:
                body = json.loads(resp.read().decode())
                print(f"DISPARO ENVIADO: {num} via {prov} | Status: {resp.status} | DB_ID: {body.get('execution_db_id')}")
        except Exception as e:
            print(f"ERRO ({num} via {prov}):", e)
