import urllib.request
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

url = "https://call-github.bkpxmb.easypanel.host/webhook"
headers = {
    "Content-Type": "application/json",
    "X-API-Key": "mf_sk_2026_pre_call_xK9v3Qm7bR4wT1nZ"
}
payload = {
    "workflow_name": "pre_call_processing",
    "execution_id": "test_exec_002",
    "numero": "+5547991089099",
    "nome": "Pedro",
    "email": "pedroernestozimmermann@gmail.com",
    "agent_id": "agent_fc8cb4a21d63e9e33a495b34ad",
    "Prompt_id": "29",
    "from_number": "+554823980162",
    "contexto": """Retome a ligação:

O cliente prefere que o Gustavo tenha um tom mais animado e envolvente, transmitindo entusiasmo, energia positiva e proximidade durante o atendimento. Ele gostou bastante da introdução sobre a empresa, especialmente por ser uma abordagem simpática, proativa e comercial, que começa com uma saudação positiva, apresenta o consultor e a DFX e conecta o serviço a um benefício para o cliente.

paramos nessa pergunta -( "Legal. Agora o que ele JAMAIS falaria? Tem alguma gíria ou termo técnico proibido para esse perfil?"
[Aguardar e registrar] )

comece retomando a ligação dando um breve panorama sobre a situação e continuando da onde paramos"""
}

req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method="POST")
try:
    with urllib.request.urlopen(req) as resp:
        print("Response status:", resp.status)
        print("Response body:", resp.read().decode())
except urllib.error.HTTPError as e:
    print("HTTPError:", e.code, e.read().decode())
except Exception as e:
    print("Error:", e)
