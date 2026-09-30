import urllib.request
import json
import time
import sys

sys.stdout.reconfigure(encoding='utf-8')

supabase_url = "https://ghayhpwthdbmnpsptcnb.supabase.co"
supabase_key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoYXlocHd0aGRibW5wc3B0Y25iIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0NjcxMjcxMywiZXhwIjoyMDYyMjg4NzEzfQ.SQzloQpnsr5fIE_c-t9A565kZNgFtzIMyas0dxaTbeU"
retell_api_key = "key_982c1ff975eac1dcfb90dbcc1dcb"
exec_db_id = "2849a0e8-f12d-49b1-b57d-c6fd8b2ecb79"

call_id = None
for attempt in range(15):
    req_steps = urllib.request.Request(
        f"{supabase_url}/rest/v1/workflow_step_executions?execution_id=eq.{exec_db_id}&step_name=eq.pre_call_processing_create_retell_call",
        headers={"apikey": supabase_key, "Authorization": f"Bearer {supabase_key}"},
        method="GET"
    )
    with urllib.request.urlopen(req_steps) as resp:
        steps_data = json.loads(resp.read().decode())
        if steps_data:
            output_data = steps_data[0].get("output_data", {})
            retell_data = output_data.get("data", {})
            call_id = retell_data.get("call_id")
            if call_id:
                print(f"Retell Call ID obtido: {call_id}")
                break
    time.sleep(1)

if not call_id:
    print("Call ID não encontrado a tempo.")
    sys.exit(1)

print("Monitorando a chamada na Retell AI...")
for i in range(18):
    time.sleep(5)
    req_retell = urllib.request.Request(
        f"https://api.retellai.com/v2/get-call/{call_id}",
        headers={"Authorization": f"Bearer {retell_api_key}"},
        method="GET"
    )
    try:
        with urllib.request.urlopen(req_retell) as resp:
            call_info = json.loads(resp.read().decode())
            status = call_info.get("call_status")
            print(f"[{i*5}s] Status da Chamada: {status}")
            
            if status in ["ended", "not_connected", "error"]:
                print("\n--- RELATÓRIO FINAL DA LIGAÇÃO ---")
                print("Call ID:", call_id)
                print("Status Final:", status)
                print("Motivo Desconexão:", call_info.get("disconnection_reason"))
                print("Duração (segundos):", round((call_info.get("duration_ms", 0) or 0) / 1000, 1))
                
                analysis = call_info.get("call_analysis", {})
                print("Sucesso (call_successful):", analysis.get("call_successful"))
                print("Resumo:", analysis.get("call_summary"))
                print("Sentimento:", analysis.get("user_sentiment"))
                print("Caixa Postal?:", analysis.get("in_voicemail"))
                
                transcript = call_info.get("transcript")
                if transcript:
                    print("\n--- TRANSCRIÇÃO ---")
                    print(transcript)
                else:
                    print("\n(Sem transcrição gerada)")
                break
    except Exception as e:
        print("Erro ao consultar Retell:", e)
