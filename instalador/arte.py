# Gera as imagens do instalador a partir de logo.png (a logo do ClauGPT MCP, 1254×1254):
#   icone.ico                 ícone do .exe e do desinstalador (círculo da logo, sem o fundo quadrado)
#   painel-100/150/200.bmp    painel com a logo nas telas de boas-vindas e de fim (210×314 px × escala da tela)
#   linha.bmp                 traço em degradê no pé dessas telas
#   cabecalho.bmp             logo pequena no cabeçalho das telas do meio
# Os textos não vão nas imagens: são rótulos de verdade, nítidos em qualquer escala.
# Uso: python3 arte.py   (na pasta instalador)
from PIL import Image, ImageChops, ImageDraw, ImageFilter

FUNDO = (10, 14, 18)
VERDE = (25, 227, 177)
LARANJA = (255, 122, 26)

logo = Image.open("logo.png").convert("RGB")
L = logo.width


def logo_redonda(lado):
    # O círculo de borda colorida ocupa quase a imagem toda; corta um pouco além dele.
    m = int(L * 0.005)
    rec = logo.crop((m, m, L - m, L - m)).resize((lado * 4, lado * 4), Image.LANCZOS)
    mascara = Image.new("L", rec.size, 0)
    ImageDraw.Draw(mascara).ellipse([0, 0, rec.width - 1, rec.height - 1], fill=255)
    rec.putalpha(mascara)
    return rec.resize((lado, lado), Image.LANCZOS)


redonda = logo_redonda(256)
redonda.save("icone.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def brilho(tam, centro, raio, cor, forca):
    camada = Image.new("RGB", tam, (0, 0, 0))
    d = ImageDraw.Draw(camada)
    x, y = centro
    d.ellipse([x - raio, y - raio, x + raio, y + raio], fill=tuple(int(c * forca) for c in cor))
    return camada.filter(ImageFilter.GaussianBlur(raio * 0.6))


def painel(escala):
    # Painel da esquerda das telas de boas-vindas e de fim (210×314 px na escala 1). Na borda direita ele
    # termina exatamente na cor de fundo, para emendar sem costura com a área dos textos, que é cor lisa.
    s = escala
    W, H = round(210 * s), round(314 * s)
    img = Image.new("RGB", (W, H), FUNDO)
    luz = ImageChops.add(
        brilho((W, H), (int(100 * s), int(150 * s)), int(105 * s), VERDE, 0.30),
        brilho((W, H), (int(130 * s), int(300 * s)), int(80 * s), LARANJA, 0.20),
    )
    # Inteira até 50 px e some suavemente até zerar a 200 px, antes da borda direita.
    fade = Image.new("L", (W, H))
    for x in range(W):
        t = min(1.0, max(0.0, (x - 50 * s) / (150 * s)))
        fade.paste(int(255 * (1 - t * t * (3 - 2 * t))), (x, 0, x + 1, H))
    luz = Image.composite(luz, Image.new("RGB", (W, H), (0, 0, 0)), fade)
    img = ImageChops.add(img, luz)
    lado = int(170 * s)
    marca = logo_redonda(lado)
    img.paste(marca, (int(20 * s), H // 2 - lado // 2), marca)
    return img


for nome, escala in (("100", 1), ("150", 1.5), ("200", 2)):
    painel(escala).save(f"painel-{nome}.bmp")

# Linha em degradê no pé das telas, como o traço sob "MCP" na logo (esticada pelo instalador).
linha = Image.new("RGB", (497, 1))
for x in range(497):
    t = x / 496
    linha.putpixel((x, 0), tuple(int(VERDE[i] + (LARANJA[i] - VERDE[i]) * t) for i in range(3)))
linha.save("linha.bmp")

# Cabeçalho das telas do meio: 150×57 (tamanho padrão do Modern UI), feito em 2× para ficar nítido.
cab = Image.new("RGB", (300, 114), FUNDO)
m = logo_redonda(96)
cab.paste(m, (300 - 96 - 14, 9), m)
cab.save("cabecalho.bmp")
