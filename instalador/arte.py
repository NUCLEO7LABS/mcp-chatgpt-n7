# Gera as imagens do instalador a partir de logo.png (a logo do ClauGPT MCP, 1254×1254):
#   icone.ico                 ícone do .exe e do desinstalador (círculo da logo, sem o fundo quadrado)
#   cabecalho.bmp             logo pequena no cabeçalho das telas do desinstalador
#   splash.bmp                logo redonda que surge em fade ao abrir o .exe (o magenta vira transparente)
# Uso: python3 arte.py   (na pasta instalador)
from PIL import Image, ImageDraw

FUNDO = (10, 14, 18)

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


# Cabeçalho das telas do desinstalador: 150×57 (tamanho padrão do Modern UI), feito em 2× para ficar nítido.
cab = Image.new("RGB", (300, 114), FUNDO)
m = logo_redonda(96)
cab.paste(m, (300 - 96 - 14, 9), m)
cab.save("cabecalho.bmp")

# Splash: a logo redonda solta na tela. O magenta (FF00FF) é a cor que o AdvSplash deixa transparente; a
# máscara é sem suavização para não sobrar borda rosa (a borda da logo já é escura).
L2 = 380
sp = logo.crop((int(L * 0.005), int(L * 0.005), L - int(L * 0.005), L - int(L * 0.005))).resize((L2, L2), Image.LANCZOS)
fundo_sp = Image.new("RGB", (L2, L2), (255, 0, 255))
mascara = Image.new("1", (L2, L2), 0)
ImageDraw.Draw(mascara).ellipse([3, 3, L2 - 4, L2 - 4], fill=1)
fundo_sp.paste(sp, (0, 0), mascara)
fundo_sp.save("splash.bmp")
