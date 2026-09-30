import urllib.request
import json
import os

api_key = "key_982c1ff975eac1dcfb90dbcc1dcb"

def list_phone_numbers():
    req = urllib.request.Request(
        "https://api.retellai.com/list-phone-numbers",
        headers={"Authorization": f"Bearer {api_key}"},
        method="GET"
    )
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
            print("Phone Numbers:", json.dumps(data, indent=2))
    except Exception as e:
        print("Error listing phone numbers:", e)

def get_agent(agent_id):
    req = urllib.request.Request(
        f"https://api.retellai.com/get-agent/{agent_id}",
        headers={"Authorization": f"Bearer {api_key}"},
        method="GET"
    )
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
            print(f"Agent {agent_id}:", json.dumps(data, indent=2))
    except Exception as e:
        print(f"Error getting agent {agent_id}:", e)

if __name__ == "__main__":
    list_phone_numbers()
    get_agent("agent_fc8cb4a21d63e9e33a495b34ad")
