# Janela do instalador do ClauGPT MCP: abre a interface (interface\index.html) numa janela do Edge em modo
# aplicativo e acompanha o instalar.ps1, que roda escondido (sem janela nenhuma) e anota cada etapa no
# interface-eventos.txt.
#
# Um servidorzinho local (só 127.0.0.1, porta aleatória, com uma senha por sessão) entrega a página, o
# estado da instalação (lido desse arquivo) e atende aos botões.
#
# Se não der para abrir a janela (sem Edge nem Chrome, ou algo falhou antes dela aparecer), roda o
# instalar.ps1 na janela preta, como antes: ninguém fica sem instalar.

$ErrorActionPreference = 'Stop'
$projeto = $PSScriptRoot
$pastaInterface = Join-Path $projeto 'interface'
$log = Join-Path $projeto 'instalacao.log'
$eventos = Join-Path $projeto 'interface-eventos.txt'
# Download do modelo de recorte: o tamanho do arquivo parcial dá a porcentagem.
$modeloParcial = Join-Path $HOME '.mcp-chatgpt\modelos\isnet-general-use.onnx.part'
$tamanhoModelo = 178648008

# Uma janela por vez.
$mutex = New-Object System.Threading.Mutex($false, 'Local\ClauGPT-MCP-Instalador')
if (-not $mutex.WaitOne(0)) { exit 0 }

function JanelaPreta {
    $env:MCP_CHATGPT_PAUSAR_NO_ERRO = '1'
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $projeto 'instalar.ps1')`""
    exit 0
}

function AcharNavegador {
    @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

# ---------- Janela ----------
try {
    $versao = (Get-Content (Join-Path $projeto 'package.json') -Raw | ConvertFrom-Json).version
    $navegador = AcharNavegador
    if (-not $navegador -or -not (Test-Path (Join-Path $pastaInterface 'index.html'))) { JanelaPreta }

    $ouvinte = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $ouvinte.Start()
    $porta = $ouvinte.LocalEndpoint.Port
    $token = [guid]::NewGuid().ToString('N')

    # Perfil próprio e temporário: a janela abre limpa (sem abas, extensões nem tela de boas-vindas) e dá
    # para fechá-la no fim sem mexer no Edge da pessoa.
    $perfil = Join-Path $env:TEMP "clauGPT-instalador-$PID"
    Add-Type -AssemblyName System.Windows.Forms
    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $largura = 1000
    $altura = 680
    $x = [int]($area.Left + ($area.Width - $largura) / 2)
    $y = [int]($area.Top + ($area.Height - $altura) / 2)
    $argumentos = @(
        "--app=http://127.0.0.1:$porta/?t=$token",
        "--window-size=$largura,$altura",
        "--window-position=$x,$y",
        "--user-data-dir=`"$perfil`"",
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,msEdgeTranslate',
        '--hide-crash-restore-bubble'
    )
    $janela = Start-Process -FilePath $navegador -ArgumentList $argumentos -PassThru
} catch {
    JanelaPreta
}

# ---------- Instalação ----------
$instalacao = $null

