# Instalador do ClauGPT MCP (o MCP do ChatGPT para o Claude).
# Faz tudo que falta neste PC: Node.js, Codex CLI, bibliotecas, modelo de recorte,
# registro no Claude (aba Code e chat comum), login na conta do ChatGPT, teste e reinício do Claude.
# Pode rodar de novo sem problema: o que já estiver pronto é pulado.
#
# Variáveis opcionais:
#   MCP_CHATGPT_SEM_PERGUNTAS=1   não pergunta nada (não reinicia o Claude); útil para testes.
#   MCP_CHATGPT_PAUSAR_NO_ERRO=1  segura a janela aberta num erro (o instalador .exe usa, para a mensagem não sumir).

# 'Continue': npm e codex escrevem avisos normais na saída de erro; cada passo confere o código de saída.
$ErrorActionPreference = 'Continue'
$projeto = $PSScriptRoot
# IS-Net (DIS, uso geral, licença Apache 2.0): leve, ~1 GB de memória no recorte.
$modelo = Join-Path $HOME '.mcp-chatgpt\modelos\isnet-general-use.onnx'
$urlModelo = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx'
# Modelo usado até a versão 1.7 (pedia ~7 GB de memória): apagado para liberar espaço.
$modeloAntigo = Join-Path $HOME '.mcp-chatgpt\modelos\birefnet_lite.onnx'
$urlLogin = 'https://auth.openai.com/codex/device'
$semPerguntas = $env:MCP_CHATGPT_SEM_PERGUNTAS -eq '1'
# Versão do Codex testada com este servidor. O servidor lê as imagens geradas de pastas internas do Codex,
# que podem mudar numa versão nova; por isso um PC novo recebe esta, e não a última.
$versaoCodex = '0.166.0'
$versaoServidor = (Get-Content (Join-Path $projeto 'package.json') -Raw | ConvertFrom-Json).version
try { $Host.UI.RawUI.WindowTitle = "Instalador - ClauGPT MCP $versaoServidor" } catch {}
$total = 8

$log = Join-Path $projeto 'instalacao.log'
try { Start-Transcript -Path $log -Force | Out-Null } catch {}

function Passo($n, $texto) { Write-Host ""; Write-Host "[$n/$total] $texto" -ForegroundColor Cyan }
function Ok($texto) { Write-Host "  OK  $texto" -ForegroundColor Green }
function Aviso($texto) { Write-Host "  !   $texto" -ForegroundColor Yellow }
function Falha($texto) {
    Write-Host ""
    Write-Host "  ERRO  $texto" -ForegroundColor Red
    Write-Host ""
    Write-Host "  O registro completo da instalacao esta em: $log"
    try { Stop-Transcript | Out-Null } catch {}
    if ($env:MCP_CHATGPT_PAUSAR_NO_ERRO -eq '1') { Read-Host "  Aperte Enter para fechar esta janela" | Out-Null }
    exit 1
}
function AtualizarPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
        [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + (Join-Path $env:APPDATA 'npm')
}
function Logado { cmd /c "codex login status >nul 2>&1"; return $LASTEXITCODE -eq 0 }

Write-Host ""
# Cores da logo: verde em cima, laranja embaixo.
Write-Host "  ==============================================" -ForegroundColor Cyan
Write-Host "    ClauGPT MCP - Instalador $versaoServidor" -ForegroundColor White
Write-Host "    O ChatGPT dentro do seu Claude" -ForegroundColor Gray
Write-Host "  ==============================================" -ForegroundColor DarkYellow
Write-Host "  Pasta: $projeto"
AtualizarPath

# 1. Node.js
Passo 1 "Node.js"
if (Get-Command node -ErrorAction SilentlyContinue) {
    Ok "ja instalado ($(node --version))"
} else {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Start-Process 'https://nodejs.org/pt-br/download'
        Falha "Nao achei o winget para instalar o Node.js. Abri a pagina de download: instale a versao LTS e rode o instalador de novo."
    }
    Write-Host "  Instalando o Node.js LTS. Se o Windows pedir permissao, clique em Sim."
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
    AtualizarPath
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Falha "O Node.js nao foi instalado. Rode o instalador de novo." }
    Ok "instalado ($(node --version))"
}

