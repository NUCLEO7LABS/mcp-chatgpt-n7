; Instalador .exe do ClauGPT MCP (o MCP do ChatGPT para o Claude).
; Gerado pelo empacotar.mjs, que passa VERSAO, PACOTE (pasta com os arquivos) e SAIDA (o .exe).
;
; O .exe só abre caminho: copia o projeto para %LOCALAPPDATA%\mcp-chatgpt, dispara o iniciar.ps1 (que abre
; a janela do instalador, interface\index.html, e roda o instalar.ps1 por trás) e mostra a logo surgindo em
; fade enquanto essa janela carrega. Se a janela não puder abrir, o próprio iniciar.ps1 cai na instalação
; na janela preta.
; O desinstalador usa as telas do Modern UI, com as cores da logo.

Unicode true
Target amd64-unicode
SetCompressor /SOLID lzma
RequestExecutionLevel user
ManifestDPIAware true
SilentInstall silent

!include MUI2.nsh
!include LogicLib.nsh
!include WinMessages.nsh

!define NOME "ClauGPT MCP"
!define CHAVE_DESINSTALAR "Software\Microsoft\Windows\CurrentVersion\Uninstall\mcp-chatgpt"

; Cores da logo
!define COR_FUNDO 0A0E12
!define COR_CAIXA 161D25
!define COR_TEXTO FFFFFF
!define COR_SUAVE A9B4BF
!define COR_APAGADA 5E6A75
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
ShowUninstDetails nevershow

VIProductVersion "${VERSAO}.0"
VIAddVersionKey /LANG=1046 "ProductName" "${NOME}"
VIAddVersionKey /LANG=1046 "FileDescription" "Instalador do ${NOME}"
VIAddVersionKey /LANG=1046 "FileVersion" "${VERSAO}"
VIAddVersionKey /LANG=1046 "ProductVersion" "${VERSAO}"
VIAddVersionKey /LANG=1046 "LegalCopyright" "Uso interno"

!define MUI_ICON "icone.ico"
!define MUI_UNICON "icone.ico"
!define MUI_BGCOLOR ${COR_FUNDO}
!define MUI_TEXTCOLOR ${COR_TEXTO}
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_UNBITMAP "cabecalho.bmp"
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.AoAbrir

!define MUI_PAGE_HEADER_TEXT "Desinstalar o ${NOME}"
!define MUI_PAGE_HEADER_SUBTEXT "Tira o ChatGPT do Claude e apaga os arquivos do servidor."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.EstilizarPagina
!insertmacro MUI_UNPAGE_CONFIRM
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.EstilizarPagina
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "PortugueseBR"

; ---------- Instalação ----------

Section "Instalar"
  SetOutPath "$INSTDIR"
  ; Tira o código antigo; node_modules fica, para a reinstalação ser rápida.
  RMDir /r "$INSTDIR\src"
  RMDir /r "$INSTDIR\dist"
  RMDir /r "$INSTDIR\interface"
  File /r "${PACOTE}\*.*"

  WriteUninstaller "$INSTDIR\Desinstalar.exe"
  WriteRegStr HKCU "${CHAVE_DESINSTALAR}" "DisplayName" "${NOME}"
  WriteRegStr HKCU "${CHAVE_DESINSTALAR}" "DisplayVersion" "${VERSAO}"
  WriteRegStr HKCU "${CHAVE_DESINSTALAR}" "DisplayIcon" "$INSTDIR\Desinstalar.exe"
  WriteRegStr HKCU "${CHAVE_DESINSTALAR}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${CHAVE_DESINSTALAR}" "UninstallString" '"$INSTDIR\Desinstalar.exe"'
  WriteRegDWORD HKCU "${CHAVE_DESINSTALAR}" "NoModify" 1
  WriteRegDWORD HKCU "${CHAVE_DESINSTALAR}" "NoRepair" 1

  ; Abre a janela do instalador por trás (SW_HIDE: o PowerShell não pisca na tela) e segue sem esperar.
  ClearErrors
  ExecShell "open" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\iniciar.ps1"' SW_HIDE
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "O instalador usa o PowerShell do Windows, e ele não abriu neste computador.$\r$\n$\r$\nPeça ajuda a quem cuida do computador: ele pode estar bloqueado por uma regra da empresa. Os arquivos ficaram em:$\r$\n$INSTDIR"
    Abort
  ${EndIf}

  ; A logo surge em fade enquanto a janela carrega (o magenta da imagem fica transparente).
  InitPluginsDir
  File "/oname=$PLUGINSDIR\splash.bmp" "splash.bmp"
  AdvSplash::show 1500 700 500 0xFF00FF "$PLUGINSDIR\splash"
  Pop $0
SectionEnd

; ---------- Desinstalação ----------

; Janela escura, como a do instalador.
Function un.AoAbrir
  SetCtlColors $HWNDPARENT "" ${COR_FUNDO}
  SetCtlColors $mui.Branding.Background ${COR_APAGADA} ${COR_FUNDO}
  SetCtlColors $mui.Branding.Text ${COR_APAGADA} ${COR_FUNDO}
FunctionEnd

Function un.EstilizarPagina
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 ${COR_TEXTO} ${COR_FUNDO}
  ; 1006: texto da etapa · 1029: rótulo da confirmação · 1000: pasta · 1016: lista de detalhes
  GetDlgItem $1 $0 1006
  SetCtlColors $1 ${COR_TEXTO} ${COR_FUNDO}
  GetDlgItem $1 $0 1029
  SetCtlColors $1 ${COR_SUAVE} ${COR_FUNDO}
  GetDlgItem $1 $0 1000
  SetCtlColors $1 ${COR_TEXTO} ${COR_CAIXA}
  GetDlgItem $1 $0 1016
  SendMessage $1 ${LVM_SETBKCOLOR} 0 ${BGR_FUNDO}
  SendMessage $1 ${LVM_SETTEXTBKCOLOR} 0 ${BGR_FUNDO}
  SendMessage $1 ${LVM_SETTEXTCOLOR} 0 ${BGR_SUAVE}
FunctionEnd

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
