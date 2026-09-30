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

exec_id = f"exec_ueine_v2_{uuid.uuid4().hex[:8]}"

raw_phone = "85-998437-6811"
digits = "".join(c for c in raw_phone if c.isdigit())
if not digits.startswith("55"):
    formatted_phone = "+55" + digits
else:
    formatted_phone = "+" + digits

print(f"Telefone formatado E.164: {formatted_phone}")
print(f"Nome do lead: Ueine")
print(f"Agente ID: agent_228be054d08159c00806646271")

payload = {
    "workflow_name": "pre_call_processing",
    "execution_id": exec_id,
    "numero": formatted_phone,
    "nome": "Ueine",
    "email": "ueine@exemplo.com",
    "agent_id": "agent_228be054d08159c00806646271",
    "Prompt_id": "10",
    "from_number": "+551127701424",
    "contexto": ""
}

req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method="POST")
try:
    with urllib.request.urlopen(req) as resp:
        print("Response status:", resp.status)
        body = json.loads(resp.read().decode())
        print("Response body:", json.dumps(body, indent=2))
        print("Execution DB ID:", body.get("execution_db_id"))
except urllib.error.HTTPError as e:
    print("HTTPError:", e.code, e.read().decode())
except Exception as e:
    print("Error:", e)