# 2. Codex CLI (faz o login com a conta do ChatGPT)
Passo 2 "Codex CLI (ponte com a sua conta do ChatGPT)"
if (Get-Command codex -ErrorAction SilentlyContinue) {
    # Um Codex que já está aqui fica como está: ele já funciona neste PC.
    $instalada = "$(codex --version)" -replace '^.*?(\d+\.\d+\.\d+).*$', '$1'
    if ($instalada -eq $versaoCodex) { Ok "ja instalado ($instalada)" } else { Ok "ja instalado ($instalada; a versao testada e $versaoCodex)" }
} else {
    Write-Host "  Instalando a versao $versaoCodex..."
    npm install -g "@openai/codex@$versaoCodex" --no-fund --no-audit --loglevel=error
    if ($LASTEXITCODE -ne 0) { Falha "Nao consegui instalar o Codex CLI (npm install -g @openai/codex@$versaoCodex)." }
    AtualizarPath
    Ok "instalado ($(codex --version))"
}

# 3. Bibliotecas do projeto
Passo 3 "Bibliotecas do servidor"
Push-Location $projeto
try {
    npm install --no-fund --no-audit --loglevel=error
    if ($LASTEXITCODE -ne 0) { Falha "npm install falhou." }
    npm run build --silent
    if ($LASTEXITCODE -ne 0) { Falha "A compilacao (npm run build) falhou." }
} finally {
    Pop-Location
}
Ok "instaladas e compiladas"
# renderizar_arte usa o Chrome ou o Edge já instalados para montar as artes.
# @(...) em volta: com um só navegador achado, o Where-Object devolveria texto e [0] pegaria uma letra.
$navegadores = @(@(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ })
if ($navegadores) {
    Ok "navegador para montar artes: $(Split-Path $navegadores[0] -Leaf)"
} else {
    Aviso "sem Chrome nem Edge: a ferramenta de montar artes nao vai funcionar. Instale o Google Chrome e rode de novo."
}

# 4. Modelo de recorte de fundo (171 MB)
Passo 4 "Modelo de IA para recorte de fundo (171 MB)"
if (Test-Path $modeloAntigo) {
    Remove-Item -Force $modeloAntigo -ErrorAction SilentlyContinue
    Ok "modelo antigo (214 MB) apagado"
}
if ((Test-Path $modelo) -and ((Get-Item $modelo).Length -gt 160MB)) {
    Ok "ja baixado"
} else {
    New-Item -ItemType Directory -Force (Split-Path $modelo) | Out-Null
    Write-Host "  Baixando (alguns minutos, dependendo da internet)..."
    curl.exe -L --fail --progress-bar -o "$modelo.part" $urlModelo
    if ($LASTEXITCODE -ne 0) { Falha "O download do modelo falhou. Verifique a internet e rode o instalador de novo." }
    Move-Item -Force "$modelo.part" $modelo
    Ok ("baixado ({0:N0} MB)" -f ((Get-Item $modelo).Length / 1MB))
}

# 5. Registro no Claude
Passo 5 "Ligando no Claude (aba Code e chat comum)"
node (Join-Path $projeto 'registrar.cjs')
if ($LASTEXITCODE -ne 0) { Falha "Nao consegui registrar o servidor no Claude." }

