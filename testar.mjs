// Abre o servidor exatamente como está registrado no Claude Code e faz uma pergunta curta ao ChatGPT.
// Uso: node testar.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cfg = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")).mcpServers?.chatgpt;
if (!cfg) {
  console.error('O servidor "chatgpt" não está registrado. Rode: node registrar.cjs');
  process.exit(1);
}

// Ambiente mínimo, sem o PATH deste terminal, como o Claude faz ao abrir o servidor.
const env = { ...cfg.env };
for (const k of ["SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) if (process.env[k]) env[k] = process.env[k];

const client = new Client({ name: "testar", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env, stderr: "ignore" }));
const ferramentas = (await client.listTools()).tools.map((t) => t.name);
console.log("Ferramentas:", ferramentas.join(", "));

const r = await client.callTool(
  { name: "perguntar_chatgpt", arguments: { prompt: "Responda só: funcionando" } },
  undefined,
  { timeout: 300000 },
);
await client.close();
const texto = r.content[0]?.text ?? "";
if (r.isError) {
  console.error("O ChatGPT não respondeu:\n" + texto);
  process.exit(1);
}
console.log("ChatGPT respondeu:", texto.split("\n")[0]);
