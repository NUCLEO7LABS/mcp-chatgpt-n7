// Atualização automática do ClauGPT MCP pelas versões publicadas no GitHub (releases).
//
// Cada versão publicada traz o pacote do servidor já compilado (clauGPT-mcp-<versão>.tar.gz) e um
// clauGPT-mcp.json com a versão e a impressão digital (SHA-256) do pacote. O servidor lê esse .json pelo
// link fixo "releases/latest/download" do GitHub (sem a API, que limita a 60 consultas por hora por endereço
// de internet: numa empresa, todos os PCs saem pelo mesmo). Havendo versão nova:
// - só código mudou: baixa, confere a impressão digital, guarda a versão atual (para voltar, se preciso) e
//   copia a nova por cima. Vale a partir da próxima vez que o Claude abrir o servidor.
// - as bibliotecas mudaram: não troca nada com o Claude aberto (no Windows os arquivos delas ficam presos
//   enquanto o servidor roda) e avisa que é preciso rodar o instalador novo, com o link dele.
// Desliga com CHATGPT_ATUALIZACAO=0. O repositório sai de CHATGPT_ATUALIZACAO_REPO (padrão abaixo).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = process.env.CHATGPT_ATUALIZACAO_REPO ?? "NUCLEO7LABS/mcp-chatgpt-n7";
export const GITHUB = process.env.CHATGPT_ATUALIZACAO_BASE ?? "https://github.com"; // trocado só nos testes
export const ATUALIZACAO_LIGADA = process.env.CHATGPT_ATUALIZACAO !== "0";
const INTERVALO_MS = 12 * 60 * 60 * 1000;

// Pasta do projeto instalado (dist/atualizacao.js → ..).
export const PROJETO = dirname(dirname(fileURLToPath(import.meta.url)));
const PASTA = join(PROJETO, "atualizacao");
// O que a atualização substitui. node_modules, o registro e esta pasta ficam.
const ITENS = ["dist", "src", "interface", "modelos", "servidor.mjs", "package.json", "package-lock.json", "tsconfig.json", "iniciar.ps1", "instalar.ps1", "registrar.cjs", "testar.mjs", "instalar-linux.sh", "README.md"];

export type EstadoAtualizacao = {
  verificadoEm?: string;
  ultima?: string; // versão mais nova publicada
  situacao: "em dia" | "instalada" | "precisa do instalador" | "erro" | "desligada" | "nunca verificada";
  detalhe?: string;
  linkInstalador?: string;
};

let estado: EstadoAtualizacao = { situacao: ATUALIZACAO_LIGADA ? "nunca verificada" : "desligada" };
let aviso: string | undefined; // dado uma vez ao Claude, na próxima resposta de uma ferramenta
let emAndamento: Promise<EstadoAtualizacao> | undefined;

export function estadoAtualizacao(): EstadoAtualizacao {
  return estado;
}

// Devolve o aviso de atualização (só uma vez).
export function tirarAviso(): string | undefined {
  const a = aviso;
  aviso = undefined;
  return a;
}

