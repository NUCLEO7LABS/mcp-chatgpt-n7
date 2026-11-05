; Instalador .exe do MCP do ChatGPT para o Claude.
; Copia o projeto para %LOCALAPPDATA%\mcp-chatgpt e abre o instalar.ps1 numa janela, que faz o resto
; (Node.js, Codex, bibliotecas, modelo de recorte, registro no Claude, login, teste, reinício do Claude).
; Gerado pelo empacotar.mjs, que passa VERSAO, PACOTE (pasta com os arquivos) e SAIDA (o .exe).

Unicode true
Target amd64-unicode
SetCompressor /SOLID lzma
RequestExecutionLevel user
ManifestDPIAware true

!include MUI2.nsh
!include LogicLib.nsh

!define NOME "MCP do ChatGPT para o Claude"
!define CHAVE_DESINSTALAR "Software\Microsoft\Windows\CurrentVersion\Uninstall\mcp-chatgpt"

Name "${NOME}"
Caption "${NOME} ${VERSAO}"
OutFile "${SAIDA}"
InstallDir "$LOCALAPPDATA\mcp-chatgpt"
BrandingText "MCP do ChatGPT ${VERSAO}"
ShowInstDetails show

VIProductVersion "${VERSAO}.0"
VIAddVersionKey /LANG=1046 "ProductName" "${NOME}"
VIAddVersionKey /LANG=1046 "FileDescription" "Instalador do ${NOME}"
VIAddVersionKey /LANG=1046 "FileVersion" "${VERSAO}"
VIAddVersionKey /LANG=1046 "ProductVersion" "${VERSAO}"
VIAddVersionKey /LANG=1046 "LegalCopyright" "Uso interno"

Var Resultado
Var TextoFinal

!define MUI_ICON "icone.ico"
!define MUI_UNICON "icone.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEFINISHPAGE_BITMAP "lateral.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "lateral.bmp"

!define MUI_WELCOMEPAGE_TITLE "${NOME}"
!define MUI_WELCOMEPAGE_TEXT "Liga a sua conta do ChatGPT ao Claude deste computador: gerar imagens e ícones 3D, recriar artes a partir de uma referência, tirar o fundo de imagens e pedir uma segunda opinião ao ChatGPT.$\r$\n$\r$\nAntes de continuar:$\r$\n  • Claude Desktop instalado e logado$\r$\n  • Assinatura do ChatGPT (Plus, Pro ou Team)$\r$\n  • Em chatgpt.com → Configurações → Segurança, o login com código de dispositivo ativado$\r$\n$\r$\nAo clicar em Instalar, abre uma janela preta que faz cada etapa. Leva de 5 a 10 minutos. No meio, o site da OpenAI abre para você entrar na sua conta: o código já fica copiado, é só colar com Ctrl+V."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW BotaoInstalar
!insertmacro MUI_PAGE_WELCOME

!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "$Resultado"
!define MUI_FINISHPAGE_TEXT "$TextoFinal"
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "PortugueseBR"

; Na tela de boas-vindas o botão diz "Instalar": é ele que começa tudo.
Function BotaoInstalar
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Instalar"
FunctionEnd

Section "Instalar"
  SetOutPath "$INSTDIR"
  DetailPrint "Copiando os arquivos para $INSTDIR"
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
  DetailPrint "Abrindo a janela de instalação. Acompanhe por lá; não feche nenhuma das duas."
  StrCpy $0 "nao-abriu"
  ClearErrors
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\instalar.ps1"' $0

  ${If} ${Errors}
    StrCpy $Resultado "Não consegui abrir o PowerShell"
    StrCpy $TextoFinal "O instalador usa o PowerShell do Windows, e ele não abriu neste computador.$\r$\nPeça ajuda a quem cuida do computador: o PowerShell pode estar bloqueado por uma regra da empresa.$\r$\n$\r$\nOs arquivos ficaram em:$\r$\n$INSTDIR"
    DetailPrint "O PowerShell não abriu."
  ${ElseIf} $0 == 0
    StrCpy $Resultado "Pronto! O ChatGPT está ligado no seu Claude."
    StrCpy $TextoFinal "Num chat novo do Claude (aba Code ou chat comum), peça por exemplo:$\r$\n$\r$\n   Gera com o ChatGPT um ícone 3D de um foguete, sem fundo$\r$\n$\r$\nNa primeira vez, o Claude pede permissão para usar a ferramenta. As imagens ficam em Imagens\ChatGPT.$\r$\n$\r$\nSe as ferramentas não aparecerem, feche o Claude por completo (ícone perto do relógio → Sair) e abra de novo."
    DetailPrint "Instalação concluída."
  ${Else}
    StrCpy $Resultado "A instalação não terminou"
    StrCpy $TextoFinal "A janela preta mostrou em que etapa parou. Na maioria das vezes, basta rodar este instalador de novo: ele pula o que já está pronto.$\r$\n$\r$\nO registro completo fica em:$\r$\n$INSTDIR\instalacao.log$\r$\n$\r$\nSe continuar dando erro, mande esse arquivo para o Claude que ele diz o que fazer."
    DetailPrint "A instalação parou com erro (código $0)."
  ${EndIf}
SectionEnd

Function un.onInit
  MessageBox MB_OKCANCEL|MB_ICONINFORMATION "Feche o Claude por completo antes de continuar (ícone perto do relógio → Sair).$\r$\n$\r$\nO servidor do ChatGPT vai ser tirado do Claude e os arquivos dele apagados. Suas imagens e kits de marca ficam onde estão." IDOK +2
  Abort
FunctionEnd

Section "Uninstall"
  DetailPrint "Tirando o servidor das configurações do Claude"
  nsExec::ExecToLog 'cmd /c node "$INSTDIR\registrar.cjs" --remover'
  Pop $0
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${CHAVE_DESINSTALAR}"
  MessageBox MB_YESNO|MB_ICONQUESTION "Apagar também o modelo de recorte de fundo (214 MB)?$\r$\n$\r$\nSe você for instalar de novo depois, escolha Não: assim ele não precisa ser baixado outra vez." IDNO +2
  RMDir /r "$PROFILE\.mcp-chatgpt"
SectionEnd
