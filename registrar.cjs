// Registra este servidor como "chatgpt" no Claude deste computador (Windows, Linux ou Mac):
//  - Claude Code (aba Code no Windows; o claude no terminal no Linux): ~/.claude.json
//  - Claude Desktop (chat comum): claude_desktop_config.json, onde quer que o app o guarde
// O Codex é o de CODEX_BIN, se definido (o instalador do Linux define); senão, o do npm global.
// Guarda um backup de cada arquivo antes da primeira alteração. Uso: node registrar.cjs
// Com --remover, tira o servidor desses arquivos (o desinstalador usa).
const fs = require("fs");
const path = require("path");
const os = require("os");

const servidor = path.join(__dirname, "dist", "index.js");
const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const localappdata = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const windows = process.platform === "win32";
function acharCodex() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (windows) return path.join(appdata, "npm", "codex.cmd");
  try {
    return require("child_process").execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim() || "codex";
  } catch {
    return "codex";
  }
}
const codex = acharCodex();
const remover = process.argv.includes("--remover");

if (!remover && !fs.existsSync(servidor)) {
  console.error(`Não achei ${servidor}. Rode "npm run build" antes.`);
  process.exit(1);
}

// CHATGPT_ESPERA_MAX_MS: quanto cada ferramenta espera antes de responder "ainda trabalhando".
// O chat comum do Claude Desktop desiste depois de 60 s; a aba Code espera bem mais.
const entradaPara = (esperaMs) => ({
  // Caminho completo do Node: o Claude pode ter sido aberto antes do Node ser instalado.
  command: process.execPath,
  args: [servidor],
  env: { CODEX_BIN: codex, CHATGPT_TIMEOUT_MS: "600000", CHATGPT_ESPERA_MAX_MS: String(esperaMs) },
});

// Lê (ou cria), faz backup e grava o servidor no arquivo. Devolve false se o arquivo for inválido.
function registrar(arquivo, servidorConfig) {
  let j = {};
  if (fs.existsSync(arquivo)) {
    const texto = fs.readFileSync(arquivo, "utf8");
    try {
      j = texto.trim() ? JSON.parse(texto) : {};
    } catch {
      console.error(`  ${arquivo} não é um JSON válido; não mexi nele.`);
      return false;
    }
    // Só o primeiro backup interessa (o de antes de qualquer registro); rodar de novo não o sobrescreve.
    const backup = arquivo + ".backup-antes-mcp-chatgpt";
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, texto);
  } else {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  }
  j.mcpServers = j.mcpServers || {};
  j.mcpServers.chatgpt = servidorConfig;
  fs.writeFileSync(arquivo, JSON.stringify(j, null, 2));
  return true;
}

// Tira o servidor do arquivo, se estiver lá. O resto da configuração fica como está.
function desregistrar(arquivo) {
  if (!fs.existsSync(arquivo)) return false;
  try {
    const j = JSON.parse(fs.readFileSync(arquivo, "utf8") || "{}");
    if (!j.mcpServers || !j.mcpServers.chatgpt) return false;
    delete j.mcpServers.chatgpt;
    fs.writeFileSync(arquivo, JSON.stringify(j, null, 2));
    return true;
  } catch {
    console.error(`  ${arquivo} não é um JSON válido; não mexi nele.`);
    return false;
  }
}

function subpastas(pasta, prefixo) {
  try {
    return fs
      .readdirSync(pasta, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.toLowerCase().startsWith(prefixo.toLowerCase()))
      .map((d) => path.join(pasta, d.name));
  } catch {
    return [];
  }
}

// Onde o Claude Desktop pode guardar a configuração, conforme o sistema e o jeito que foi instalado.
function configsDoDesktop() {
  if (!windows) {
    const pasta =
      process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "Claude")
        : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Claude");
    const arquivo = path.join(pasta, "claude_desktop_config.json");
    // Sem a pasta, o app não está instalado: não cria nada.
    return fs.existsSync(pasta) ? [arquivo] : [];
  }
  const candidatos = [
    // Versões novas do app (dados em AppData\Local\Claude-Data\claude_<id>)
    ...subpastas(path.join(localappdata, "Claude-Data"), "claude_").map((p) => path.join(p, "claude_desktop_config.json")),
    // Instalação clássica
    path.join(appdata, "Claude", "claude_desktop_config.json"),
    // Instalação pela Microsoft Store (pasta virtualizada do pacote)
    ...subpastas(path.join(localappdata, "Packages"), "Claude_").map((p) =>
      path.join(p, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"),
    ),
  ];
  const existentes = candidatos.filter((c) => fs.existsSync(c));
  if (existentes.length) return existentes;
  // Nenhuma configuração ainda: cria no lugar onde o app guarda os dados dele.
  const pastaDados = candidatos.map(path.dirname).find((d) => fs.existsSync(d));
  return pastaDados ? [path.join(pastaDados, "claude_desktop_config.json")] : [];
}

let ok = true;
const cfgCode = path.join(os.homedir(), ".claude.json");

if (remover) {
  for (const arquivo of [cfgCode, ...configsDoDesktop()]) {
    if (desregistrar(arquivo)) console.log(`  Removido de ${arquivo}`);
  }
  process.exit(0);
}

// Claude Code
const nomeCode = windows ? "Claude Code (aba Code)" : "Claude Code";
if (registrar(cfgCode, { type: "stdio", ...entradaPara(540000) })) console.log(`  ${nomeCode}: registrado em ${cfgCode}`);
else ok = false;

// Claude Desktop
const desktop = configsDoDesktop();
if (desktop.length === 0) {
  console.log("  Claude Desktop (chat comum): app não encontrado neste PC; pulei.");
}
for (const arquivo of desktop) {
  if (registrar(arquivo, entradaPara(45000))) console.log(`  Claude Desktop (chat comum): registrado em ${arquivo}`);
  else ok = false;
}

process.exit(ok ? 0 : 1);
