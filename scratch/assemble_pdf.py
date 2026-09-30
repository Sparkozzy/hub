import sys
import os
import glob
from PIL import Image
import io
import img2pdf

sys.stdout.reconfigure(encoding='utf-8')

slides_dir = r"c:\Users\pedro\mindflow-motion\scratch\slides_tmp"
pdf_path = r"c:\Users\pedro\mindflow-motion\apresentacao-institucional.pdf"

os.makedirs(slides_dir, exist_ok=True)

# Collect PNG slides (prefer PNG, fallback to JPEG)
pngs = sorted(glob.glob(os.path.join(slides_dir, "slide_*.png")))
jpegs_fallback = sorted(glob.glob(os.path.join(slides_dir, "slide_*.jpg")))
slides = pngs or jpegs_fallback

if not slides:
    print("ERRO: Nenhum slide encontrado em", slides_dir)
    sys.exit(1)

print(f"Encontrados {len(slides)} slides")

# Convert PNGs to high-quality JPEG in memory (quality 95 = visually lossless)
# subsampling=0 = 4:4:4 chroma, avoids artifacts on gradients
jpeg_bufs = []
for slide_path in slides:
    img = Image.open(slide_path)
    if img.mode in ('RGBA', 'P'):
        img = img.convert('RGB')
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=95, subsampling=0)
    buf.seek(0)
    data = buf.read()
    jpeg_bufs.append(data)
    print(f"  {os.path.basename(slide_path)}: {os.path.getsize(slide_path)//1024}KB PNG -> {len(data)//1024}KB JPEG")

print(f"\nMontando PDF com img2pdf ({len(jpeg_bufs)} slides)...")

# 1920x1080 at 96dpi = 20in x 11.25in
layout = img2pdf.get_layout_fun(
    pagesize=(img2pdf.in_to_pt(20), img2pdf.in_to_pt(11.25))
)

with open(pdf_path, "wb") as f:
    f.write(img2pdf.convert(jpeg_bufs, layout_fun=layout))

size_mb = os.path.getsize(pdf_path) / 1024 / 1024
print(f"\nPDF GERADO COM SUCESSO!")
print(f"Tamanho: {os.path.getsize(pdf_path)} bytes ({size_mb:.2f} MB)")
print(f"Caminho: {pdf_path}")
