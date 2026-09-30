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

def trigger(number):
    exec_id = f"exec_ueine_tw_{uuid.uuid4().hex[:8]}"
    payload = {
        "workflow_name": "pre_call_processing",
        "execution_id": exec_id,
        "numero": number,
        "nome": "Ueine",
        "email": "ueine@exemplo.com",
        "agent_id": "agent_228be054d08159c00806646271",
        "Prompt_id": "10",
        "from_number": "+554823980162",
        "contexto": ""
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read().decode())
            print(f"Disparo {number}: status {resp.status}, db_id: {body.get('execution_db_id')}")
            return body.get("execution_db_id")
    except Exception as e:
        print(f"Disparo {number} erro:", e)
        return None

if __name__ == "__main__":
    # Variante 1 (85 99843-6811)
    id1 = trigger("+5585998436811")
    # Variante 2 (85 98437-6811)
    id2 = trigger("+5585984376811")
