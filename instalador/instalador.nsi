; Instalador .exe do ClauGPT MCP (o MCP do ChatGPT para o Claude).
; Copia o projeto para %LOCALAPPDATA%\mcp-chatgpt e abre o instalar.ps1 numa janela, que faz o resto
; (Node.js, Codex, bibliotecas, modelo de recorte, registro no Claude, login, teste, reinício do Claude).
; Gerado pelo empacotar.mjs, que passa VERSAO, PACOTE (pasta com os arquivos) e SAIDA (o .exe).
;
; Telas: boas-vindas e fim são páginas próprias, escuras, com a logo à esquerda (painel-*.bmp, feito pelo
; arte.py) e os textos como rótulos de verdade sobre cor lisa, para ficarem nítidos em qualquer escala.
; As telas do meio são as do Modern UI, com as cores trocadas.

Unicode true
Target amd64-unicode
SetCompressor /SOLID lzma
RequestExecutionLevel user
ManifestDPIAware true

!include MUI2.nsh
!include LogicLib.nsh
!include nsDialogs.nsh
!include WinMessages.nsh

!define NOME "ClauGPT MCP"
!define CHAVE_DESINSTALAR "Software\Microsoft\Windows\CurrentVersion\Uninstall\mcp-chatgpt"

; Cores da logo
!define COR_FUNDO 0A0E12
!define COR_CAIXA 161D25
!define COR_TEXTO FFFFFF
!define COR_SUAVE A9B4BF
!define COR_APAGADA 5E6A75
!define COR_VERDE 19E3B1
!define COR_LARANJA FF7A1A
; As mesmas, na ordem BGR que as listas do Windows usam
!define BGR_FUNDO 0x00120E0A
!define BGR_SUAVE 0x00BFB4A9

!define LVM_SETBKCOLOR 0x1001
!define LVM_SETTEXTCOLOR 0x1024
!define LVM_SETTEXTBKCOLOR 0x1026

Name "${NOME}"
Caption "${NOME} ${VERSAO}"
OutFile "${SAIDA}"
InstallDir "$LOCALAPPDATA\mcp-chatgpt"
BrandingText "${NOME} ${VERSAO}"
ShowInstDetails nevershow
ShowUninstDetails nevershow
AutoCloseWindow true

VIProductVersion "${VERSAO}.0"
VIAddVersionKey /LANG=1046 "ProductName" "${NOME}"
VIAddVersionKey /LANG=1046 "FileDescription" "Instalador do ${NOME}"
VIAddVersionKey /LANG=1046 "FileVersion" "${VERSAO}"
VIAddVersionKey /LANG=1046 "ProductVersion" "${VERSAO}"
VIAddVersionKey /LANG=1046 "LegalCopyright" "Uso interno"

Var Estado          ; ok | erro | sem-powershell
Var Pagina
Var Painel
Var Painel.Imagem
Var Linha
Var Linha.Imagem
Var Fonte.Rotulo
Var Fonte.Titulo
Var Fonte.Texto
Var Fonte.Nota

!define MUI_ICON "icone.ico"
!define MUI_UNICON "icone.ico"
!define MUI_ABORTWARNING
!define MUI_BGCOLOR ${COR_FUNDO}
!define MUI_TEXTCOLOR ${COR_TEXTO}
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "cabecalho.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "cabecalho.bmp"
!define MUI_CUSTOMFUNCTION_GUIINIT AoAbrir
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.AoAbrir

Page custom PaginaBoasVindas
!define MUI_PAGE_HEADER_TEXT "Instalando o ${NOME}"
!define MUI_PAGE_HEADER_SUBTEXT "Siga as etapas na janela preta e não feche nenhuma das duas."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW EstilizarPagina
!insertmacro MUI_PAGE_INSTFILES
Page custom PaginaFim

!define MUI_PAGE_HEADER_TEXT "Desinstalar o ${NOME}"
!define MUI_PAGE_HEADER_SUBTEXT "Tira o ChatGPT do Claude e apaga os arquivos do servidor."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.EstilizarPagina
!insertmacro MUI_UNPAGE_CONFIRM
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.EstilizarPagina
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "PortugueseBR"

; ---------- Janela ----------

