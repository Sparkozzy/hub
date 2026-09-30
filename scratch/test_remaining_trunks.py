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

# Testar trunks restantes para o Ueine
trunks_to_test = [
    ("iatizeia", "+5585984376811"),
    ("11111", "+5585984376811"),
    ("+555123917176", "+5585984376811"),
    ("iatizeia", "+5585998436811"),
    ("11111", "+5585998436811")
]

for from_num, to_num in trunks_to_test:
    exec_id = f"exec_t_{uuid.uuid4().hex[:6]}"
    payload = {
        "workflow_name": "pre_call_processing",
        "execution_id": exec_id,
        "numero": to_num,
        "nome": "Ueine",
        "email": "ueine@exemplo.com",
        "agent_id": "agent_228be054d08159c00806646271",
        "Prompt_id": "10",
        "from_number": from_num,
        "contexto": ""
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read().decode())
            print(f"Trunk '{from_num}' -> {to_num} | Status: {resp.status} | DB_ID: {body.get('execution_db_id')}")
    except Exception as e:
        print(f"Trunk '{from_num}' erro:", e)
