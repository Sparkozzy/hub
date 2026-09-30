import os
import subprocess
import sys

html_path = os.path.abspath(r"c:\Users\pedro\mindflow-motion\apresentacao-institucional.html")
pdf_path = os.path.abspath(r"c:\Users\pedro\mindflow-motion\apresentacao-institucional.pdf")

# Test 1: Try Playwright first if available
try:
    from playwright.sync_api import sync_playwright
    print("Tentando via Playwright...")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1920, 'height': 1080})
        page.goto(f"file:///{html_path.replace('\\', '/')}", wait_until="networkidle")
        page.pdf(
            path=pdf_path,
            width="1920px",
            height="1080px",
            landscape=True,
            print_background=True,
            margin={'top': '0px', 'right': '0px', 'bottom': '0px', 'left': '0px'}
        )
        browser.close()
    print("Playwright: PDF gerado com sucesso!")
    sys.exit(0)
except Exception as e:
    print("Playwright não disponível ou falhou:", e)

# Test 2: Edge CLI com --landscape
exe = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
cmd = [
    exe,
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--landscape",
    "--no-pdf-header-footer",
    f"--print-to-pdf={pdf_path}",
    f"file:///{html_path.replace('\\', '/')}"
]

print("Executando Edge CLI com --landscape...")
res = subprocess.run(cmd, capture_output=True, text=True)
print("Returncode:", res.returncode)
if os.path.exists(pdf_path):
    print("Tamanho do PDF:", os.path.getsize(pdf_path))