; Pinta a janela inteira (o rodapé dos botões incluído) com o fundo escuro.
!macro PINTAR_JANELA
  SetCtlColors $HWNDPARENT "" ${COR_FUNDO}
  SetCtlColors $mui.Branding.Background ${COR_APAGADA} ${COR_FUNDO}
  SetCtlColors $mui.Branding.Text ${COR_APAGADA} ${COR_FUNDO}
  CreateFont $Fonte.Rotulo "Segoe UI" 8 700
  CreateFont $Fonte.Titulo "Segoe UI" 18 700
  CreateFont $Fonte.Texto "Segoe UI" 9 400
  CreateFont $Fonte.Nota "Segoe UI" 8 400
!macroend

Function AoAbrir
  !insertmacro PINTAR_JANELA
FunctionEnd

Function un.AoAbrir
  !insertmacro PINTAR_JANELA
FunctionEnd

; As telas do meio (progresso, confirmação da desinstalação) com fundo escuro e texto claro.
!macro ESTILIZAR_PAGINA
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 ${COR_TEXTO} ${COR_FUNDO}
  ; 1006: texto da etapa · 1029: rótulo da confirmação · 1000: pasta
  GetDlgItem $1 $0 1006
  SetCtlColors $1 ${COR_TEXTO} ${COR_FUNDO}
  GetDlgItem $1 $0 1029
  SetCtlColors $1 ${COR_SUAVE} ${COR_FUNDO}
  GetDlgItem $1 $0 1000
  SetCtlColors $1 ${COR_TEXTO} ${COR_CAIXA}
  ; 1016: lista de detalhes
  GetDlgItem $1 $0 1016
  SendMessage $1 ${LVM_SETBKCOLOR} 0 ${BGR_FUNDO}
  SendMessage $1 ${LVM_SETTEXTBKCOLOR} 0 ${BGR_FUNDO}
  SendMessage $1 ${LVM_SETTEXTCOLOR} 0 ${BGR_SUAVE}
!macroend

Function EstilizarPagina
  !insertmacro ESTILIZAR_PAGINA
  ; No lugar da lista de arquivos, o que a janela preta vai fazer. Posição em unidades de diálogo,
  ; convertidas para pixels da tela (MapDialogRect), para acompanhar a escala do Windows.
  System::Call '*(i 0, i 40, i 300, i 140) p .r2'
  System::Call 'user32::MapDialogRect(p r0, p r2)'
  System::Call '*$2(i .r3, i .r4, i .r5, i .r6)'
  System::Free $2
  IntOp $5 $5 - $3
  IntOp $6 $6 - $4
  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "A janela preta faz, nesta ordem:$\r$\n1   Node.js e Codex CLI (a ponte com a sua conta do ChatGPT)$\r$\n2   Bibliotecas do servidor e o modelo de recorte de fundo (171 MB)$\r$\n3   Login no ChatGPT: o site da OpenAI abre e o código já fica copiado.$\r$\n     Cole com Ctrl+V e clique em Continuar.$\r$\n4   Teste com uma pergunta de verdade e reinício do Claude", i 0x50000000, i r3, i r4, i r5, i r6, p r0, p 0, p 0, p 0) p .r1'
  SendMessage $1 ${WM_SETFONT} $Fonte.Texto 1
  SetCtlColors $1 ${COR_SUAVE} ${COR_FUNDO}
FunctionEnd

Function un.EstilizarPagina
  !insertmacro ESTILIZAR_PAGINA
FunctionEnd

; ---------- Telas de boas-vindas e de fim ----------

; Usa a janela inteira (sem o cabeçalho) e esconde o que ficaria por baixo.
Function TelaCheia
  LockWindow on
  ShowWindow $mui.Branding.Background ${SW_HIDE}
  ShowWindow $mui.Branding.Text ${SW_HIDE}
  ShowWindow $mui.Header.Text ${SW_HIDE}
  ShowWindow $mui.Header.SubText ${SW_HIDE}
  ShowWindow $mui.Header.Image ${SW_HIDE}
  ShowWindow $mui.Line.Standard ${SW_HIDE}
  ShowWindow $mui.Line.FullWindow ${SW_HIDE}
  LockWindow off
FunctionEnd

