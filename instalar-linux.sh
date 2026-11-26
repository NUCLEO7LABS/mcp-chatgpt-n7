#!/usr/bin/env bash
# Instalador do ClauGPT MCP para Linux.
#
#   curl -fsSL https://github.com/NUCLEO7LABS/mcp-chatgpt-n7/releases/latest/download/instalar-linux.sh | bash
#
# Faz, sem pedir senha de administrador (tudo fica na pasta do usuário):
#   1. Node.js (usa o do sistema, se for 20 ou mais novo; senão baixa um só para o ClauGPT)
#   2. Codex CLI, a ponte oficial da OpenAI com a sua conta do ChatGPT
#   3. O servidor, da versão mais nova publicada no GitHub (com a impressão digital conferida)
#   4. O modelo de recorte de fundo (171 MB)
#   5. Liga no Claude Code e, se houver, no Claude Desktop
#   6. Login na sua conta do ChatGPT (código de dispositivo)
#   7. Teste com uma pergunta de verdade
# Pode rodar de novo: atualiza o que mudou e pula o que já está pronto.
#
#   bash instalar-linux.sh --remover      desinstala (imagens, kits de marca e o login ficam)
#
# Variáveis opcionais: CLAUGPT_DIR (pasta da instalação), CLAUGPT_PACOTE (um .tar.gz local do servidor,
# em vez do GitHub), CLAUGPT_SEM_LOGIN=1 (pula o login e o teste).

set -euo pipefail
export npm_config_update_notifier=false

REPO="NUCLEO7LABS/mcp-chatgpt-n7"
VERSAO_CODEX="0.166.0"
DIR="${CLAUGPT_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/clauGPT-mcp}"
APP="$DIR/app"
NODE_DIR="$DIR/node"
CODEX_DIR="$DIR/codex"
MODELO="$HOME/.mcp-chatgpt/modelos/isnet-general-use.onnx"
URL_MODELO="https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx"
SHA_MODELO="60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a"
TOTAL=7

# ---------- Cara do terminal ----------
if [ -t 1 ]; then
  VERDE=$'\e[38;5;43m'; LARANJA=$'\e[38;5;208m'; CINZA=$'\e[38;5;245m'; BRANCO=$'\e[1;97m'
  VERMELHO=$'\e[38;5;203m'; AMARELO=$'\e[38;5;221m'; NEGRITO=$'\e[1m'; FIM=$'\e[0m'
else
  VERDE=""; LARANJA=""; CINZA=""; BRANCO=""; VERMELHO=""; AMARELO=""; NEGRITO=""; FIM=""
fi

passo() { printf '\n%s[%s/%s]%s %s%s%s\n' "$VERDE" "$1" "$TOTAL" "$FIM" "$NEGRITO" "$2" "$FIM"; }
ok() { printf '  %s✓%s %s\n' "$VERDE" "$FIM" "$1"; }
aviso() { printf '  %s!%s %s\n' "$AMARELO" "$FIM" "$1"; }
falha() {
  printf '\n  %s✗ %s%s\n' "$VERMELHO" "$1" "$FIM"
  [ -n "${LOG:-}" ] && printf '  %sO registro completo está em %s%s\n' "$CINZA" "$LOG" "$FIM"
  exit 1
}
precisa() { command -v "$1" >/dev/null 2>&1 || falha "Falta o comando \"$1\". Instale pelo gerenciador de pacotes (ex.: sudo apt install $1) e rode de novo."; }

conferir_sha() { # arquivo, impressão digital esperada
  local obtido
  obtido="$(sha256sum "$1" | cut -d' ' -f1)"
  [ "$obtido" = "$2" ] || falha "O arquivo baixado ($(basename "$1")) não confere com a impressão digital publicada. Download corrompido? Rode de novo."
}

titulo() {
  printf '\n%s  ╭───────────────────────────────────────────────╮%s\n' "$VERDE" "$FIM"
  printf '%s  │%s   %sClau%sGPT%s MCP%s  ·  instalador para Linux       %s│%s\n' "$VERDE" "$FIM" "$BRANCO" "$VERDE" "$LARANJA" "$BRANCO" "$LARANJA" "$FIM"
  printf '%s  │%s   %sO ChatGPT dentro do seu Claude%s              %s│%s\n' "$VERDE" "$FIM" "$CINZA" "$FIM" "$LARANJA" "$FIM"
  printf '%s  ╰───────────────────────────────────────────────╯%s\n' "$LARANJA" "$FIM"
}

