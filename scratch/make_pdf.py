import subprocess
import os
import sys

edge_paths = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
]

exe = None
for p in edge_paths:
    if os.path.exists(p):
        exe = p
        break

print(f"Browser Exe: {exe}")

html_path = os.path.abspath(r"c:\Users\pedro\mindflow-motion\apresentacao-institucional.html")
pdf_path = os.path.abspath(r"c:\Users\pedro\mindflow-motion\apresentacao-institucional.pdf")

cmd = [
    exe,
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-pdf-header-footer",
    f"--print-to-pdf={pdf_path}",
    f"file:///{html_path.replace('\\', '/')}"
]

print("Executando comando:", " ".join(cmd))
res = subprocess.run(cmd, capture_output=True, text=True)
print("Returncode:", res.returncode)
print("Stdout:", res.stdout)
print("Stderr:", res.stderr)

if os.path.exists(pdf_path):
    print("PDF GERADO COM SUCESSO! Tamanho:", os.path.getsize(pdf_path), "bytes")
else:
    print("PDF NÃO FOI GERADO.")
