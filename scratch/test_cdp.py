import os
import time
import json
import subprocess
import urllib.request
import urllib.parse
import base64
import sys

sys.stdout.reconfigure(encoding='utf-8')

html_path = os.path.abspath(r"c:\Users\pedro\mindflow-motion\apresentacao-institucional.html")
pdf_path = os.path.abspath(r"c:\Users\pedro\mindflow-motion\apresentacao-institucional.pdf")
edge_exe = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

# Start Edge with remote debugging
port = 9222
cmd = [
    edge_exe,
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    f"--remote-debugging-port={port}",
    "about:blank"
]

print("Iniciando Edge headless com remote debugging...")
proc = subprocess.Popen(cmd)
time.sleep(2)

try:
    # Get WebSocket Debug URL
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version") as r:
        version_info = json.loads(r.read().decode())
        ws_url = version_info["webSocketDebuggerUrl"]
        print("CDP WebSocket URL:", ws_url)
    
    # We can use python's websocket or urllib/requests if websocket is installed, or native python websocketclient / simple json-rpc over websocket
    # Let's check if websocket is available or write simple WS handshake in python!
except Exception as e:
    print("Erro ao conectar no Edge CDP:", e)

# Kill proc
proc.terminate()