# ---------- Desinstalar ----------
if [ "${1:-}" = "--remover" ]; then
  titulo
  if [ -f "$APP/registrar.cjs" ]; then
    NODE="$( [ -x "$NODE_DIR/bin/node" ] && echo "$NODE_DIR/bin/node" || command -v node || true )"
    [ -n "$NODE" ] && "$NODE" "$APP/registrar.cjs" --remover || true
  fi
  rm -rf "$DIR"
  ok "ClauGPT MCP removido (o servidor saiu do Claude e a pasta $DIR foi apagada)"
  printf '  %sImagens, kits de marca e o login do ChatGPT ficaram. Para apagar também o modelo de recorte:%s\n' "$CINZA" "$FIM"
  printf '  rm -rf %s\n\n' "$HOME/.mcp-chatgpt"
  exit 0
fi

mkdir -p "$DIR"
LOG="$DIR/instalacao.log"
exec > >(tee -a "$LOG") 2>&1
titulo
printf '  %sPasta: %s%s\n' "$CINZA" "$DIR" "$FIM"
precisa curl
precisa tar
precisa sha256sum

# ---------- 1. Node.js ----------
passo 1 "Node.js"
NODE=""
if command -v node >/dev/null 2>&1; then
  maior="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$maior" -ge 20 ] && NODE="$(command -v node)"
fi
if [ -n "$NODE" ]; then
  ok "o do sistema ($("$NODE" --version))"
elif [ -x "$NODE_DIR/bin/node" ]; then
  NODE="$NODE_DIR/bin/node"
  ok "já instalado para o ClauGPT ($("$NODE" --version))"
else
  case "$(uname -m)" in
    x86_64) arq=x64 ;;
    aarch64 | arm64) arq=arm64 ;;
    *) falha "Este processador ($(uname -m)) não tem Node.js pronto. Instale o Node.js 20 ou mais novo e rode de novo." ;;
  esac
  printf '  Baixando o Node.js 22 (só para o ClauGPT, em %s)...\n' "$NODE_DIR"
  base="https://nodejs.org/dist/latest-v22.x"
  linha="$(curl -fsSL "$base/SHASUMS256.txt" | grep -E " node-v[0-9.]+-linux-$arq\.tar\.gz$")" || falha "Não consegui ver a versão do Node.js. Verifique a internet."
  arquivo="$(echo "$linha" | awk '{print $2}')"
  tmp="$(mktemp -d)"
  curl -fL --progress-bar -o "$tmp/$arquivo" "$base/$arquivo" || falha "O download do Node.js falhou."
  conferir_sha "$tmp/$arquivo" "$(echo "$linha" | awk '{print $1}')"
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/$arquivo" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  NODE="$NODE_DIR/bin/node"
  ok "instalado ($("$NODE" --version))"
fi
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(command -v npm || true)"
[ -n "$NPM" ] || falha "Achei o Node.js, mas não o npm. Instale o npm (ex.: sudo apt install npm) e rode de novo."
export PATH="$(dirname "$NODE"):$PATH"

# ---------- 2. Codex CLI ----------
passo 2 "Codex CLI (a ponte com a sua conta do ChatGPT)"
if command -v codex >/dev/null 2>&1 && [ ! -x "$CODEX_DIR/node_modules/.bin/codex" ]; then
  CODEX_BIN="$(command -v codex)"
  ok "o do sistema ($("$CODEX_BIN" --version 2>/dev/null | tail -1))"
else
  CODEX_BIN="$CODEX_DIR/node_modules/.bin/codex"
  if [ -x "$CODEX_BIN" ] && "$CODEX_BIN" --version 2>/dev/null | grep -q "$VERSAO_CODEX"; then
    ok "já instalado ($VERSAO_CODEX)"
  else
    printf '  Instalando a versão %s...\n' "$VERSAO_CODEX"
    mkdir -p "$CODEX_DIR"
    "$NPM" install --prefix "$CODEX_DIR" "@openai/codex@$VERSAO_CODEX" --no-audit --no-fund --loglevel=error || falha "Não consegui instalar o Codex CLI."
    ok "instalado ($VERSAO_CODEX)"
  fi
fi

# ---------- 3. Servidor ----------
passo 3 "Servidor do ClauGPT MCP"
tmp="$(mktemp -d)"
if [ -n "${CLAUGPT_PACOTE:-}" ]; then
  cp "$CLAUGPT_PACOTE" "$tmp/pacote.tar.gz"
  versao="(pacote local)"
else
  curl -fsSL -o "$tmp/manifesto.json" "https://github.com/$REPO/releases/latest/download/clauGPT-mcp.json" ||
    falha "Não consegui ver a versão mais nova no GitHub. Verifique a internet."
  versao="$("$NODE" -p "require('$tmp/manifesto.json').versao")"
  pacote="$("$NODE" -p "require('$tmp/manifesto.json').pacote")"
  sha="$("$NODE" -p "require('$tmp/manifesto.json').sha256")"
  printf '  Baixando a versão %s...\n' "$versao"
  curl -fsSL -o "$tmp/pacote.tar.gz" "https://github.com/$REPO/releases/download/v$versao/$pacote" || falha "O download do servidor falhou."
  conferir_sha "$tmp/pacote.tar.gz" "$sha"