# 6. Login na conta do ChatGPT
Passo 6 "Login na sua conta do ChatGPT"
if (Logado) {
    Ok "ja logado"
} elseif ($semPerguntas) {
    Falha "Falta o login no ChatGPT (rode o instalador sem MCP_CHATGPT_SEM_PERGUNTAS para fazer)."
} else {
    # O login por código roda escondido; pegamos o código da saída, copiamos e abrimos o site.
    $saidaLogin = Join-Path $env:TEMP 'mcp-chatgpt-login.txt'
    Remove-Item $saidaLogin -ErrorAction SilentlyContinue
    $proc = Start-Process cmd.exe -ArgumentList '/c', "codex login --device-auth > `"$saidaLogin`" 2>&1" -WindowStyle Hidden -PassThru
    $codigo = $null
    for ($i = 0; $i -lt 60 -and -not $codigo -and -not $proc.HasExited; $i++) {
        Start-Sleep -Milliseconds 500
        $texto = (Get-Content $saidaLogin -Raw -ErrorAction SilentlyContinue) -replace '\x1b\[[0-9;]*m', ''
        # -cmatch: diferencia maiúsculas (com -match, "command-line" casaria como código).
        if ($texto -cmatch '(?<![A-Za-z0-9])([A-Z0-9]{4}-[A-Z0-9]{4,6})(?![A-Za-z0-9])') { $codigo = $Matches[1] }
    }
    if (-not $codigo) {
        $texto = Get-Content $saidaLogin -Raw -ErrorAction SilentlyContinue
        Falha "Nao consegui iniciar o login do ChatGPT. Saida do Codex:`n$texto"
    }

    try { Set-Clipboard -Value $codigo } catch {}
    Start-Process $urlLogin
    Write-Host ""
    Write-Host "  Abri o site da OpenAI no navegador." -ForegroundColor Yellow
    Write-Host "   1. Entre na sua conta do ChatGPT (se pedir)."
    Write-Host "   2. No campo do codigo, cole com Ctrl+V. O codigo ja esta copiado:"
    Write-Host ""
    Write-Host "          $codigo" -ForegroundColor White -BackgroundColor DarkBlue
    Write-Host ""
    Write-Host "   3. Clique em Continuar."
    Write-Host "  Se o navegador nao abriu, acesse: $urlLogin"
    Write-Host "  Esperando voce confirmar no site (ate 15 minutos)..."

    $proc | Wait-Process -Timeout 900 -ErrorAction SilentlyContinue
    if (-not $proc.HasExited) { $proc | Stop-Process -Force -ErrorAction SilentlyContinue }
    if (-not (Logado)) {
        $texto = (Get-Content $saidaLogin -Raw -ErrorAction SilentlyContinue) -replace '\x1b\[[0-9;]*m', ''
        if ($texto -match 'device|dispositivo|enable|ative') {
            Start-Process 'https://chatgpt.com/#settings/Security'
            Falha ("Sua conta precisa permitir o login por codigo. Abri as configuracoes do ChatGPT: em Seguranca, " +
                "ative o 'login com codigo de dispositivo' e rode o instalador de novo.")
        }
        Falha "O login nao foi concluido. Rode o instalador de novo."
    }
    Remove-Item $saidaLogin -ErrorAction SilentlyContinue
    Ok "logado"
}

# 7. Teste de verdade, abrindo o servidor como o Claude abre
Passo 7 "Teste final (pergunta de verdade ao ChatGPT)"
Push-Location $projeto
try {
    node testar.mjs
    $testeOk = $LASTEXITCODE -eq 0
} finally {
    Pop-Location
}
if (-not $testeOk) { Falha "O teste final falhou (veja a mensagem acima)." }

# 8. Reiniciar o Claude para ele carregar o servidor
Passo 8 "Reiniciar o Claude"
$claude = @(Get-Process -Name claude -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -match '\\app\\Claude\.exe$|\\AnthropicClaude\\' })
if ($claude.Count -eq 0) {
    Ok "o Claude esta fechado; ele carrega o servidor quando voce abrir"
} elseif ($semPerguntas) {
    Aviso "feche o Claude por completo e abra de novo para ele carregar o servidor"
} else {
    Write-Host "  O Claude precisa reiniciar para carregar o servidor."
    Write-Host "  Conversas em andamento no Claude serao interrompidas." -ForegroundColor Yellow
    $resposta = Read-Host "  Reiniciar o Claude agora? (S/n)"
    if ($resposta -match '^(n|nao|não)$') {
        Aviso "depois, feche o Claude por completo (icone perto do relogio > Sair) e abra de novo"
    } else {
        $exe = $claude[0].Path
        $claude | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        $app = Get-StartApps | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1
        if ($app) { Start-Process "shell:AppsFolder\$($app.AppID)" } else { Start-Process $exe }
        Ok "Claude reiniciado"
    }
}

Write-Host ""
Write-Host "  ==============================================" -ForegroundColor Green
Write-Host "    Pronto! O ChatGPT esta ligado no seu Claude." -ForegroundColor Green
Write-Host "  ==============================================" -ForegroundColor Green
Write-Host "  Num chat novo (aba Code ou chat comum), peca por exemplo:"
Write-Host '    "Gera com o ChatGPT um icone 3D de um foguete, sem fundo"'
Write-Host ""
try { Stop-Transcript | Out-Null } catch {}
# O instalador .exe confere este código para dizer se deu certo.
exit 0