function comparar(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

async function baixar(url: string, ms = 120_000): Promise<Buffer> {
  const r = await fetch(url, { headers: { "User-Agent": "ClauGPT-MCP" }, signal: AbortSignal.timeout(ms), redirect: "follow" });
  if (!r.ok) throw new Error(`download falhou (${r.status}) em ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

// Dependências do package-lock, sem a versão do próprio projeto (que muda a cada versão).
function dependencias(lock: string): string {
  const j = JSON.parse(lock);
  delete j.version;
  if (j.packages?.[""]) delete j.packages[""].version;
  return JSON.stringify(j.packages ?? j.dependencies ?? {});
}

function extrair(arquivo: string, destino: string): Promise<void> {
  // O tar vem com o Windows 10 e 11 (System32) e lê .tar.gz.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  return new Promise((ok, falha) => {
    const p = spawn(tar, ["-xzf", arquivo, "-C", destino], { windowsHide: true, stdio: "ignore" });
    p.on("error", falha);
    p.on("close", (c) => (c === 0 ? ok() : falha(new Error(`tar saiu com código ${c}`))));
  });
}

type Manifesto = { versao: string; pacote: string; sha256: string; instalador?: string };

async function procurar(versaoAtual: string): Promise<EstadoAtualizacao> {
  const agora = new Date().toISOString();
  const r = await fetch(`${GITHUB}/${REPO}/releases/latest/download/clauGPT-mcp.json`, {
    headers: { "User-Agent": "ClauGPT-MCP" },
    signal: AbortSignal.timeout(10_000),
    redirect: "follow",
  });
  if (r.status === 404) return { verificadoEm: agora, situacao: "em dia", detalhe: "nenhuma versão publicada ainda" };
  if (!r.ok) throw new Error(`GitHub respondeu ${r.status}`);
  const m = (await r.json()) as Manifesto;
  const ultima = m.versao;
  if (comparar(ultima, versaoAtual) <= 0) return { verificadoEm: agora, ultima, situacao: "em dia" };
  // Outra cópia do servidor (outra janela do Claude) já instalou esta versão: falta só reiniciar o Claude.
  const noDisco = await readFile(join(PROJETO, "package.json"), "utf8")
    .then((t) => String(JSON.parse(t).version ?? "0"))
    .catch(() => "0");
  if (comparar(ultima, noDisco) <= 0) {
    return { verificadoEm: agora, ultima, situacao: "instalada", detalhe: `a versão ${ultima} já está instalada; vale depois de reiniciar o Claude` };
  }

  const arquivoDaVersao = (nome: string) => `${GITHUB}/${REPO}/releases/download/v${ultima}/${encodeURIComponent(nome)}`;
  // No Linux, o "instalador" é o comando do terminal que roda o instalar-linux.sh de novo.
  const instalador =
    process.platform === "linux"
      ? `curl -fsSL ${GITHUB}/${REPO}/releases/latest/download/instalar-linux.sh | bash (num terminal, com o Claude fechado)`
      : arquivoDaVersao(m.instalador ?? "Instalar-ClauGPT-MCP.exe");
  if (!m.pacote || !m.sha256) {
    return { verificadoEm: agora, ultima, situacao: "precisa do instalador", linkInstalador: instalador, detalhe: "a versão nova não tem pacote de atualização" };
  }

  // Baixa e confere a impressão digital.
  const pacote = await baixar(arquivoDaVersao(m.pacote));
  const obtido = createHash("sha256").update(pacote).digest("hex");
  if (obtido !== m.sha256.toLowerCase()) throw new Error("o pacote baixado não confere com a impressão digital publicada (download corrompido?)");

  await mkdir(PASTA, { recursive: true });
  // O Claude abre mais de uma cópia do servidor (aba Code, chat): só uma atualiza; as outras esperam a próxima vez.
  const liberar = await travar();
  if (!liberar) return { verificadoEm: agora, ultima, situacao: "em dia", detalhe: "outra janela do Claude já está atualizando" };
  try {
    return await instalar(pacote, m, ultima, versaoAtual, agora, instalador);
  } finally {
    await liberar();
  }
}

const TRAVA_VELHA_MS = 10 * 60 * 1000;

// Cria atualizacao/trava de forma exclusiva. Devolve como soltar, ou undefined se outra cópia está atualizando.
async function travar(): Promise<(() => Promise<void>) | undefined> {
  const trava = join(PASTA, "trava");
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const f = await open(trava, "wx");
      await f.writeFile(String(process.pid));
      await f.close();
      return () => rm(trava, { force: true });
    } catch {
      // Trava esquecida por um servidor que fechou no meio: passa por cima.
      const s = await stat(trava).catch(() => undefined);
      if (s && Date.now() - s.mtimeMs < TRAVA_VELHA_MS) return undefined;
      await rm(trava, { force: true });
    }
  }
  return undefined;
}

// Troca um item do projeto pelo novo: copia ao lado e só então troca os nomes, para nunca ficar sem ele.
async function trocar(origem: string, destino: string) {
  const temporario = `${destino}.nova-${process.pid}`;
  const velho = `${destino}.velha-${process.pid}`;
  await rm(temporario, { recursive: true, force: true });
  await cp(origem, temporario, { recursive: true, force: true });
  const tinha = existsSync(destino);
  if (tinha) await renomear(destino, velho);
  try {
    await renomear(temporario, destino);
  } catch (e) {
    if (tinha) await renomear(velho, destino).catch(() => undefined);
    await rm(temporario, { recursive: true, force: true });
    throw e;
  }
  if (tinha) await rm(velho, { recursive: true, force: true }).catch(() => undefined);
}

// No Windows, um antivírus lendo o arquivo novo faz o rename falhar por um instante: tenta de novo.
async function renomear(de: string, para: string) {
  for (let i = 0; ; i++) {
    try {
      return await rename(de, para);
    } catch (e) {
      if (i >= 8) throw e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
}

// Todos os arquivos de dist/ do pacote estão no projeto, do mesmo tamanho?
async function distCompleto(novo: string): Promise<boolean> {
  for (const nome of await readdir(join(novo, "dist"))) {
    const a = await stat(join(novo, "dist", nome)).catch(() => undefined);
    const b = await stat(join(PROJETO, "dist", nome)).catch(() => undefined);
    if (!a || !b || (a.isFile() && a.size !== b.size)) return false;
  }
  return true;
}

async function instalar(
  pacote: Buffer,
  m: Manifesto,
  ultima: string,
  versaoAtual: string,
  agora: string,
  instalador: string,
): Promise<EstadoAtualizacao> {
  const novo = join(PASTA, `nova-${ultima}-${process.pid}`);
  await rm(novo, { recursive: true, force: true });
  await mkdir(novo, { recursive: true });
  const arquivo = join(PASTA, `clauGPT-mcp-${ultima}-${process.pid}.tar.gz`);
  await writeFile(arquivo, pacote);
  await extrair(arquivo, novo);
  if (!existsSync(join(novo, "dist", "index.js"))) throw new Error("o pacote não traz o servidor compilado");

  // Bibliotecas diferentes: só o instalador troca com segurança.
  const lockAtual = await readFile(join(PROJETO, "package-lock.json"), "utf8").catch(() => "");
  const lockNovo = await readFile(join(novo, "package-lock.json"), "utf8").catch(() => "");
  if (!lockAtual || !lockNovo || dependencias(lockAtual) !== dependencias(lockNovo)) {
    await rm(novo, { recursive: true, force: true });
    await rm(arquivo, { force: true });
    return { verificadoEm: agora, ultima, situacao: "precisa do instalador", linkInstalador: instalador, detalhe: "a versão nova muda as bibliotecas do servidor" };
  }

  // Guarda a versão atual e copia a nova por cima.
  // Só a última cópia de segurança fica.
  for (const nome of await readdir(PASTA)) if (nome.startsWith("anterior-")) await rm(join(PASTA, nome), { recursive: true, force: true });
  const anterior = join(PASTA, `anterior-${versaoAtual}`);
  await mkdir(anterior, { recursive: true });
  for (const item of ITENS) {
    if (existsSync(join(PROJETO, item))) await cp(join(PROJETO, item), join(anterior, item), { recursive: true });
  }
  try {
    for (const item of ITENS) {
      if (existsSync(join(novo, item))) await trocar(join(novo, item), join(PROJETO, item));
    }
    if (!(await distCompleto(novo))) throw new Error("a cópia do servidor novo não ficou completa");
  } catch (e) {
    // Deu errado no meio: volta tudo para a versão que estava rodando.
    for (const item of ITENS) {
      if (existsSync(join(anterior, item))) await trocar(join(anterior, item), join(PROJETO, item)).catch(() => undefined);
    }
    await rm(novo, { recursive: true, force: true });
    await rm(arquivo, { force: true });
    throw new Error(`a atualização não terminou e a versão ${versaoAtual} foi mantida (${(e as Error).message})`);
  }
  await rm(novo, { recursive: true, force: true });
  await rm(arquivo, { force: true });
  await writeFile(join(PASTA, "ultima.json"), JSON.stringify({ de: versaoAtual, para: ultima, quando: agora }, null, 2));
  return { verificadoEm: agora, ultima, situacao: "instalada", detalhe: `atualizado da ${versaoAtual} para a ${ultima}` };
}

// Confere (e instala, se der) a versão mais nova. Uma verificação por vez.
export function verificarAtualizacao(versaoAtual: string): Promise<EstadoAtualizacao> {
  if (!ATUALIZACAO_LIGADA) return Promise.resolve(estado);
  emAndamento ??= procurar(versaoAtual)
    .catch((e): EstadoAtualizacao => ({ verificadoEm: new Date().toISOString(), situacao: "erro", detalhe: (e as Error).message }))
    .then((novo) => {
      const antes = estado.situacao;
      estado = novo;
      if (novo.situacao === "instalada" && antes !== "instalada") {
        aviso = `O ClauGPT MCP foi atualizado sozinho para a versão ${novo.ultima}. Diga ao usuário para reiniciar o Claude (ícone perto do relógio → Sair, e abrir de novo) para usar a versão nova.`;
      } else if (novo.situacao === "precisa do instalador" && antes !== "precisa do instalador") {
        aviso = `Saiu a versão ${novo.ultima} do ClauGPT MCP, que precisa do instalador novo (${novo.detalhe}). Avise o usuário e passe o link: ${novo.linkInstalador}`;
      }
      return novo;
    })
    .finally(() => (emAndamento = undefined));
  return emAndamento;
}

// Confere pouco depois de abrir e depois a cada 12 horas.
export function agendarAtualizacoes(versaoAtual: string) {
  if (!ATUALIZACAO_LIGADA) return;
  setTimeout(() => void verificarAtualizacao(versaoAtual), 20_000).unref();
  setInterval(() => void verificarAtualizacao(versaoAtual), INTERVALO_MS).unref();
}