fi
mkdir -p "$APP"
# Tira o código antigo; node_modules fica, para a reinstalação ser rápida.
rm -rf "$APP/dist" "$APP/src" "$APP/interface"
tar -xzf "$tmp/pacote.tar.gz" -C "$APP"
rm -rf "$tmp"
[ -f "$APP/dist/index.js" ] || falha "O pacote do servidor veio sem o servidor compilado."
printf '  Instalando as bibliotecas (um ou dois minutos)...\n'
(cd "$APP" && ONNXRUNTIME_NODE_INSTALL=skip "$NPM" ci --omit=dev --no-audit --no-fund --loglevel=error) || falha "A instalação das bibliotecas falhou."
(cd "$APP" && "$NODE" -e "require('sharp'); require('onnxruntime-node')") >/dev/null 2>&1 || falha "As bibliotecas de imagem não carregaram neste computador."
ok "versão $versao, em $APP"

navegador=""
for c in google-chrome-stable google-chrome microsoft-edge-stable microsoft-edge chromium chromium-browser brave-browser; do
  if command -v "$c" >/dev/null 2>&1; then navegador="$c"; break; fi
done
if [ -n "$navegador" ]; then
  ok "navegador para montar artes: $navegador"
else
  aviso "sem Chrome, Edge, Chromium nem Brave: a ferramenta que monta as artes não vai funcionar (o resto vai). Instale o Google Chrome ou o Chromium."
fi

# ---------- 4. Modelo de recorte ----------
passo 4 "Modelo de IA para recorte de fundo (171 MB)"
if [ -f "$MODELO" ] && [ "$(stat -c %s "$MODELO")" -gt 160000000 ]; then
  ok "já baixado"
else
  mkdir -p "$(dirname "$MODELO")"
  printf '  Baixando (alguns minutos, dependendo da internet)...\n'
  curl -fL --progress-bar -o "$MODELO.part" "$URL_MODELO" || falha "O download do modelo falhou. Verifique a internet e rode de novo."
  conferir_sha "$MODELO.part" "$SHA_MODELO"
  mv -f "$MODELO.part" "$MODELO"
  ok "baixado"
fi

# ---------- 5. Ligar no Claude ----------
passo 5 "Ligando no Claude"
CODEX_BIN="$CODEX_BIN" "$NODE" "$APP/registrar.cjs" || falha "Não consegui registrar o servidor no Claude."

# ---------- 6. Login ----------
passo 6 "Login na sua conta do ChatGPT"
if [ "${CLAUGPT_SEM_LOGIN:-}" = "1" ]; then
  aviso "pulado (CLAUGPT_SEM_LOGIN=1)"
elif "$CODEX_BIN" login status >/dev/null 2>&1; then
  ok "já logado"
else
  printf '  Vai aparecer um endereço e um código. Abra o endereço no navegador, entre na sua conta do ChatGPT\n'
  printf '  e digite o código. %s(Antes, ative o "login com código de dispositivo" em chatgpt.com → Configurações → Segurança.)%s\n\n' "$CINZA" "$FIM"
  if [ -r /dev/tty ]; then "$CODEX_BIN" login --device-auth </dev/tty; else "$CODEX_BIN" login --device-auth; fi ||
    falha "O login não foi concluído. Rode o instalador de novo."
  "$CODEX_BIN" login status >/dev/null 2>&1 || falha "O login não foi concluído. Rode o instalador de novo."
  ok "logado"
fi

# ---------- 7. Teste ----------
passo 7 "Teste final (uma pergunta de verdade ao ChatGPT)"
if [ "${CLAUGPT_SEM_LOGIN:-}" = "1" ]; then
  aviso "pulado (CLAUGPT_SEM_LOGIN=1)"
else
  (cd "$APP" && "$NODE" testar.mjs) || falha "O teste final falhou (veja a mensagem acima)."
fi

printf '\n%s  ╭───────────────────────────────────────────────╮%s\n' "$VERDE" "$FIM"
printf '%s  │%s   %sPronto! O ChatGPT está ligado no seu Claude.%s%s│%s\n' "$VERDE" "$FIM" "$BRANCO" "$FIM" "$LARANJA" "$FIM"
printf '%s  ╰───────────────────────────────────────────────╯%s\n' "$LARANJA" "$FIM"
printf '  Abra o Claude Code (claude, num terminal novo) ou reinicie o Claude Desktop e peça, por exemplo:\n'
printf '    %s"Gera com o ChatGPT um ícone 3D de um foguete, sem fundo"%s\n' "$VERDE" "$FIM"
printf '  %sAs versões novas chegam sozinhas (o servidor confere a cada 12 horas). Para desinstalar:\n' "$CINZA"
printf '  curl -fsSL https://github.com/%s/releases/latest/download/instalar-linux.sh | bash -s -- --remover%s\n\n' "$REPO" "$FIM"