function IniciarInstalacao {
    if ($script:instalacao -and -not $script:instalacao.HasExited) { return }
    Remove-Item $eventos -ErrorAction SilentlyContinue
    $env:MCP_CHATGPT_INTERFACE = '1'
    # CreateNoWindow: nenhuma janela, nem piscando (o Node.js, o npm e o Codex herdam o console escondido).
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $info.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $projeto 'instalar.ps1')`""
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $script:instalacao = [System.Diagnostics.Process]::Start($info)
}

function LerArquivo($caminho) {
    try {
        $fs = [System.IO.File]::Open($caminho, 'Open', 'Read', 'ReadWrite')
        try { return (New-Object System.IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
    } catch { return '' }
}

# Estado da instalação, lido do interface-eventos.txt:
#   [n/8] Título · OK texto · !   aviso · ERRO texto (e as linhas seguintes) · @@codigo X · @@logado ·
#   @@claude-aberto · @@fim
function Estado {
    $etapas = @(1..8 | ForEach-Object { @{ status = 'espera'; detalhe = '' } })
    $atual = 0
    $codigo = $null
    $erro = $null
    $lendoErro = $false
    $fim = $false
    $claudeAberto = $false
    foreach ($linha in ((LerArquivo $eventos) -split "`r?`n")) {
        if ($lendoErro) {
            if ($linha -match 'registro completo' -or ($linha.Trim() -eq '' -and $erro)) { $lendoErro = $false }
            elseif ($linha.Trim()) { $erro += "`n" + $linha.Trim() }
            continue
        }
        if ($linha -match '^\[(\d)/8\]\s*(.*)$') {
            if ($atual -ge 1 -and $etapas[$atual - 1].status -eq 'ativa') { $etapas[$atual - 1].status = 'ok' }
            $atual = [int]$Matches[1]
            $etapas[$atual - 1].status = 'ativa'
        } elseif ($linha -match '^\s+OK\s+(.*)$' -and $atual) {
            $etapas[$atual - 1].detalhe = $Matches[1].Trim()
        } elseif ($linha -match '^\s+!\s+(.*)$' -and $atual) {
            $etapas[$atual - 1].detalhe = $Matches[1].Trim()
            $etapas[$atual - 1].aviso = $true
        } elseif ($linha -match '^\s+ERRO\s+(.*)$') {
            $erro = $Matches[1].Trim()
            $lendoErro = $true
        } elseif ($linha -match '^@@codigo\s+(\S+)') {
            $codigo = $Matches[1]
        } elseif ($linha -match '^@@logado') {
            $codigo = $null
        } elseif ($linha -match '^@@claude-aberto') {
            $claudeAberto = $true
        } elseif ($linha -match '^@@fim') {
            $fim = $true
        }
    }

    # Porcentagem do download do modelo, pelo tamanho do arquivo que está sendo baixado.
    $download = $null
    if (Test-Path $modeloParcial) {
        $download = [math]::Min(100, 100 * (Get-Item $modeloParcial).Length / $tamanhoModelo)
    }

    $fase = 'inicio'
    if ($script:instalacao) {
        if (-not $script:instalacao.HasExited) { $fase = 'instalando' }
        elseif ($script:instalacao.ExitCode -eq 0 -and $fim) { $fase = 'pronto' }
        else { $fase = 'erro' }
    }
    if ($fase -eq 'pronto') { foreach ($e in $etapas) { $e.status = 'ok' } }
    if ($fase -eq 'erro' -and $atual -ge 1) { $etapas[$atual - 1].status = 'erro' }
    foreach ($e in $etapas) { if ($e.status -eq 'ok' -and $e.aviso) { $e.status = 'aviso' } }
    if ($fase -eq 'erro' -and -not $erro) { $erro = 'A instalação parou antes do fim.' }

    [ordered]@{
        fase = $fase; etapa = $atual; etapas = $etapas; versao = $versao; codigo = $codigo
        download = $(if ($atual -eq 4) { $download } else { $null })
        erro = $erro; log = $log; claudeAberto = $claudeAberto
    }
}

function ProcessosDoClaude {
    @(Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -match '\\app\\Claude\.exe$|\\AnthropicClaude\\|\\WindowsApps\\[^\\]*Claude_' })
}

function AbrirClaude($exe) {
    $app = Get-StartApps | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1
    if ($app) { Start-Process "shell:AppsFolder\$($app.AppID)" } elseif ($exe) { Start-Process $exe }
}

# ---------- Servidor ----------
$tipos = @{ '.html' = 'text/html; charset=utf-8'; '.webp' = 'image/webp' }

function Responder($fluxo, [int]$codigo, [string]$tipo, [byte[]]$corpo) {
    $texto = @{ 200 = 'OK'; 403 = 'Forbidden'; 404 = 'Not Found' }[$codigo]
    $cabecalho = "HTTP/1.1 $codigo $texto`r`nContent-Type: $tipo`r`nContent-Length: $($corpo.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($cabecalho)
    $fluxo.Write($bytes, 0, $bytes.Length)
    if ($corpo.Length) { $fluxo.Write($corpo, 0, $corpo.Length) }
}

