# Ícone do instalador (icone.ico) e imagem lateral (lateral.bmp). Uso: python3 icone.py icone.ico icone.png lateral.bmp
import sys
from PIL import Image, ImageDraw
S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# fundo em degradê vertical
grad = Image.new("RGBA", (S, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / S
    gd.line([(0, y), (S, y)], fill=(int(0x35 + (0x1d - 0x35) * t), int(0x5b + (0x37 - 0x5b) * t), int(0xf0 + (0xb8 - 0xf0) * t), 255))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=220, fill=255)
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)
# balão de trás (claro translúcido) e da frente (branco)
d.rounded_rectangle([200, 230, 690, 590], radius=110, fill=(255, 255, 255, 120))
d.polygon([(290, 560), (260, 690), (400, 585)], fill=(255, 255, 255, 120))
d.rounded_rectangle([340, 430, 830, 790], radius=110, fill=(255, 255, 255, 255))
d.polygon([(740, 760), (775, 890), (630, 785)], fill=(255, 255, 255, 255))
# três pontos no balão da frente
for cx in (470, 585, 700):
    d.ellipse([cx - 38, 572, cx + 38, 648], fill=(0x25, 0x47, 0xd0, 255))
img.save(sys.argv[1], sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
img.resize((256, 256), Image.LANCZOS).save(sys.argv[2])

# Imagem lateral das telas de boas-vindas e de fim (164×314, BMP de 24 bits).
if len(sys.argv) > 3:
    W, H = 164, 314
    lat = Image.new("RGB", (W, H))
    ld = ImageDraw.Draw(lat)
    for y in range(H):
        t = y / H
        ld.line([(0, y), (W, y)], fill=(int(0x2a + (0x12 - 0x2a) * t), int(0x4f + (0x22 - 0x4f) * t), int(0xe0 + (0x7a - 0xe0) * t)))
    marca = img.resize((112, 112), Image.LANCZOS)
    lat.paste(marca, ((W - 112) // 2, 70), marca)
    lat.save(sys.argv[3], format="BMP")
