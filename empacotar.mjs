// Gera os instaladores do ClauGPT MCP na versão do package.json, na pasta saida\:
//   Instalar-ClauGPT-MCP.exe       instalador principal (NSIS)
//   Instalar-ClauGPT-MCP.zip       o .exe dentro de um .zip, para a página de download
//   Instalar-ClauGPT-MCP.cmd       alternativa em arquivo único, para PCs onde o antivírus barra o .exe
//   Instalar-ClauGPT-MCP-cmd.zip   o .cmd dentro de um .zip, para a página
// Precisa do makensis (NSIS 3) no PATH e de zip (Linux/Mac) ou do tar do Windows 10+.
// Uso: node empacotar.mjs
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = dirname(fileURLToPath(import.meta.url));
const saida = join(raiz, "saida");
const pacote = join(saida, "pacote");
const versao = JSON.parse(readFileSync(join(raiz, "package.json"), "utf8")).version;

// O que vai para o PC do usuário. node_modules e dist não: o instalar.ps1 instala e compila lá.
const ARQUIVOS = ["src", "interface", "package.json", "package-lock.json", "tsconfig.json", "iniciar.ps1", "instalar.ps1", "registrar.cjs", "testar.mjs", "README.md"];

function zipar(destino, pasta, itens) {
  rmSync(destino, { force: true });
  if (process.platform === "win32") execFileSync("tar", ["-a", "-c", "-f", destino, "-C", pasta, ...itens], { stdio: "inherit" });
  else execFileSync("zip", ["-q", "-r", "-X", destino, ...itens], { cwd: pasta, stdio: "inherit" });
}

rmSync(saida, { recursive: true, force: true });
mkdirSync(pacote, { recursive: true });
for (const item of ARQUIVOS) cpSync(join(raiz, item), join(pacote, item), { recursive: true });

// 1. O .exe
const exe = join(saida, "Instalar-ClauGPT-MCP.exe");
execFileSync(
  "makensis",
  ["-V2", "-INPUTCHARSET", "UTF8", `-DVERSAO=${versao}`, `-DPACOTE=${pacote}`, `-DSAIDA=${exe}`, join(raiz, "instalador", "instalador.nsi")],
  { stdio: "inherit" },
);
if (!existsSync(exe)) throw new Error("O makensis não gerou o .exe.");
zipar(join(saida, "Instalar-ClauGPT-MCP.zip"), saida, ["Instalar-ClauGPT-MCP.exe"]);

// 2. O .cmd: um arquivo que é ao mesmo tempo .bat e PowerShell, com o projeto em base64 no meio.
const zipProjeto = join(saida, "projeto.zip");
zipar(zipProjeto, pacote, ARQUIVOS);
const base64 = readFileSync(zipProjeto).toString("base64");
rmSync(zipProjeto);
const cmd = [
  "<# :",
  "@echo off",
  "setlocal",
  `title Instalador - ClauGPT MCP ${versao}`,
  'set "MCP_INSTALADOR=%~f0"',
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:MCP_INSTALADOR))"',
  "echo.",
  "pause",
  "exit /b",
  "#>",
  `$pacote = '${base64}'`,
  "# Extrai o projeto embutido numa pasta fixa e roda o instalador de verdade.",
  "$ErrorActionPreference = 'Stop'",
  "$destino = Join-Path $env:LOCALAPPDATA 'mcp-chatgpt'",
  `Write-Host "Preparando os arquivos (versao ${versao})..."`,
  "New-Item -ItemType Directory -Force $destino | Out-Null",
  "# Tira o código antigo (mantém node_modules para a reinstalação ser rápida).",
  "foreach ($velho in 'src', 'dist') { Remove-Item (Join-Path $destino $velho) -Recurse -Force -ErrorAction SilentlyContinue }",
  '$zip = Join-Path $env:TEMP "mcp-chatgpt-pacote-$PID.zip"',
  "[IO.File]::WriteAllBytes($zip, [Convert]::FromBase64String($pacote))",
  "Expand-Archive -Path $zip -DestinationPath $destino -Force",
  "Remove-Item $zip",
  "& (Join-Path $destino 'instalar.ps1')",
  "",
].join("\r\n");
writeFileSync(join(saida, "Instalar-ClauGPT-MCP.cmd"), cmd);
zipar(join(saida, "Instalar-ClauGPT-MCP-cmd.zip"), saida, ["Instalar-ClauGPT-MCP.cmd"]);

rmSync(pacote, { recursive: true, force: true });
console.log(`Versão ${versao} gerada em ${saida}`);