$sair = $false
# Último pedido da página: ela pergunta o estado a cada meio segundo enquanto a janela está aberta.
$ultimoContato = Get-Date

function Atender($cliente) {
    $fluxo = $cliente.GetStream()
    $fluxo.ReadTimeout = 2000
    $leitor = New-Object System.IO.StreamReader($fluxo, [System.Text.Encoding]::ASCII, $false, 4096, $true)
    $primeira = $leitor.ReadLine()
    if (-not $primeira) { return }
    $script:ultimoContato = Get-Date
    $tokenRecebido = ''
    while ($l = $leitor.ReadLine()) { if ($l -match '^X-Token:\s*(\S+)') { $tokenRecebido = $Matches[1] } }
    $partes = $primeira -split ' '
    $metodo = $partes[0]
    $caminho = ($partes[1] -split '\?')[0]
    $vazio = [byte[]]@()

    if ($metodo -eq 'GET' -and ($caminho -eq '/' -or $caminho -eq '/logo.webp')) {
        $arquivo = Join-Path $pastaInterface $(if ($caminho -eq '/') { 'index.html' } else { 'logo.webp' })
        Responder $fluxo 200 $tipos[[System.IO.Path]::GetExtension($arquivo)] ([System.IO.File]::ReadAllBytes($arquivo))
        return
    }
    # Estado e ações só com a senha da sessão (outro programa do PC não mexe na instalação).
    if ($tokenRecebido -ne $token) { Responder $fluxo 403 'text/plain' $vazio; return }

    if ($metodo -eq 'GET' -and $caminho -eq '/estado') {
        $json = (Estado) | ConvertTo-Json -Depth 5 -Compress
        Responder $fluxo 200 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes($json))
        return
    }
    if ($metodo -eq 'POST' -and $caminho -match '^/acao/([a-z-]+)$') {
        switch ($Matches[1]) {
            'instalar' { IniciarInstalacao }
            'tentar-de-novo' { IniciarInstalacao }
            'abrir-login' { Start-Process 'https://auth.openai.com/codex/device' }
            'abrir-log' { if (Test-Path $log) { Start-Process notepad.exe -ArgumentList "`"$log`"" } }
            'reiniciar-claude' {
                $claude = ProcessosDoClaude
                $exe = if ($claude.Count) { $claude[0].Path } else { $null }
                $claude | Stop-Process -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
                AbrirClaude $exe
            }
            'abrir-claude' { AbrirClaude $null }
            'fechar' { $script:sair = $true }
        }
        Responder $fluxo 200 'text/plain' $vazio
        return
    }
    Responder $fluxo 404 'text/plain' $vazio
}

try {
    while (-not $sair) {
        if (-not $ouvinte.Pending()) {
            Start-Sleep -Milliseconds 40
            # Janela fechada (a página parou de perguntar): espera a instalação em andamento terminar, e sai.
            # Não confia só no processo do Edge, que às vezes passa a janela para outro processo e fecha.
            $semContato = ((Get-Date) - $ultimoContato).TotalSeconds
            if ($semContato -gt 20 -and (-not $instalacao -or $instalacao.HasExited)) { break }
            continue
        }
        $cliente = $ouvinte.AcceptTcpClient()
        try { Atender $cliente } catch {} finally { $cliente.Close() }
    }
} finally {
    $ouvinte.Stop()
    # Fecha a janela: todo processo do navegador que usa o perfil temporário do instalador.
    try {
        Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" |
            Where-Object { $_.CommandLine -like "*$perfil*" } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch {}
    if (-not $janela.HasExited) { Stop-Process -Id $janela.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
    Remove-Item $perfil -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $eventos -ErrorAction SilentlyContinue
}
exit 0