Function SairDaTelaCheia
  LockWindow on
  ShowWindow $mui.Branding.Background ${SW_NORMAL}
  ShowWindow $mui.Branding.Text ${SW_NORMAL}
  ShowWindow $mui.Header.Text ${SW_NORMAL}
  ShowWindow $mui.Header.SubText ${SW_NORMAL}
  ShowWindow $mui.Header.Image ${SW_NORMAL}
  ShowWindow $mui.Line.Standard ${SW_NORMAL}
  LockWindow off
FunctionEnd

; Cria a página escura com o painel da logo e o traço em degradê. Os textos vêm depois, de cada tela.
Function CriarTela
  nsDialogs::Create 1044
  Pop $Pagina
  SetCtlColors $Pagina ${COR_TEXTO} ${COR_FUNDO}

  ; Painel na resolução mais próxima da escala da tela (100%, 150% ou 200%), para a logo sair nítida.
  System::Call 'user32::GetDC(p 0) p .r1'
  System::Call 'gdi32::GetDeviceCaps(p r1, i 88) i .r0'
  System::Call 'user32::ReleaseDC(p 0, p r1)'
  ${If} $0 >= 168
    StrCpy $2 "200"
  ${ElseIf} $0 >= 120
    StrCpy $2 "150"
  ${Else}
    StrCpy $2 "100"
  ${EndIf}
  ; A altura em pixels de 191u muda com a fonte do sistema: a imagem estica pela altura e mantém a proporção.
  ${NSD_CreateBitmap} 0u 0u 140u 191u ""
  Pop $Painel
  !insertmacro MUI_LOADANDASPECTSTRETCHIMAGETOCONTROLHEIGHT $Painel "$PLUGINSDIR\painel-$2.bmp" Left $Painel.Imagem
  ${NSD_CreateBitmap} 0u 191u 331u 2u ""
  Pop $Linha
  ${NSD_SetStretchedImage} $Linha "$PLUGINSDIR\linha.bmp" $Linha.Imagem
FunctionEnd

; Um rótulo com fonte e cores, sobre o fundo liso.
!macro ROTULO X Y L A TEXTO FONTE COR FUNDO
  ${NSD_CreateLabel} ${X} ${Y} ${L} ${A} "${TEXTO}"
  Pop $0
  SendMessage $0 ${WM_SETFONT} ${FONTE} 1
  SetCtlColors $0 ${COR} ${FUNDO}
!macroend

Function MostrarTela
  Call TelaCheia
  nsDialogs::Show
  ${NSD_FreeImage} $Painel.Imagem
  ${NSD_FreeImage} $Linha.Imagem
  Call SairDaTelaCheia
FunctionEnd

Function .onInit
  InitPluginsDir
  File "/oname=$PLUGINSDIR\painel-100.bmp" "painel-100.bmp"
  File "/oname=$PLUGINSDIR\painel-150.bmp" "painel-150.bmp"
  File "/oname=$PLUGINSDIR\painel-200.bmp" "painel-200.bmp"
  File "/oname=$PLUGINSDIR\linha.bmp" "linha.bmp"
FunctionEnd

; Uma caixa com o texto dentro: campo de texto só leitura (dá para selecionar e copiar), com margem interna.
!macro CAIXA X Y L A TEXTO
  nsDialogs::CreateControl EDIT ${DEFAULT_STYLES}|${ES_MULTILINE}|${ES_READONLY} 0 ${X}u ${Y}u ${L}u ${A}u "${TEXTO}"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $Fonte.Texto 1
  SetCtlColors $0 ${COR_TEXTO} ${COR_CAIXA}
  ; Área do texto: 10 px das laterais e 7 px do topo.
  System::Call '*(i, i, i, i) p .r1'
  System::Call 'user32::GetClientRect(p r0, p r1)'
  System::Call '*$1(i, i, i .r2, i .r3)'
  IntOp $2 $2 - 10
  System::Call '*$1(i 10, i 7, i r2, i r3)'
  SendMessage $0 ${EM_SETRECT} 0 $1
  System::Free $1
!macroend

