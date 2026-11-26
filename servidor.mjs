// Porta de entrada do ClauGPT MCP: é este arquivo que o Claude abre (registrar.cjs).
// Abre o servidor de dist/. Se ele não carregar (uma atualização interrompida no meio, um antivírus que
// apagou um arquivo), volta para a cópia da versão anterior que a atualização guardou e tenta de novo,
// para o ClauGPT não sumir do Claude.

import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const raiz = dirname(fileURLToPath(import.meta.url));
const principal = join(raiz, "dist", "index.js");

function copiaAnterior() {
  const pasta = join(raiz, "atualizacao");
  if (!existsSync(pasta)) return undefined;
  return readdirSync(pasta)
    .filter((n) => n.startsWith("anterior-") && existsSync(join(pasta, n, "dist", "index.js")))
    .map((n) => join(pasta, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

try {
  await import(pathToFileURL(principal).href);
} catch (erro) {
  const codigo = erro && typeof erro === "object" ? erro.code : undefined;
  // Só erros de carregamento (arquivo faltando, código truncado); um erro do próprio servidor sobe igual.
  const deCarga = codigo === "ERR_MODULE_NOT_FOUND" || erro instanceof SyntaxError || !existsSync(principal);
  const anterior = deCarga ? copiaAnterior() : undefined;
  if (!anterior) throw erro;
  process.stderr.write(`[ClauGPT] o servidor não carregou (${erro.message}); voltando para a cópia em ${anterior}\n`);
  for (const item of readdirSync(anterior)) {
    const destino = join(raiz, item);
    if (item === "dist" || item === "src" || item === "interface") rmSync(destino, { recursive: true, force: true });
    cpSync(join(anterior, item), destino, { recursive: true, force: true });
  }
  await import(pathToFileURL(principal).href + "?restaurado");
}