Function PaginaBoasVindas
  Call CriarTela
  !insertmacro ROTULO 148u 16u 176u 10u "INSTALADOR PARA WINDOWS  ·  ${VERSAO}" $Fonte.Rotulo ${COR_VERDE} ${COR_FUNDO}
  !insertmacro ROTULO 148u 26u 176u 24u "${NOME}" $Fonte.Titulo ${COR_TEXTO} ${COR_FUNDO}
  !insertmacro ROTULO 148u 51u 176u 40u "Liga a sua conta do ChatGPT ao Claude: imagens e ícones 3D, artes a partir de referências, recorte de fundo e segunda opinião." $Fonte.Texto ${COR_SUAVE} ${COR_FUNDO}
  !insertmacro ROTULO 148u 95u 176u 10u "ANTES DE COMEÇAR" $Fonte.Rotulo ${COR_LARANJA} ${COR_FUNDO}
  !insertmacro ROTULO 148u 106u 176u 42u "✓  Claude Desktop instalado e logado$\r$\n✓  Assinatura do ChatGPT (Plus, Pro ou Team)$\r$\n✓  Login por código ativo no ChatGPT$\r$\n     (Configurações → Segurança)" $Fonte.Texto ${COR_TEXTO} ${COR_FUNDO}
  !insertmacro ROTULO 148u 153u 176u 34u "Ao clicar em Instalar, uma janela preta faz cada etapa (5 a 10 minutos). O código do login já fica copiado: é só colar com Ctrl+V." $Fonte.Nota ${COR_APAGADA} ${COR_FUNDO}
  SendMessage $mui.Button.Next ${WM_SETTEXT} 0 "STR:Instalar"
  Call MostrarTela
FunctionEnd

Function PaginaFim
  Call CriarTela
  ${If} $Estado == "ok"
    !insertmacro ROTULO 148u 16u 176u 10u "TUDO PRONTO" $Fonte.Rotulo ${COR_VERDE} ${COR_FUNDO}
    !insertmacro ROTULO 148u 26u 176u 24u "Pronto para usar" $Fonte.Titulo ${COR_TEXTO} ${COR_FUNDO}
    !insertmacro ROTULO 148u 52u 176u 24u "O ChatGPT já está ligado no seu Claude. Num chat novo, peça por exemplo:" $Fonte.Texto ${COR_SUAVE} ${COR_FUNDO}
    !insertmacro CAIXA 148u 80u 176u 32u "Gera com o ChatGPT um ícone 3D de um foguete, sem fundo"
    !insertmacro ROTULO 148u 122u 176u 60u "As imagens ficam em Imagens\ChatGPT.$\r$\n$\r$\nSe as ferramentas não aparecerem, feche o Claude por completo (ícone perto do relógio → Sair) e abra de novo." $Fonte.Nota ${COR_APAGADA} ${COR_FUNDO}
  ${ElseIf} $Estado == "sem-powershell"
    !insertmacro ROTULO 148u 16u 176u 10u "ATENÇÃO" $Fonte.Rotulo ${COR_LARANJA} ${COR_FUNDO}
    !insertmacro ROTULO 148u 26u 176u 24u "Sem PowerShell" $Fonte.Titulo ${COR_TEXTO} ${COR_FUNDO}
    !insertmacro ROTULO 148u 52u 176u 52u "O instalador usa o PowerShell do Windows, e ele não abriu neste computador. Peça ajuda a quem cuida do computador: ele pode estar bloqueado por uma regra da empresa." $Fonte.Texto ${COR_SUAVE} ${COR_FUNDO}
    !insertmacro ROTULO 148u 112u 176u 10u "OS ARQUIVOS FICARAM EM" $Fonte.Rotulo ${COR_APAGADA} ${COR_FUNDO}
    !insertmacro CAIXA 148u 123u 176u 30u "$INSTDIR"
  ${Else}
    !insertmacro ROTULO 148u 16u 176u 10u "ATENÇÃO" $Fonte.Rotulo ${COR_LARANJA} ${COR_FUNDO}
    !insertmacro ROTULO 148u 26u 176u 24u "Não terminou" $Fonte.Titulo ${COR_TEXTO} ${COR_FUNDO}
    !insertmacro ROTULO 148u 52u 176u 34u "A janela preta mostrou em que etapa parou. Quase sempre basta rodar este instalador de novo: ele pula o que já está pronto." $Fonte.Texto ${COR_SUAVE} ${COR_FUNDO}
    !insertmacro ROTULO 148u 92u 176u 10u "REGISTRO COMPLETO" $Fonte.Rotulo ${COR_APAGADA} ${COR_FUNDO}
    !insertmacro CAIXA 148u 103u 176u 30u "$INSTDIR\instalacao.log"
    !insertmacro ROTULO 148u 141u 176u 30u "Se continuar dando erro, mande esse arquivo para o Claude que ele diz o que fazer." $Fonte.Nota ${COR_APAGADA} ${COR_FUNDO}
  ${EndIf}
  SendMessage $mui.Button.Next ${WM_SETTEXT} 0 "STR:Concluir"
  ShowWindow $mui.Button.Back ${SW_HIDE}
  ShowWindow $mui.Button.Cancel ${SW_HIDE}
  Call MostrarTela
FunctionEnd

; ---------- Instalação ----------

Section "Instalar"
  ; Só frases para gente na linha de status; nada de "Extrair: ..." nem a linha de comando.
  SetDetailsPrint textonly
  SetOutPath "$INSTDIR"
  DetailPrint "Copiando os arquivos..."
  SetDetailsPrint listonly
  ; Tira o código antigo; node_modules fica, para a reinstalação ser rápida.
  RMDir /r "$INSTDIR\src"
  RMDir /r "$INSTDIR\dist"
  File /r "${PACOTE}\*.*"

  WriteUninstaller "$INSTDIR\Desinstalar.exe"
  WriteRegStr HKCU "${CHAVE_DESINSTALAR}" "DisplayName" "${NOME}"
  WriteRegStr HKCU "${CHAVE_DESINSTALAR}" "DisplayVersion" "${VERSAO}"
  WriteRegStr HKCU "${CHAVE_DESINSTALAR}" "DisplayIcon" "$INSTDIR\Desinstalar.exe"
  WriteRegStr HKCU "${CHAVE_DESINSTALAR}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${CHAVE_DESINSTALAR}" "UninstallString" '"$INSTDIR\Desinstalar.exe"'
  WriteRegDWORD HKCU "${CHAVE_DESINSTALAR}" "NoModify" 1
  WriteRegDWORD HKCU "${CHAVE_DESINSTALAR}" "NoRepair" 1

  ; A janela do instalar.ps1 segura a mensagem aberta se der erro.
  System::Call 'Kernel32::SetEnvironmentVariable(t "MCP_CHATGPT_PAUSAR_NO_ERRO", t "1")'
  ; Depois do System::Call: chamar um plugin mexe no SetDetailsPrint.
  SetDetailsPrint textonly
  DetailPrint "Instalando: acompanhe na janela preta..."
  StrCpy $0 "nao-abriu"
  SetDetailsPrint listonly
  ClearErrors
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\instalar.ps1"' $0
  SetDetailsPrint textonly

  ${If} ${Errors}
    StrCpy $Estado "sem-powershell"
    DetailPrint "O PowerShell não abriu."
  ${ElseIf} $0 == 0
    StrCpy $Estado "ok"
    DetailPrint "Instalação concluída."
  ${Else}
    StrCpy $Estado "erro"
    DetailPrint "A instalação parou com erro (código $0)."
  ${EndIf}
SectionEnd

; ---------- Desinstalação ----------

Function un.onInit
  MessageBox MB_OKCANCEL|MB_ICONINFORMATION "Feche o Claude por completo antes de continuar (ícone perto do relógio → Sair).$\r$\n$\r$\nO ${NOME} vai ser tirado do Claude e os arquivos dele apagados. Suas imagens e kits de marca ficam onde estão." IDOK +2
  Abort
FunctionEnd

Section "Uninstall"
  DetailPrint "Tirando o servidor das configurações do Claude"
  nsExec::ExecToLog 'cmd /c node "$INSTDIR\registrar.cjs" --remover'
  Pop $0
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${CHAVE_DESINSTALAR}"
  MessageBox MB_YESNO|MB_ICONQUESTION "Apagar também o modelo de recorte de fundo (171 MB)?$\r$\n$\r$\nSe você for instalar de novo depois, escolha Não: assim ele não precisa ser baixado outra vez." IDNO +2
  RMDir /r "$PROFILE\.mcp-chatgpt"
SectionEnd
