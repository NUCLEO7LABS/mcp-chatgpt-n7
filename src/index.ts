#!/usr/bin/env node
// Servidor MCP que dá ao Claude as ferramentas "perguntar_chatgpt" e "gerar_imagem".
// Usa o Codex CLI da OpenAI, que faz login com a sua conta do ChatGPT
// (Plus/Pro/Team) — então não precisa de chave de API.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import sharp from "sharp";
import { z } from "zod";
import { MODELO_RECORTE, type OpcoesRecorte, recortarComIA, recorteDisponivel } from "./recorte.js";
import { acharNavegador, montarEditavel, renderizarHtml } from "./arte.js";
import { acharMarca, cssDasFontes, lerKit, listarMarcas, PASTA_MARCAS, salvarMarca } from "./marca.js";
import { agendarAtualizacoes, estadoAtualizacao, tirarAviso, verificarAtualizacao } from "./atualizacao.js";

const VERSAO = "1.10.0";
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const TIMEOUT_MS = Number(process.env.CHATGPT_TIMEOUT_MS ?? 5 * 60 * 1000);

const FORMATOS_IMAGEM = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

// O Codex guarda as imagens que gera em <CODEX_HOME>/generated_images/<id da conversa>/
// e o histórico de cada conversa em <CODEX_HOME>/sessions/**/rollout-...-<id>.jsonl.
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
// Para onde copiamos as imagens geradas (padrão: Imagens\ChatGPT).
const PASTA_IMAGENS = process.env.CHATGPT_IMAGENS_DIR ?? join(homedir(), "Pictures", "ChatGPT");
// Lado maior da prévia devolvida ao Claude (o arquivo salvo fica em tamanho cheio).
const LADO_PREVIA = Number(process.env.CHATGPT_LADO_PREVIA ?? 768);
const MAX_VARIACOES = 4;

type Resposta = { texto: string; conversaId?: string };
type OpcoesCodex = {
  conversaId?: string;
  modelo?: string;
  imagens?: string[];
  config?: string[]; // pares chave=valor para o -c do Codex
};

// Com shell: true (Windows) os argumentos viram uma linha de comando,
// então caminhos com espaço (ex.: C:\Users\Fulano de Tal) precisam de aspas.
function argumentoShell(arg: string): string {
  if (process.platform !== "win32" || !/[\s&|<>^"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

// O codex.cmd chama "node" pelo PATH. O Claude pode ter sido aberto antes do Node ser instalado
// (e aí não o acha), então colocamos na frente a pasta do Node que está rodando este servidor
// e a pasta dos programas globais do npm.
function ambienteComNode(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const chave = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const extras = [dirname(process.execPath)];
  if (process.env.APPDATA) extras.push(join(process.env.APPDATA, "npm"));
  env[chave] = [...extras, env[chave] ?? ""].join(process.platform === "win32" ? ";" : ":");
  return env;
}

// Codex rodando agora, para encerrar junto com o servidor.
const filhos = new Set<ChildProcess>();

// No Windows o Codex roda dentro de um cmd.exe (shell: true): kill() fecharia só o cmd, e o Codex
// seguiria rodando escondido, gastando o limite do ChatGPT. O taskkill /T leva a árvore inteira.
function encerrar(filho: ChildProcess) {
  if (filho.exitCode !== null || filho.signalCode !== null) return;
  if (process.platform === "win32" && filho.pid) {
    try {
      spawnSync("taskkill", ["/pid", String(filho.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    } catch {
      // sem taskkill: tenta o kill comum
    }
  }
  filho.kill();
}

// Quando o Claude fecha o servidor, nada do que ele começou deve continuar rodando.
function encerrarTodos() {
  for (const filho of filhos) encerrar(filho);
}
process.stdin.on("close", () => {
  encerrarTodos();
  process.exit(0);
});
for (const sinal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sinal, () => {
    encerrarTodos();
    process.exit(0);
  });
}

// Troca as mensagens técnicas do Codex por algo que dê para agir.
function explicarErro(bruto: string): string {
  const texto = bruto.trim();
  if (/401|unauthorized|not logged in/i.test(texto)) {
    return "O Codex não está logado na sua conta do ChatGPT. Rode no terminal: codex login --device-auth";
  }
  if (/usage limit|rate limit|429|quota|too many requests/i.test(texto)) {
    return "Você atingiu o limite de uso da sua assinatura do ChatGPT. Espere um pouco e tente de novo.";
  }
  // As últimas linhas costumam ter a causa; o começo é ruído de log.
  return texto.length > 1500 ? "…" + texto.slice(-1500) : texto;
}

// Roda um comando curto do Codex (versão, status do login) e devolve a saída, sem lançar erro.
function rodarCodex(args: string[], ms = 20_000): Promise<{ ok: boolean; saida: string }> {
  return new Promise((ok) => {
    let saida = "";
    let filho: ChildProcess;
    try {
      filho = spawn(argumentoShell(CODEX_BIN), args.map(argumentoShell), {
        env: ambienteComNode(),
        shell: process.platform === "win32",
        windowsHide: true,
      });
    } catch (e) {
      return ok({ ok: false, saida: (e as Error).message });
    }
    filhos.add(filho);
    const timer = setTimeout(() => encerrar(filho), ms);
    filho.stdout?.on("data", (d) => (saida += d));
    filho.stderr?.on("data", (d) => (saida += d));
    filho.on("error", (e) => {
      clearTimeout(timer);
      filhos.delete(filho);
      ok({ ok: false, saida: e.message });
    });
    filho.on("close", (codigo) => {
      clearTimeout(timer);
      filhos.delete(filho);
      ok({ ok: codigo === 0, saida: saida.replace(/\x1b\[[0-9;]*m/g, "").trim() });
    });
  });
}

let versaoCodexCache: Promise<string> | undefined;
function versaoCodex(): Promise<string> {
  versaoCodexCache ??= rodarCodex(["--version"]).then((r) =>
    r.ok ? r.saida.split(/\r?\n/).pop() ?? "Codex" : "Codex não encontrado",
  );
  return versaoCodexCache;
}

// Confere cada imagem e devolve o caminho absoluto (o Codex roda numa pasta temporária,
// então caminhos relativos deixariam de funcionar).
async function validarImagens(imagens: string[]): Promise<string[]> {
  const caminhos: string[] = [];
  for (const imagem of imagens) {
    const caminho = resolve(imagem);
    if (!FORMATOS_IMAGEM.has(extname(caminho).toLowerCase())) {
      throw new Error(`Formato não suportado: ${imagem}. Use PNG, JPG, GIF ou WEBP.`);
    }
    try {
      await access(caminho);
    } catch {
      throw new Error(`Imagem não encontrada: ${caminho}`);
    }
    caminhos.push(caminho);
  }
  return caminhos;
}

async function perguntarAoCodex(prompt: string, opcoes: OpcoesCodex = {}): Promise<Resposta> {
  const { conversaId, modelo, imagens = [], config = [] } = opcoes;
  const caminhosImagens = await validarImagens(imagens);
  const pasta = await mkdtemp(join(tmpdir(), "mcp-chatgpt-"));
  const arquivoResposta = join(pasta, "resposta.txt");

  // read-only: o ChatGPT só responde, não mexe em arquivos nem roda comandos.
  // (via -c porque o "exec resume" não aceita --sandbox)
  const args = ["exec"];
  if (conversaId) args.push("resume", conversaId);
  args.push(
    "--json",
    "--skip-git-repo-check",
    "-c", "sandbox_mode=read-only",
    "--output-last-message", arquivoResposta,
  );
  for (const par of config) args.push("-c", par);
  if (modelo) args.push("--model", modelo);
  // --image=... para o Codex não engolir o "-" seguinte como outra imagem
  for (const caminho of caminhosImagens) args.push(`--image=${caminho}`);
  args.push("-"); // prompt vem pelo stdin

  try {
    const saida = await new Promise<string>((resolve, reject) => {
      const filho = spawn(argumentoShell(CODEX_BIN), args.map(argumentoShell), {
        cwd: pasta,
        env: ambienteComNode(),
        shell: process.platform === "win32", // no Windows o codex é um .cmd
        windowsHide: true,
      });
      filhos.add(filho);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        encerrar(filho);
        reject(new Error(`O ChatGPT demorou mais de ${TIMEOUT_MS / 1000}s para responder.`));
      }, TIMEOUT_MS);

      filho.stdout.on("data", (d) => (stdout += d));
      filho.stderr.on("data", (d) => (stderr += d));
      filho.on("error", (e) => {
        clearTimeout(timer);
        filhos.delete(filho);
        reject(new Error(`Não consegui rodar "${CODEX_BIN}". O Codex CLI está instalado? (${e.message})`));
      });
      filho.on("close", (codigo) => {
        clearTimeout(timer);
        filhos.delete(filho);
        if (codigo === 0) resolve(stdout);
        else reject(new Error(explicarErro(stderr || stdout || `Codex saiu com código ${codigo}.`)));
      });

      filho.stdin.end(prompt);
    });

    // O --json emite um evento por linha; o "thread.started" traz o id da conversa.
    let novaConversaId = conversaId;
    for (const linha of saida.split(/\r?\n/)) {
      try {
        const evento = JSON.parse(linha);
        if (evento.type === "thread.started" && evento.thread_id) novaConversaId = evento.thread_id;
      } catch {
        // linha que não é JSON: ignora
      }
    }

    const texto = (await readFile(arquivoResposta, "utf8").catch(() => "")).trim();
    return { texto, conversaId: novaConversaId };
  } finally {
    await rm(pasta, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- Geração de imagens ----------

const FORMATOS = {
  quadrado: "quadrado, proporção 1:1",
  paisagem: "horizontal (paisagem), proporção 16:9 — bem mais larga do que alta",
  retrato: "vertical (retrato), proporção 2:3 — mais alta do que larga",
  story: "vertical 9:16, tela cheia de celular (story/reels)",
  post_instagram: "vertical 4:5, post de feed do Instagram",
} as const;

// Categorias do guia de prompts do próprio gerador da OpenAI.
const USOS = {
  foto: "photorealistic-natural — foto realista, luz e texturas naturais",
  produto: "product-mockup — foto de produto/embalagem, padrão catálogo",
  logo: "logo-brand — logo/marca, formas simples e fáceis de vetorizar",
  marketing: "ads-marketing — peça de anúncio/campanha",
  ilustracao: "illustration-story — ilustração",
  arte_conceitual: "stylized-concept — arte conceitual / render estilizado",
  interface: "ui-mockup — tela de app/site",
  infografico: "infographic-diagram — infográfico/diagrama com texto organizado",
  icone: "ícone — um único objeto centralizado, silhueta clara, legível em tamanho pequeno, com margem",
  personagem: "personagem/mascote — design consistente, expressivo, corpo inteiro salvo pedido contrário",
} as const;

// Linguagens visuais prontas, com o vocabulário que o gerador entende bem.
const ESTILOS = {
  "3d": "render 3D estilizado: formas volumosas, iluminação de estúdio suave, oclusão ambiente, sombras de contato, materiais com leve brilho",
  icone_3d:
    "ícone 3D estilo app/emoji: formas arredondadas e simplificadas, material plástico macio levemente brilhante, iluminação de estúdio vinda de cima à esquerda, objeto único centralizado, sem cenário",
  clay: "3D estilo massinha (claymorphism): superfícies foscas e macias, cantos bem arredondados, cores pastéis, luz difusa",
  vidro: "3D em vidro fosco (glassmorphism): material translúcido, refrações suaves, reflexos de borda, cores vivas atrás do vidro",
  isometrico: "ilustração 3D isométrica: câmera isométrica de 30°, cena em miniatura organizada, sombras suaves",
  realista: "fotorrealista: lente e iluminação naturais, texturas e materiais reais, profundidade de campo natural",
  flat: "ilustração flat 2D: formas geométricas, cores chapadas, sem gradientes nem texturas",
  ilustracao_digital: "ilustração digital pintada: pinceladas suaves, iluminação dramática, acabamento detalhado",
  aquarela: "aquarela: manchas e transparências de tinta, bordas orgânicas, textura de papel",
  line_art: "line art: traço limpo e contínuo, sem preenchimento ou com preenchimento mínimo",
  pixel_art: "pixel art: grade de pixels visível, paleta limitada, sem anti-aliasing",
  anime: "anime/mangá: contornos definidos, cel shading, olhos expressivos",
} as const;

// Como usar as imagens de referência.
const MODOS_REFERENCIA = {
  igual:
    "RECRIAR FIELMENTE a referência: mesma composição e layout, mesmo enquadramento e proporção, mesma paleta de cores (tons exatos), " +
    "mesma tipografia (família, peso, caixa, posição), mesmos elementos e na mesma posição, mesmo estilo de traço/render, " +
    "mesma iluminação e acabamento. Mude APENAS o que o pedido principal disser; todo o resto deve ficar igual.",
  parecida:
    "ARTE NOVA NO MESMO ESTILO da referência: mesma linguagem visual, paleta, tipografia, iluminação, nível de detalhe e " +
    "acabamento — como se fosse da mesma série ou do mesmo artista — mas com o conteúdo do pedido principal.",
  inspiracao: "INSPIRAÇÃO LIVRE: use a referência só como ponto de partida de clima/ideia; pode mudar estilo e composição.",
  editar:
    "EDITAR a referência: ela é a própria imagem a ser modificada. Mude só o que o pedido disser e mantenha todo o resto " +
    "idêntico (pixels, composição, cores, texto).",
} as const;

type ModoReferencia = keyof typeof MODOS_REFERENCIA;

type OpcoesImagem = {
  descricao: string;
  formato?: keyof typeof FORMATOS;
  uso?: keyof typeof USOS;
  estilo?: keyof typeof ESTILOS;
  texto_exato?: string;
  evitar?: string[];
  fundo_transparente?: boolean;
  recorteLocal?: boolean; // fundo transparente feito aqui com IA (o gerador entrega fundo liso)
  referencias: string[]; // caminhos absolutos
  modoReferencia?: ModoReferencia;
  proporcaoReferencia?: string; // ex.: "1080×1350"
  edicaoEncadeada: boolean; // ajustar a imagem anterior da mesma conversa
  variacao?: { indice: number; total: number };
};

// Monta o pedido no formato de "spec" que o guia do gerador recomenda.
function montarSpec(o: OpcoesImagem): string {
  const linhas: string[] = [];
  if (o.uso) linhas.push(`Uso: ${USOS[o.uso]}`);
  if (o.estilo) linhas.push(`Estilo: ${ESTILOS[o.estilo]}`);
  linhas.push(`Pedido principal: ${o.descricao}`);
  if (o.referencias.length && o.modoReferencia) {
    linhas.push(`Imagens de referência (${o.referencias.length}): ${MODOS_REFERENCIA[o.modoReferencia]}`);
  }
  if (o.formato) linhas.push(`Formato/enquadramento: ${FORMATOS[o.formato]}`);
  else if (o.proporcaoReferencia) linhas.push(`Formato/enquadramento: mesma proporção da referência (${o.proporcaoReferencia}px)`);
  if (o.texto_exato) {
    const soletrado = o.texto_exato.length <= 40 ? ` (soletrando: ${[...o.texto_exato].join(" ")})` : "";
    linhas.push(`Texto (literal, exatamente assim, sem erros): "${o.texto_exato}"${soletrado}`);
  }
  if (o.fundo_transparente && o.recorteLocal) {
    // O recorte do próprio gerador deixa o objeto semitransparente e com halo; um fundo liso recortado
    // aqui com IA fica muito mais limpo.
    linhas.push(
      "Fundo: LISO, uma única cor sólida, chapada e uniforme, que contraste fortemente com o objeto e não apareça " +
        "em nenhuma parte dele (objeto claro → fundo escuro; objeto escuro ou colorido → fundo claro ou de cor oposta). " +
        "Sem degradê, vinheta, textura, cenário, chão, moldura, reflexo nem sombra projetada. Objeto inteiro dentro " +
        "do quadro, com margem em volta, bordas nítidas (sem desfoque de profundidade). O fundo será removido depois.",
    );
  } else if (o.fundo_transparente) {
    linhas.push(
      "Fundo: TRANSPARENTE de verdade (canal alfa). Só o objeto, recorte limpo, sem cenário, sem chão, sem moldura, " +
        "sem sombra projetada no fundo e sem quadriculado desenhado.",
    );
  }
  const evitar = [...(o.evitar ?? []), "marca d'água"];
  if (!o.texto_exato && o.modoReferencia !== "igual" && o.modoReferencia !== "editar") evitar.push("texto ou letras não pedidos");
  linhas.push(`Evitar: ${evitar.join("; ")}`);
  if (o.edicaoEncadeada) {
    linhas.push("Restrições: mude só o que o pedido diz; mantenha todo o resto idêntico (composição, formas, cores, enquadramento).");
  }
  if (o.variacao && o.variacao.total > 1) {
    linhas.push(`Variação ${o.variacao.indice} de ${o.variacao.total}: dê a sua própria interpretação visual do pedido.`);
  }
  return linhas.join("\n");
}

function montarPromptCodex(o: OpcoesImagem): string {
  const passos: string[] = [];
  if (o.referencias.length) {
    // O gerador só "vê" a referência se ela for passada a ele; descrever em texto não basta para copiar fielmente.
    passos.push(
      "As imagens de referência estão anexadas e também nestes arquivos:",
      ...o.referencias.map((r, i) => `  Imagem ${i + 1}: ${r}`),
      "Observe-as com atenção (layout, cores exatas, tipografia, estilo, elementos, proporção) e passe esses caminhos ao " +
        "gerador em referenced_image_paths, para que ele veja as referências de verdade.",
    );
  } else if (o.edicaoEncadeada) {
    passos.push("Edite a imagem gerada mais recentemente nesta conversa (use num_last_images_to_include: 1).");
  }
  return [
    "Chame a ferramenta de geração de imagens (image_gen) uma única vez, sem pedir confirmação.",
    "Não leia skills, não rode comandos de shell e não faça perguntas.",
    ...passos,
    `Use transparent_background: ${o.fundo_transparente && !o.recorteLocal ? "true" : "false"}.`,
    "Use a especificação abaixo como prompt. Pode melhorar a redação e acrescentar o que observou nas referências, " +
      "mas mantenha todos os itens, o texto literal e as restrições.",
    "",
    montarSpec(o),
    "",
    'Depois de gerar, responda só "ok".',
  ].join("\n");
}

type Geracao = { arquivo: string; promptFinal?: string; falha?: string };

async function acharSessao(conversaId: string): Promise<string | undefined> {
  const pasta = join(CODEX_HOME, "sessions");
  const nomes = await readdir(pasta, { recursive: true }).catch(() => [] as string[]);
  const nome = nomes.find((n) => n.endsWith(`${conversaId}.jsonl`));
  return nome ? join(pasta, nome) : undefined;
}

// Lê do histórico da conversa as gerações feitas a partir de "desde": arquivo, prompt final e falhas.
async function lerGeracoes(conversaId: string, desde: number): Promise<Geracao[]> {
  const sessao = await acharSessao(conversaId);
  if (!sessao) return [];
  const geracoes: Geracao[] = [];
  for (const linha of (await readFile(sessao, "utf8")).split(/\r?\n/)) {
    if (!linha.includes("image_gen.generation")) continue;
    try {
      const { payload } = JSON.parse(linha);
      const item = payload?.item;
      if (payload?.type !== "item_completed" || item?.kind !== "image_gen.generation") continue;
      if ((payload.started_at_ms ?? 0) < desde) continue;
      geracoes.push({
        arquivo: item.savedPath,
        promptFinal: item.revisedPrompt,
        falha: item.failure ? (typeof item.failure === "string" ? item.failure : JSON.stringify(item.failure)) : undefined,
      });
    } catch {
      // linha cortada ou de outro formato: ignora
    }
  }
  return geracoes;
}

// Plano B se o histórico mudar de formato: imagens novas na pasta da conversa.
async function listarGeradas(conversaId: string): Promise<string[]> {
  const pasta = join(CODEX_HOME, "generated_images", conversaId);
  const nomes = await readdir(pasta).catch(() => [] as string[]);
  return nomes.filter((n) => FORMATOS_IMAGEM.has(extname(n).toLowerCase())).map((n) => join(pasta, n));
}

async function gerarUma(
  o: OpcoesImagem,
  conversaId: string | undefined,
): Promise<{ geracoes: Geracao[]; conversaId?: string; texto: string }> {
  const inicio = Date.now() - 1000;
  const antigas = new Set(conversaId ? await listarGeradas(conversaId) : []);
  const resposta = await perguntarAoCodex(montarPromptCodex(o), {
    conversaId,
    imagens: o.referencias,
    // Raciocínio baixo: o trabalho pesado é do gerador, não do GPT. Fica bem mais rápido.
    config: ["model_reasoning_effort=low"],
  });
  if (!resposta.conversaId) return { geracoes: [], texto: resposta.texto };

  let geracoes = await lerGeracoes(resposta.conversaId, inicio);
  if (geracoes.length === 0) {
    geracoes = (await listarGeradas(resposta.conversaId)).filter((c) => !antigas.has(c)).map((arquivo) => ({ arquivo }));
  }
  return { geracoes, conversaId: resposta.conversaId, texto: resposta.texto };
}

function slug(texto: string): string {
  const s = texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((p) => p.length > 2 || /\d/.test(p))
    .slice(0, 6)
    .join("-");
  return s.slice(0, 50).replace(/-+$/, "") || "imagem";
}

// Numa edição, reaproveita o nome da imagem original (achado pela ficha .json com o mesmo conversa_id).
async function nomeDaOriginal(pasta: string, conversaId: string): Promise<string | undefined> {
  const nomes = await readdir(pasta).catch(() => [] as string[]);
  for (const nome of nomes.filter((n) => n.endsWith(".json"))) {
    try {
      const ficha = JSON.parse(await readFile(join(pasta, nome), "utf8"));
      if (ficha.conversa_id === conversaId) return nome.slice(0, -5).replace(/-editada(-\d+)?$/, "");
    } catch {
      // ficha ilegível: ignora
    }
  }
  return undefined;
}

async function nomeLivre(pasta: string, base: string, ext: string): Promise<string> {
  for (let i = 1; ; i++) {
    const caminho = join(pasta, `${base}${i > 1 ? `-${i}` : ""}${ext}`);
    try {
      await access(caminho);
    } catch {
      return caminho;
    }
  }
}

// ---------- Fundo transparente ----------

// Fração da borda da imagem que está (quase) transparente. Um recorte de verdade tem a borda toda transparente.
async function bordaTransparente(bytes: Buffer): Promise<number> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const borda = indicesDaBorda(info.width, info.height);
  return borda.filter((i) => data[i * 4 + 3] < 16).length / borda.length;
}

function indicesDaBorda(w: number, h: number): number[] {
  const borda: number[] = [];
  for (let x = 0; x < w; x++) borda.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) borda.push(y * w, y * w + w - 1);
  return borda;
}

function mediana(valores: number[]): number {
  const v = [...valores].sort((a, b) => a - b);
  return v[v.length >> 1];
}

// Remove um fundo de cor uniforme sem gastar o limite do ChatGPT: pinta de transparente tudo que estiver
// ligado à borda e tiver a cor do fundo (inundação a partir das bordas, então áreas internas da mesma cor
// ficam intactas). As bordas do objeto ganham transparência parcial para não ficarem serrilhadas.
// Devolve undefined quando o fundo não é uniforme o bastante (foto, degradê, cenário).
async function removerFundoUniforme(bytes: Buffer): Promise<Buffer | undefined> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const borda = indicesDaBorda(w, h);
  const fundo = [0, 1, 2].map((c) => mediana(borda.map((i) => data[i * 4 + c])));
  const distancia = (i: number) =>
    Math.hypot(data[i * 4] - fundo[0], data[i * 4 + 1] - fundo[1], data[i * 4 + 2] - fundo[2]);

  const uniforme = borda.filter((i) => distancia(i) < 40).length / borda.length;
  if (uniforme < 0.7) return undefined;

  const CHEIO = 30; // até aqui é fundo: 100% transparente
  const BORDA = 70; // entre CHEIO e BORDA: contorno do objeto, transparência parcial
  const visitado = new Uint8Array(w * h);
  const fila = new Int32Array(w * h);
  let inicio = 0;
  let fim = 0;
  for (const i of borda) {
    if (!visitado[i] && distancia(i) < BORDA) {
      visitado[i] = 1;
      fila[fim++] = i;
    }
  }
  while (inicio < fim) {
    const i = fila[inicio++];
    const d = distancia(i);
    const alfa = d <= CHEIO ? 0 : Math.round((255 * (d - CHEIO)) / (BORDA - CHEIO));
    data[i * 4 + 3] = Math.min(data[i * 4 + 3], alfa);
    if (d > CHEIO) continue; // contorno: não avança para dentro do objeto
    const x = i % w;
    const y = (i - x) / w;
    for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (n >= 0 && !visitado[n] && distancia(n) < BORDA) {
        visitado[n] = 1;
        fila[fim++] = n;
      }
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

type MetodoFundo = "ia" | "gerador" | "recorte local" | "falhou";

// Garante PNG com fundo transparente. Com o modelo de recorte instalado, usa a IA local (melhor resultado);
// sem ele, aceita o recorte do gerador se for real, ou remove um fundo liso.
async function garantirTransparencia(
  bytes: Buffer,
  opcoes: OpcoesRecorte = {},
): Promise<{ png: Buffer; metodo: MetodoFundo; avisos?: string[] }> {
  if (await recorteDisponivel()) {
    const { png, avisos } = await recortarComIA(bytes, opcoes);
    if ((await bordaTransparente(png)) >= 0.6) return { png, metodo: "ia", avisos };
  }
  if ((await bordaTransparente(bytes)) >= 0.6) return { png: await sharp(bytes).png().toBuffer(), metodo: "gerador" };
  const recortada = await removerFundoUniforme(bytes);
  if (recortada && (await bordaTransparente(recortada)) >= 0.6) return { png: recortada, metodo: "recorte local" };
  return { png: await sharp(bytes).png().toBuffer(), metodo: "falhou" };
}

// ---------- Salvar e devolver ----------

type ImagemFinal = {
  caminho: string;
  largura?: number;
  altura?: number;
  fundo?: MetodoFundo;
  avisosRecorte?: string[];
  promptFinal?: string;
  conversaId?: string;
  previa: { dados: string; mime: string };
};

async function finalizar(
  g: Geracao,
  destino: string,
  base: string,
  meta: Record<string, unknown>,
  conversaId: string | undefined,
  querTransparente: boolean,
  opcoesRecorte: OpcoesRecorte = {},
): Promise<ImagemFinal> {
  // sharp recebe os bytes, não o caminho: no Windows ele falha com caminhos curtos (8.3) e com acentos.
  let bytes: Buffer = await readFile(g.arquivo);
  let ext = extname(g.arquivo).toLowerCase() || ".png";
  let fundo: MetodoFundo | undefined;
  let avisosRecorte: string[] | undefined;
  if (querTransparente) {
    const r = await garantirTransparencia(bytes, opcoesRecorte);
    bytes = r.png;
    fundo = r.metodo;
    avisosRecorte = r.avisos;
    ext = ".png"; // transparência só faz sentido em PNG
  }
  const caminho = await nomeLivre(destino, base, ext);
  await writeFile(caminho, bytes);

  const info = await sharp(bytes).metadata();
  const previa = fundo !== undefined && fundo !== "falhou" ? await provaDoRecorte(bytes) : await gerarPrevia(bytes, false);

  // Ficha ao lado da imagem, para saber depois como ela foi feita.
  const ficha = {
    ...meta,
    prompt_final: g.promptFinal,
    conversa_id: conversaId,
    largura: info.width,
    altura: info.height,
    fundo_transparente_por: fundo,
    original_codex: g.arquivo,
    criada_em: new Date().toISOString(),
  };
  await writeFile(caminho.slice(0, -ext.length) + ".json", JSON.stringify(ficha, null, 2), "utf8");
  return { caminho, largura: info.width, altura: info.height, fundo, avisosRecorte, promptFinal: g.promptFinal, conversaId, previa };
}

// Prévia leve para o Claude: JPEG, ou WEBP quando há transparência.
async function gerarPrevia(bytes: Buffer, transparente: boolean): Promise<{ dados: string; mime: string }> {
  const reduzida = sharp(bytes).resize(LADO_PREVIA, LADO_PREVIA, { fit: "inside", withoutEnlargement: true });
  return transparente
    ? { dados: (await reduzida.webp({ quality: 85 }).toBuffer()).toString("base64"), mime: "image/webp" }
    : {
        dados: (await reduzida.flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer()).toString("base64"),
        mime: "image/jpeg",
      };
}

// Prévia de um recorte para conferir as bordas: o objeto sobre um fundo escuro e sobre um claro, lado a
// lado. Sobra de fundo, halo e buracos aparecem num dos dois.
async function provaDoRecorte(png: Buffer): Promise<{ dados: string; mime: string }> {
  const lado = Math.round(LADO_PREVIA * 0.75);
  const objeto = await sharp(png).resize(lado, lado, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  const { width = lado, height = lado } = await sharp(objeto).metadata();
  const sobre = (cor: string) => sharp({ create: { width, height, channels: 3, background: cor } }).composite([{ input: objeto }]).png().toBuffer();
  const [escuro, claro] = await Promise.all([sobre("#15181d"), sobre("#f1efe9")]);
  const dados = await sharp({ create: { width: width * 2 + 8, height, channels: 3, background: "#808080" } })
    .composite([{ input: escuro, left: 0, top: 0 }, { input: claro, left: width + 8, top: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
  return { dados: dados.toString("base64"), mime: "image/jpeg" };
}

function descreverFundo(fundo: MetodoFundo): string {
  if (fundo === "ia") return "fundo transparente: sim (recorte com IA aqui no computador, bordas calculadas pela cor do fundo)";
  if (fundo === "gerador") return "fundo transparente: sim (recorte do ChatGPT, verificado)";
  if (fundo === "recorte local") return "fundo transparente: sim (o ChatGPT entregou com fundo; removido aqui automaticamente)";
  return "fundo transparente: NÃO — o fundo não é uniforme para recortar; tente remover_fundo ou peça um fundo liso";
}

// Mantém o cliente informado enquanto espera (e evita que ele desista por demora).
type Extra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: any) => Promise<void>;
};
async function comProgresso<T>(extra: Extra, mensagem: string, tarefa: Promise<T>): Promise<T> {
  const token = extra._meta?.progressToken;
  if (token === undefined) return tarefa;
  const inicio = Date.now();
  let passo = 0;
  const enviar = () =>
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: ++passo, message: `${mensagem} (${Math.round((Date.now() - inicio) / 1000)}s)` },
      })
      .catch(() => {});
  void enviar();
  const timer = setInterval(enviar, 5000);
  try {
    return await tarefa;
  } finally {
    clearInterval(timer);
  }
}

// ---------- Respostas dentro do tempo do cliente ----------
//
// O chat comum do Claude Desktop desiste de uma ferramenta depois de 60 s, e uma imagem leva de 30 a 90 s.
// Então cada ferramenta espera no máximo ESPERA_MS: se o trabalho não terminou, ela responde com um id e o
// trabalho continua aqui; a ferramenta aguardar_resultado entrega o resultado depois, sem gerar de novo.

const ESPERA_MS = Number(process.env.CHATGPT_ESPERA_MAX_MS ?? 45_000);
const GUARDA_TAREFAS_MS = 2 * 60 * 60 * 1000;

type Resultado = { content: any[]; isError?: boolean };
type Tarefa = { nome: string; inicio: number; promessa: Promise<Resultado>; resultado?: Resultado };
const tarefas = new Map<string, Tarefa>();

// Cada trabalho que passou do tempo também fica num arquivo. Assim o resultado não se perde se o
// Claude reabrir o servidor, e outra janela do Claude (que roda o seu próprio servidor) consegue buscá-lo.
const PASTA_TAREFAS = join(homedir(), ".mcp-chatgpt", "tarefas");
type TarefaSalva = { nome: string; inicio: number; pid: number; resultado?: Resultado };

const arquivoTarefa = (id: string) => join(PASTA_TAREFAS, `${id.replace(/[^a-z0-9-]/gi, "")}.json`);

async function salvarTarefa(id: string, dados: TarefaSalva) {
  try {
    await mkdir(PASTA_TAREFAS, { recursive: true });
    // Grava num temporário e renomeia: quem lê nunca pega o arquivo pela metade.
    const temp = `${arquivoTarefa(id)}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(dados), "utf8");
    // No Windows o rename falha se outra janela estiver lendo o arquivo naquele instante: tenta de novo.
    for (let tentativa = 1; ; tentativa++) {
      try {
        await rename(temp, arquivoTarefa(id));
        break;
      } catch (e) {
        if (tentativa >= 5) throw e;
        await new Promise((ok) => setTimeout(ok, 200));
      }
    }
  } catch {
    // sem disco: o trabalho continua valendo na memória
  }
}

async function lerTarefaSalva(id: string): Promise<TarefaSalva | undefined> {
  try {
    return JSON.parse(await readFile(arquivoTarefa(id), "utf8"));
  } catch {
    return undefined;
  }
}

function processoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function limparTarefasVelhas() {
  for (const [id, t] of tarefas) if (Date.now() - t.inicio > GUARDA_TAREFAS_MS) tarefas.delete(id);
  const nomes = await readdir(PASTA_TAREFAS).catch(() => [] as string[]);
  for (const nome of nomes) {
    const caminho = join(PASTA_TAREFAS, nome);
    const info = await stat(caminho).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs > GUARDA_TAREFAS_MS) await rm(caminho, { force: true }).catch(() => {});
  }
}

// Busca no disco um trabalho que este servidor não conhece. Espera até "ms" por ele, enquanto o
// servidor que o começou estiver vivo.
async function esperarTarefaSalva(id: string, ms: number): Promise<{ resultado?: Resultado; salva?: TarefaSalva }> {
  const limite = Date.now() + ms;
  for (;;) {
    const salva = await lerTarefaSalva(id);
    if (!salva || salva.resultado || !processoVivo(salva.pid) || Date.now() >= limite) {
      return { resultado: salva?.resultado, salva };
    }
    await new Promise((ok) => setTimeout(ok, 1000));
  }
}

async function esperar(tarefa: Tarefa, ms: number): Promise<Resultado | undefined> {
  if (tarefa.resultado) return tarefa.resultado;
  let timer: NodeJS.Timeout | undefined;
  const limite = new Promise<undefined>((ok) => (timer = setTimeout(() => ok(undefined), ms)));
  try {
    return await Promise.race([tarefa.promessa, limite]);
  } finally {
    clearTimeout(timer);
  }
}

function aindaTrabalhando(id: string, tarefa: Tarefa): Resultado {
  const segundos = Math.round((Date.now() - tarefa.inicio) / 1000);
  return {
    content: [
      {
        type: "text",
        text:
          `Ainda trabalhando (${segundos} s até agora): o ChatGPT continua no computador do usuário.\n` +
          `id: ${id}\n` +
          `Chame a ferramenta aguardar_resultado com esse id para receber o resultado (pode chamar mais de uma vez). ` +
          `NÃO chame ${tarefa.nome} de novo: isso começaria outro trabalho e gastaria mais do limite do ChatGPT.`,
      },
    ],
  };
}

// Junta à resposta o aviso de atualização do servidor, se houver (vai uma vez só).
function comAviso(r: Resultado): Resultado {
  const aviso = tirarAviso();
  return aviso ? { ...r, content: [...r.content, { type: "text", text: `Aviso do ClauGPT MCP: ${aviso}` }] } : r;
}

// Envolve o corpo de uma ferramenta para responder sempre dentro de ESPERA_MS.
function limitar<A>(nome: string, corpo: (args: A, extra: Extra) => Promise<Resultado>) {
  return async (args: A, extra: Extra): Promise<Resultado> => {
    // Depois que esta chamada responder, o aviso de progresso dela não vale mais para o cliente.
    let ativa = true;
    const extraDaChamada: Extra = {
      ...extra,
      sendNotification: (n) => (ativa ? extra.sendNotification(n) : Promise.resolve()),
    };
    const tarefa: Tarefa = { nome, inicio: Date.now(), promessa: Promise.resolve() as unknown as Promise<Resultado> };
    tarefa.promessa = corpo(args, extraDaChamada)
      .catch((e): Resultado => ({ isError: true, content: [{ type: "text", text: (e as Error).message }] }))
      .then((r) => (tarefa.resultado = r));

    const pronto = await esperar(tarefa, ESPERA_MS);
    ativa = false;
    if (pronto) return comAviso(pronto);

    void limparTarefasVelhas();
    const id = randomUUID().slice(0, 8);
    tarefas.set(id, tarefa);
    const salva: TarefaSalva = { nome, inicio: tarefa.inicio, pid: process.pid };
    await salvarTarefa(id, salva);
    void tarefa.promessa.then((resultado) => salvarTarefa(id, { ...salva, resultado }));
    return aindaTrabalhando(id, tarefa);
  };
}

// ---------- Servidor ----------

// O Claude recebe isto ao conectar: é o fluxo de trabalho para peças de design.
const INSTRUCOES = `Este servidor liga você ao ChatGPT/GPT do usuário (pela assinatura dele) e dá ferramentas de design.

Para posts, stories, banners, anúncios, capas, thumbnails e qualquer peça com texto, marca ou logo, você é o diretor de arte e decide o que cada ferramenta faz. O caminho principal é montar a peça no Claude Design, onde o usuário edita textos, cores e posições clicando:

1. Marca: se a peça é de uma marca, chame kit_de_marca primeiro (logo real, cores, fontes, tom, referências). Se a marca não tem kit, crie com salvar_marca a partir do que o usuário disse e mostrou, e peça para ele salvar o logo, as fontes e as referências nas pastas indicadas (imagens coladas no chat comum não chegam como arquivo; na aba Code chegam com caminho e podem ser usadas direto).
2. Decida o que precisa do GPT (gerar_imagem): fotos, cenas, comida, pessoas, produtos em ambiente, objetos e ícones 3D, texturas, ilustrações. Peça essas imagens SEM texto e SEM logo, no formato da peça, deixando espaço livre onde o texto vai entrar. Elementos que vão ser posicionados sobre o layout (produto, objeto, personagem, ícone 3D) peça com fundo_transparente: true. Se já existe uma referência do estilo, passe-a em imagens_referencia com modo_referencia "parecida".
3. Recorte: foto ou imagem do usuário que precisa ficar sobre outro fundo → remover_fundo. Logo com fundo → remover_fundo antes de usar. A prévia de todo recorte mostra o objeto sobre fundo escuro e claro: confira se sobrou fundo, halo ou buraco. Se o recorte avisar que a borda tem cor parecida com a do fundo ou que o objeto encosta na borda, gere a imagem de novo (de preferência pedindo um fundo de cor bem diferente do objeto) em vez de usar um recorte ruim. Para produto ou objeto que deve parecer apoiado no chão, use manter_sombra.
4. Monte a peça no Claude Design: crie uma tela (artefato do tipo Design) com o nome da peça ou da campanha, ou use a tela que já existe para ela, e siga as instruções do próprio tipo Design. Envie para a tela, como arquivos dela, as imagens do GPT, o logo REAL da marca e as fontes da marca (os caminhos vêm de gerar_imagem, remover_fundo e kit_de_marca). Faça uma prancheta por formato, no tamanho exato (post do Instagram 1080×1350, story 1080×1920, quadrado 1080×1080, paisagem 1920×1080), com o texto exato como texto de verdade, a hierarquia e as fontes da marca, as cores da marca e a composição das referências (posição do logo, estilo do título, botões, selos). No story, deixe livres os ~250 px de cima e de baixo, que o Instagram cobre. Nunca peça ao GPT para escrever o texto final nem para desenhar o logo quando existe o arquivo do logo.
5. Entregue o link da tela e diga ao usuário que ele pode clicar nos textos para editar e exportar as artes pela própria tela. Só gere outra imagem no GPT se o problema estiver na própria imagem.

Use renderizar_arte (HTML → PNG no computador) em vez do Claude Design quando: o tipo de artefato Design não estiver disponível nesta conversa; não der para enviar as imagens para a tela (por exemplo, a pasta não está liberada no chat comum); ou o usuário pedir os PNGs salvos no computador, um lote rápido de várias artes, ou a arte sem passar pelo Design. Diga ao usuário em uma frase por que usou esse caminho. Nele: um único HTML no tamanho exato, logo real como <img src="caminho">, olhe a prévia com olho crítico e corrija o HTML (é rápido e não gasta o ChatGPT); para vários formatos, um HTML que se adapta e formatos numa só chamada, ajustando cada um com [data-formato="..."]. No fim, chame entregar_artes com as versões FINAIS e diga onde estão os arquivos e o editável (…-editavel.html). Se refez uma arte, sobrescreva com o mesmo nome_arquivo em vez de criar "-2", "-3". Se o usuário quiser, depois de aprovar no Design, também os PNGs no computador, monte com renderizar_arte a partir do mesmo layout.

Use gerar_imagem sozinho, sem Design nem renderizar_arte, quando a peça é a própria imagem (uma foto, uma ilustração, um ícone, um mockup) ou quando o usuário pedir explicitamente uma arte feita inteira pelo GPT.
Se uma ferramenta responder "Ainda trabalhando" com um id, chame aguardar_resultado com esse id; não repita a ferramenta.
Se algo der errado de um jeito que não se explica (login, Codex, imagem que não aparece, ferramenta que não abre), chame diagnostico e siga o que ele indicar.

Pastas: as artes ficam em ${PASTA_IMAGENS} e os kits de marca em ${PASTA_MARCAS}. Use as ferramentas deste servidor para ler e gravar nelas; não tente copiar ou salvar arquivos nessas pastas com outras ferramentas. No chat comum (modo Cowork), se uma ação for negada por acesso a pasta ("Cowork Folder Access"), não insista nem procure outro caminho: peça ao usuário para liberar a pasta Imagens nessa conversa, pelo botão "+" ao lado da caixa de mensagem → "Adicionar pasta" → escolher a pasta Imagens.`;

const server = new McpServer({ name: "chatgpt", version: VERSAO }, { instructions: INSTRUCOES });

server.registerTool(
  "aguardar_resultado",
  {
    title: "Aguardar resultado do ChatGPT",
    description:
      "Entrega o resultado de um trabalho que outra ferramenta deste servidor (gerar_imagem, remover_fundo, " +
      "perguntar_chatgpt) deixou em andamento, respondendo 'Ainda trabalhando' com um id. Espera alguns segundos " +
      "pelo fim; se ainda não tiver terminado, devolve o mesmo id para chamar de novo. Use isto em vez de repetir " +
      "a ferramenta original, que começaria outro trabalho.",
    inputSchema: {
      id: z.string().min(1).describe("O id informado na resposta 'Ainda trabalhando'"),
    },
  },
  async ({ id }, extra) => {
    const chave = id.trim();
    const tarefa = tarefas.get(chave);
    if (!tarefa) {
      // Trabalho de outro servidor (outra janela do Claude, ou antes de o Claude reabrir este).
      const { resultado, salva } = await comProgresso(extra, "Esperando o trabalho", esperarTarefaSalva(chave, ESPERA_MS));
      if (resultado) {
        await rm(arquivoTarefa(chave), { force: true }).catch(() => {});
        return resultado;
      }
      if (salva && processoVivo(salva.pid)) {
        return aindaTrabalhando(chave, { nome: salva.nome, inicio: salva.inicio, promessa: new Promise(() => {}) });
      }
      const motivo = salva
        ? `O trabalho ${chave} (${salva.nome}) foi interrompido: o Claude fechou o servidor antes de ele terminar. ` +
          `Pode pedir de novo.`
        : `Não achei o trabalho ${chave}. Ele pode ter sido entregue já ou ter passado de 2 horas.`;
      return {
        isError: true,
        content: [{ type: "text", text: `${motivo} Imagens prontas ficam salvas em ${PASTA_IMAGENS}.` }],
      };
    }
    const pronto = await comProgresso(extra, `Esperando ${tarefa.nome}`, esperar(tarefa, ESPERA_MS));
    if (!pronto) return aindaTrabalhando(chave, tarefa);
    tarefas.delete(chave);
    await rm(arquivoTarefa(chave), { force: true }).catch(() => {});
    return pronto;
  },
);

server.registerTool(
  "perguntar_chatgpt",
  {
    title: "Perguntar ao ChatGPT",
    description:
      "Envia uma pergunta ao ChatGPT (modelos da OpenAI, usando a conta do usuário) e devolve a resposta. " +
      "Útil para pedir uma segunda opinião. Aceita imagens (caminhos de arquivos locais) para o ChatGPT analisar. " +
      "Para continuar a mesma conversa, passe o conversa_id da resposta anterior.",
    inputSchema: {
      prompt: z.string().min(1).describe("A mensagem para o ChatGPT"),
      imagens: z
        .array(z.string())
        .optional()
        .describe("Caminhos de imagens no computador (PNG, JPG, GIF ou WEBP) para enviar junto com a mensagem"),
      conversa_id: z.string().optional().describe("Id de uma conversa anterior para continuar o mesmo contexto"),
      modelo: z.string().optional().describe("Modelo da OpenAI a usar (opcional; padrão do Codex se omitido)"),
    },
  },
  limitar("perguntar_chatgpt", async ({ prompt, imagens, conversa_id, modelo }, extra) => {
    try {
      const { texto, conversaId } = await comProgresso(
        extra,
        "Esperando o ChatGPT",
        perguntarAoCodex(prompt, { conversaId: conversa_id, modelo, imagens }),
      );
      const rodape = conversaId ? `\n\n---\nconversa_id: ${conversaId}` : "";
      return { content: [{ type: "text", text: (texto || "(o ChatGPT não retornou texto)") + rodape }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
    }
  }),
);

server.registerTool(
  "gerar_imagem",
  {
    title: "Gerar imagem com o ChatGPT",
    description:
      "Gera ou edita imagens com o gerador de imagens do ChatGPT/GPT (usando a conta do usuário): fotos, cenas, " +
      "comida, pessoas, produtos, mascotes, ícones e objetos 3D, renders, mockups, texturas, ilustrações. Para peças " +
      "com texto, logo ou marca (posts, stories, anúncios), use para gerar só os elementos visuais, sem texto e sem " +
      "logo, e monte a peça no Claude Design (ou com renderizar_arte, quando o Design não estiver disponível). Também refaz ou adapta uma arte a partir de uma referência. " +
      "Imagens que o usuário colou no chat costumam aparecer com um caminho de arquivo (source): passe esse caminho " +
      "em imagens_referencia e escolha modo_referencia conforme o pedido ('quero igual' → igual; 'parecida / no " +
      "mesmo estilo' → parecida; 'muda só X nesta imagem' → editar). Se o usuário pedir 'sem fundo', 'fundo " +
      "transparente', 'PNG recortado' ou um ícone/sticker para usar sobre outras artes, use fundo_transparente: true " +
      "(o servidor garante PNG transparente de verdade). Salva os arquivos no computador com uma ficha .json e " +
      "devolve prévias, caminhos e o prompt final. Para ajustar uma imagem gerada antes, passe o conversa_id dela e " +
      "descreva só a mudança. Cada imagem leva ~30–90 s e conta no limite de uso da assinatura do usuário.",
    inputSchema: {
      descricao: z
        .string()
        .min(1)
        .describe("O que a imagem deve mostrar (ou, com referência 'igual'/'editar', o que mudar). Seja específico."),
      formato: z
        .enum(Object.keys(FORMATOS) as [keyof typeof FORMATOS, ...(keyof typeof FORMATOS)[]])
        .optional()
        .describe(
          "Proporção: quadrado, paisagem (16:9), retrato (2:3), story (9:16) ou post_instagram (4:5). " +
            "Omita com referência igual/parecida para manter a proporção da referência.",
        ),
      uso: z
        .enum(Object.keys(USOS) as [keyof typeof USOS, ...(keyof typeof USOS)[]])
        .optional()
        .describe("Tipo de imagem, para o gerador ajustar o acabamento"),
      estilo: z
        .enum(Object.keys(ESTILOS) as [keyof typeof ESTILOS, ...(keyof typeof ESTILOS)[]])
        .optional()
        .describe(
          "Linguagem visual: 3d, icone_3d, clay (massinha), vidro (glassmorphism), isometrico, realista, flat, " +
            "ilustracao_digital, aquarela, line_art, pixel_art, anime. Omita para seguir a referência.",
        ),
      texto_exato: z.string().optional().describe("Texto que deve aparecer na imagem exatamente assim"),
      evitar: z.array(z.string()).optional().describe("Coisas que não devem aparecer"),
      fundo_transparente: z
        .boolean()
        .optional()
        .describe("PNG com fundo transparente de verdade (sem fundo/recortado). Conferido e corrigido automaticamente."),
      manter_sombra: z
        .boolean()
        .optional()
        .describe("Com fundo_transparente: mantém a sombra do objeto no chão como sombra preta semitransparente (padrão: tira)"),
      variacoes: z
        .number()
        .int()
        .min(1)
        .max(MAX_VARIACOES)
        .optional()
        .describe(`Quantas versões gerar ao mesmo tempo (1 a ${MAX_VARIACOES}; padrão 1)`),
      imagens_referencia: z
        .array(z.string())
        .optional()
        .describe("Caminhos de imagens no computador (inclusive as coladas no chat) para usar como referência ou editar"),
      modo_referencia: z
        .enum(Object.keys(MODOS_REFERENCIA) as [ModoReferencia, ...ModoReferencia[]])
        .optional()
        .describe(
          "Como usar as referências: igual (recriar fielmente, mudando só o pedido), parecida (arte nova no mesmo " +
            "estilo), inspiracao (livre) ou editar (modificar a própria imagem). Padrão: parecida.",
        ),
      conversa_id: z.string().optional().describe("Id de uma geração anterior, para ajustar a mesma imagem"),
      pasta_destino: z.string().optional().describe("Pasta onde salvar (padrão: Imagens\\ChatGPT do usuário)"),
      nome_arquivo: z.string().optional().describe("Nome base do arquivo, sem extensão (padrão: gerado da descrição)"),
    },
  },
  limitar("gerar_imagem", async (args, extra) => {
    // Variações não fazem sentido numa edição encadeada: cada uma viraria um ramo da mesma conversa.
    const total = args.conversa_id ? 1 : args.variacoes ?? 1;
    try {
      const referencias = await validarImagens(args.imagens_referencia ?? []);
      const comIA = Boolean(args.fundo_transparente) && (await recorteDisponivel());
      const modoReferencia: ModoReferencia | undefined = referencias.length ? args.modo_referencia ?? "parecida" : undefined;
      // Sem formato pedido, "igual"/"parecida"/"editar" herdam a proporção da primeira referência.
      let proporcaoReferencia: string | undefined;
      if (referencias.length && !args.formato && modoReferencia !== "inspiracao") {
        const info = await sharp(await readFile(referencias[0])).metadata();
        if (info.width && info.height) proporcaoReferencia = `${info.width}×${info.height}`;
      }
      const destino = resolve(args.pasta_destino ?? PASTA_IMAGENS);
      await mkdir(destino, { recursive: true });
      const original = args.conversa_id && !args.nome_arquivo ? await nomeDaOriginal(destino, args.conversa_id) : undefined;
      // "igual"/"editar" descrevem só a mudança ("troque o texto"), então o nome vem da referência.
      const daReferencia =
        referencias.length && (modoReferencia === "igual" || modoReferencia === "editar")
          ? `${slug(basenameSemExt(referencias[0]))}-${modoReferencia === "editar" ? "editada" : "nova-versao"}`
          : undefined;
      const base = args.nome_arquivo
        ? slug(args.nome_arquivo)
        : original
          ? `${original}-editada`
          : daReferencia ?? slug(args.descricao);

      const tarefas = Array.from({ length: total }, (_, i) =>
        gerarUma(
          {
            descricao: args.descricao,
            formato: args.formato,
            uso: args.uso,
            estilo: args.estilo,
            texto_exato: args.texto_exato,
            evitar: args.evitar,
            fundo_transparente: args.fundo_transparente,
            recorteLocal: comIA,
            referencias,
            modoReferencia,
            proporcaoReferencia,
            edicaoEncadeada: Boolean(args.conversa_id) && referencias.length === 0,
            variacao: { indice: i + 1, total },
          },
          args.conversa_id,
        ),
      );
      const resultados = await comProgresso(
        extra,
        total > 1 ? `Gerando ${total} imagens no ChatGPT` : "Gerando a imagem no ChatGPT",
        Promise.allSettled(tarefas),
      );

      const meta = {
        descricao: args.descricao,
        formato: args.formato,
        uso: args.uso,
        estilo: args.estilo,
        texto_exato: args.texto_exato,
        evitar: args.evitar,
        fundo_transparente: args.fundo_transparente ?? false,
        imagens_referencia: referencias,
        modo_referencia: modoReferencia,
      };
      const imagens: ImagemFinal[] = [];
      const problemas: string[] = [];
      for (const [i, r] of resultados.entries()) {
        const rotulo = total > 1 ? `Variação ${i + 1}: ` : "";
        if (r.status === "rejected") {
          problemas.push(rotulo + (r.reason as Error).message);
          continue;
        }
        const { geracoes, conversaId, texto } = r.value;
        for (const g of geracoes) {
          if (g.falha) {
            const politica = /policy|safety|moderat|content/i.test(g.falha);
            problemas.push(
              rotulo + (politica ? "o pedido foi recusado pela política de conteúdo da OpenAI. " : "o gerador falhou. ") + g.falha,
            );
          } else if (g.arquivo) {
            const nome = total > 1 ? `${base}-v${i + 1}` : base;
            imagens.push(
              await finalizar(g, destino, nome, meta, conversaId, Boolean(args.fundo_transparente), {
                manterSombra: args.manter_sombra,
              }),
            );
          }
        }
        if (geracoes.length === 0 && /^\W*ok\W*$/i.test(texto)) {
          // Ele diz que gerou, mas a imagem não está onde o Codex costuma guardar: sinal de Codex atualizado.
          problemas.push(
            rotulo +
              `o ChatGPT respondeu que gerou a imagem, mas ela não apareceu nas pastas do Codex (${await versaoCodex()}). ` +
              `Uma atualização do Codex pode ter mudado onde ele salva as imagens. Rode a ferramenta diagnostico e ` +
              `diga ao usuário para instalar a versão mais nova do ClauGPT MCP.`,
          );
        } else if (geracoes.length === 0) {
          problemas.push(rotulo + `o ChatGPT não gerou imagem. Resposta dele: ${texto || "(nenhuma)"}`);
        }
      }

      if (imagens.length === 0) {
        return { isError: true, content: [{ type: "text", text: problemas.join("\n") || "Nenhuma imagem gerada." }] };
      }

      const linhas: string[] = [];
      for (const [i, img] of imagens.entries()) {
        if (imagens.length > 1) linhas.push(`### Imagem ${i + 1}`);
        linhas.push(`Arquivo: ${img.caminho}`);
        linhas.push(`Tamanho: ${img.largura}×${img.altura}px` + (img.fundo ? ` · ${descreverFundo(img.fundo)}` : ""));
        if (img.fundo && img.fundo !== "falhou") linhas.push("A prévia mostra o recorte sobre fundo escuro e claro, para conferir as bordas.");
        for (const aviso of img.avisosRecorte ?? []) linhas.push(`Recorte: ${aviso}`);
        if (img.promptFinal) linhas.push(`Prompt final usado: ${img.promptFinal}`);
        if (img.conversaId) linhas.push(`conversa_id (para ajustar esta imagem): ${img.conversaId}`);
        linhas.push("");
      }
      if (problemas.length) linhas.push("Avisos:", ...problemas);

      return {
        content: [
          ...imagens.map((img) => ({ type: "image" as const, data: img.previa.dados, mimeType: img.previa.mime })),
          { type: "text" as const, text: linhas.join("\n").trim() },
        ],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
    }
  }),
);

server.registerTool(
  "remover_fundo",
  {
    title: "Remover fundo de uma imagem",
    description:
      "Deixa uma imagem que já existe sem fundo e salva como PNG transparente. Use quando o usuário mandar uma " +
      "imagem (ou apontar uma gerada antes) e pedir 'tira o fundo', 'deixa sem fundo', 'PNG transparente'. " +
      "O recorte é feito com IA aqui no computador (~3–5 s), mantém os pixels originais e não gasta o limite do " +
      "ChatGPT. Só quando o usuário quer manter apenas uma parte específica (o_que_manter) o ChatGPT isola essa " +
      "parte antes (~30–90 s).",
    inputSchema: {
      imagem: z.string().min(1).describe("Caminho da imagem no computador (inclusive a colada no chat)"),
      o_que_manter: z
        .string()
        .optional()
        .describe("O que deve ficar na imagem, se não for óbvio (ex.: 'só a pessoa da esquerda')"),
      pasta_destino: z.string().optional().describe("Pasta onde salvar (padrão: a mesma da imagem)"),
      manter_sombra: z
        .boolean()
        .optional()
        .describe("Mantém a sombra do objeto no chão como sombra preta semitransparente (padrão: tira). Só em fundo liso."),
    },
  },
  limitar("remover_fundo", async ({ imagem, o_que_manter, pasta_destino, manter_sombra }, extra) => {
    try {
      const [caminho] = await validarImagens([imagem]);
      const destino = resolve(pasta_destino ?? join(caminho, ".."));
      await mkdir(destino, { recursive: true });
      const base = `${slug(basenameSemExt(caminho))}-sem-fundo`;
      const original = await readFile(caminho);

      const comIA = await recorteDisponivel();
      let png: Buffer | undefined;
      let metodo = "";
      let avisos: string[] = [];

      // 1) Recorte com IA local: mantém os pixels originais, sem gastar o limite do ChatGPT.
      if (!o_que_manter && comIA) {
        const r = await comProgresso(extra, "Recortando com IA", recortarComIA(original, { manterSombra: manter_sombra }));
        if ((await bordaTransparente(r.png)) >= 0.6) {
          png = r.png;
          metodo =
            r.modo === "fundo liso"
              ? `recorte com IA aqui no computador, bordas calculadas pela cor do fundo (${r.segundos.toFixed(0)} s)`
              : `recorte com IA aqui no computador (${r.segundos.toFixed(0)} s)`;
          avisos = r.avisos;
        }
      }

      // 1b) Sem o modelo instalado: fundo liso removido localmente.
      if (!png && !o_que_manter && !comIA) {
        if ((await bordaTransparente(original)) >= 0.6) {
          png = await sharp(original).png().toBuffer();
          metodo = "a imagem já tinha fundo transparente";
        } else {
          const local = await removerFundoUniforme(original);
          if (local && (await bordaTransparente(local)) >= 0.6) {
            png = local;
            metodo = "fundo liso removido aqui (sem usar o ChatGPT)";
          }
        }
      }

      // 2) Manter só uma parte (ou sem IA local e com fundo complexo): o ChatGPT isola o que fica,
      //    e o recorte final é conferido (e feito com IA, quando disponível).
      let promptFinal: string | undefined;
      let conversaId: string | undefined;
      if (!png) {
        const r = await comProgresso(
          extra,
          "Isolando no ChatGPT",
          gerarUma(
            {
              descricao:
                "Remova o fundo: deixe só " + (o_que_manter ?? "o objeto/pessoa principal") +
                ", com recorte limpo e preciso (cabelo e bordas finas preservados), sem alterar nada do que fica.",
              referencias: [caminho],
              modoReferencia: "editar",
              fundo_transparente: true,
              recorteLocal: comIA,
              edicaoEncadeada: false,
            },
            undefined,
          ),
        );
        const g = r.geracoes.find((x) => x.arquivo && !x.falha);
        if (!g) {
          const falha = r.geracoes.find((x) => x.falha)?.falha;
          throw new Error(falha ? `O ChatGPT não conseguiu recortar: ${falha}` : `O ChatGPT não gerou imagem. ${r.texto}`);
        }
        const garantido = await garantirTransparencia(await readFile(g.arquivo), { manterSombra: manter_sombra });
        avisos = garantido.avisos ?? [];
        if (garantido.metodo === "falhou") throw new Error("O ChatGPT devolveu a imagem ainda com fundo. Tente de novo.");
        png = garantido.png;
        metodo =
          garantido.metodo === "ia"
            ? "isolado pelo ChatGPT e recortado com IA aqui no computador"
            : garantido.metodo === "gerador"
              ? "recortado pelo ChatGPT (verificado)"
              : "recortado pelo ChatGPT e finalizado aqui";
        promptFinal = g.promptFinal;
        conversaId = r.conversaId;
      }

      const saida = await nomeLivre(destino, base, ".png");
      await writeFile(saida, png);
      const info = await sharp(png).metadata();
      const linhas = [
        `Arquivo: ${saida}`,
        `Tamanho: ${info.width}×${info.height}px · ${metodo}`,
        "A prévia mostra o recorte sobre fundo escuro e claro, para conferir as bordas.",
        ...avisos.map((a) => `Recorte: ${a}`),
      ];
      if (promptFinal) linhas.push(`Prompt final usado: ${promptFinal}`);
      if (conversaId) linhas.push(`conversa_id (para ajustar esta imagem): ${conversaId}`);
      const previa = await provaDoRecorte(png);
      return {
        content: [
          { type: "image" as const, data: previa.dados, mimeType: previa.mime },
          { type: "text" as const, text: linhas.join("\n") },
        ],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
    }
  }),
);

// ---------- Design: o Claude monta, o GPT só gera o que precisa ----------

const FORMATOS_ARTE: Record<string, [number, number]> = {
  story: [1080, 1920],
  post_instagram: [1080, 1350],
  quadrado: [1080, 1080],
  paisagem: [1920, 1080],
  retrato: [1080, 1620],
};

// Miniatura leve (WEBP preserva transparência) para o Claude ver logos e referências.
async function miniatura(caminho: string, lado = 512): Promise<{ type: "image"; data: string; mimeType: string } | undefined> {
  try {
    const dados = await sharp(await readFile(caminho)).resize(lado, lado, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    return { type: "image", data: dados.toString("base64"), mimeType: "image/webp" };
  } catch {
    return undefined;
  }
}

// Renderiza uma arte e salva ao lado: o PNG, o HTML-fonte (para o Claude ajustar depois) e uma versão
// editável que o usuário abre no navegador, edita os textos clicando e baixa o PNG, sem precisar do Claude.
async function salvarArte(
  html: string,
  largura: number,
  altura: number,
  escala: number,
  formato: string | undefined,
  caminho: string,
): Promise<{ previa: { dados: string; mime: string }; linhas: string[] }> {
  const r = await renderizarHtml(html, largura, altura, escala, formato);
  await writeFile(caminho, r.png);
  const base = caminho.slice(0, -4);
  await writeFile(base + ".html", html, "utf8");
  const nomeBase = base.split(/[\\/]/).pop() ?? "arte";
  await writeFile(base + "-editavel.html", await montarEditavel(html, largura, altura, nomeBase, formato), "utf8");
  const info = await sharp(r.png).metadata();
  const previa = await gerarPrevia(r.png, Boolean(info.hasAlpha));
  const linhas = [
    `Arquivo: ${caminho}`,
    `Tamanho: ${info.width}×${info.height}px${formato ? ` (${formato})` : ""} · montada em ${r.segundos.toFixed(1)} s`,
    `Editável: ${base}-editavel.html (o usuário abre no navegador, clica nos textos para editar e aperta "Baixar PNG"; funciona sozinho, com as imagens embutidas)`,
    `HTML-fonte: ${base}.html`,
  ];
  if (r.avisos.length) linhas.push("Atenção (corrija e renderize de novo):", ...r.avisos.map((a) => `- ${a}`));
  return { previa, linhas };
}

const NOMES_FORMATOS_ARTE = Object.keys(FORMATOS_ARTE) as [string, ...string[]];

server.registerTool(
  "renderizar_arte",
  {
    title: "Montar arte (HTML → PNG)",
    description:
      "Transforma um layout em HTML/CSS numa imagem PNG no tamanho exato, salva no computador e devolve a prévia. " +
      "Caminho alternativo ao Claude Design (que é o principal): use quando o tipo Design não estiver disponível, " +
      "quando não der para enviar as imagens para a tela, ou quando o usuário pedir os PNGs no computador. Monta " +
      "posts, stories, banners e anúncios com controle total: texto exato, fontes e " +
      "cores da marca, logo real (<img src=\"C:\\...\\logo.png\">) e imagens geradas pelo GPT como <img> ou " +
      "background. Caminhos do Windows em src/href/url() funcionam direto. Google Fonts via <link> funcionam. " +
      "Rápido (poucos segundos) e não gasta o limite do ChatGPT: ajuste o HTML e renderize de novo quantas vezes " +
      "precisar. Mande só o conteúdo do <body> (com <style>) ou um documento completo; a página já tem o tamanho da arte.\n" +
      "Vários formatos de uma vez: passe formatos (ex.: [\"post_instagram\", \"story\", \"quadrado\"]) e um único HTML " +
      "que se adapta. O <html> recebe data-formato=\"story\" etc. e as variáveis CSS --largura/--altura; use regras como " +
      "[data-formato=\"story\"] .titulo { ... } para reposicionar elementos em cada formato (no story, deixe livres os " +
      "~250 px de cima e de baixo, que o Instagram cobre). Confira cada prévia: o que funciona no quadrado pode " +
      "apertar no story.",
    inputSchema: {
      html: z.string().min(1).describe("Layout da arte em HTML/CSS. Use px; a página tem exatamente largura × altura."),
      formato: z
        .enum(NOMES_FORMATOS_ARTE)
        .optional()
        .describe("story 1080×1920, post_instagram 1080×1350, quadrado 1080×1080, paisagem 1920×1080, retrato 1080×1620"),
      formatos: z
        .array(z.enum(NOMES_FORMATOS_ARTE))
        .min(1)
        .max(5)
        .optional()
        .describe("Vários formatos com o mesmo HTML (substitui formato, largura e altura). Salva <nome>-<formato>.png de cada um."),
      largura: z.number().int().min(16).max(8000).optional().describe("Largura em px (substitui o formato)"),
      altura: z.number().int().min(16).max(8000).optional().describe("Altura em px (substitui o formato)"),
      escala: z.number().min(1).max(3).optional().describe("Multiplicador de resolução do PNG (padrão 1; 2 = o dobro de pixels)"),
      nome_arquivo: z
        .string()
        .optional()
        .describe("Nome base do arquivo, sem extensão. Renderizar de novo com o mesmo nome SUBSTITUI a arte anterior."),
      pasta_destino: z.string().optional().describe("Pasta onde salvar (padrão: Imagens\\ChatGPT)"),
    },
  },
  limitar("renderizar_arte", async (args, extra) => {
    try {
      const destino = resolve(args.pasta_destino ?? PASTA_IMAGENS);
      await mkdir(destino, { recursive: true });
      const varios = Boolean(args.formatos);
      const pedidos: { formato?: string; largura: number; altura: number }[] = args.formatos
        ? [...new Set(args.formatos)].map((f) => ({ formato: f, largura: FORMATOS_ARTE[f][0], altura: FORMATOS_ARTE[f][1] }))
        : [
            {
              formato: args.formato,
              largura: args.largura ?? FORMATOS_ARTE[args.formato ?? "quadrado"][0],
              altura: args.altura ?? FORMATOS_ARTE[args.formato ?? "quadrado"][1],
            },
          ];

      const conteudo: Resultado["content"] = [];
      for (const p of pedidos) {
        const sufixo = p.formato ?? `${p.largura}x${p.altura}`;
        // Com nome_arquivo, refazer a arte substitui o arquivo (sem "-2", "-3" sobrando na pasta).
        const caminho = args.nome_arquivo
          ? join(destino, `${slug(args.nome_arquivo)}${varios ? `-${sufixo}` : ""}.png`)
          : await nomeLivre(destino, slug(`arte-${sufixo}`), ".png");
        const { previa, linhas } = await comProgresso(
          extra,
          varios ? `Montando ${p.formato}` : "Montando a arte",
          salvarArte(args.html, p.largura, p.altura, args.escala ?? 1, p.formato, caminho),
        );
        conteudo.push(
          { type: "image" as const, data: previa.dados, mimeType: previa.mime },
          { type: "text" as const, text: linhas.join("\n") },
        );
      }
      return { content: conteudo };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
    }
  }),
);

server.registerTool(
  "kit_de_marca",
  {
    title: "Kit de marca",
    description:
      "Lê o kit de uma marca salvo no computador: logo real (caminhos para enviar ao Claude Design, usar no HTML ou mandar ao GPT), cores, " +
      "fontes (com @font-face pronto), tom de voz e artes de referência (com miniaturas para você ver). Chame antes de " +
      "criar qualquer peça de uma marca. Sem o nome, lista as marcas salvas.",
    inputSchema: {
      marca: z.string().optional().describe("Nome da marca (ex.: Ninno). Omita para listar as marcas salvas."),
    },
  },
  async ({ marca }) => {
    try {
      const marcas = await listarMarcas();
      if (!marca) {
        const texto = marcas.length
          ? `Marcas salvas em ${PASTA_MARCAS}:\n${marcas.map((m) => `- ${m}`).join("\n")}`
          : `Nenhuma marca salva ainda em ${PASTA_MARCAS}. Use salvar_marca para criar uma.`;
        return { content: [{ type: "text", text: texto }] };
      }
      const nome = await acharMarca(marca);
      if (!nome) {
        return {
          content: [
            {
              type: "text",
              text:
                `A marca "${marca}" ainda não tem kit em ${PASTA_MARCAS}. ` +
                (marcas.length ? `Marcas salvas: ${marcas.join(", ")}. ` : "") +
                `Crie com salvar_marca (cores, fontes, tom) e peça ao usuário para colocar o logo, as fontes e ` +
                `artes de referência nas pastas que ela indicar.`,
            },
          ],
        };
      }
      const kit = await lerKit(nome);
      const f = kit.ficha;
      const linhas = [`# Kit da marca ${nome}`, `Pasta: ${kit.pasta}`, ""];
      linhas.push("## Cores");
      linhas.push(f.cores && Object.keys(f.cores).length ? Object.entries(f.cores).map(([k, v]) => `- ${k}: ${v}`).join("\n") : "- (não definidas)");
      linhas.push("", "## Fontes");
      if (f.fontes && Object.keys(f.fontes).length) linhas.push(Object.entries(f.fontes).map(([k, v]) => `- ${k}: ${v}`).join("\n"));
      if (kit.fontes.length) linhas.push("Arquivos de fonte (cole este CSS no <style> da arte):", "```css", cssDasFontes(kit.fontes), "```");
      if (!kit.fontes.length && !(f.fontes && Object.keys(f.fontes).length)) linhas.push("- (nenhuma; use uma do Google Fonts parecida com a das referências)");
      if (f.tom) linhas.push("", "## Tom de voz", f.tom);
      if (f.notas) linhas.push("", "## Observações", f.notas);
      linhas.push("", "## Logos");
      linhas.push(
        kit.logos.length
          ? kit.logos.map((l) => `- ${l.caminho} (${l.largura ?? "?"}×${l.altura ?? "?"}px${l.transparente ? ", sem fundo" : ", COM fundo: use remover_fundo se for sobrepor"})`).join("\n")
          : `- Nenhum arquivo. Peça ao usuário para salvar o logo em ${join(kit.pasta, "logos")} (PNG sem fundo ou SVG).`,
      );
      linhas.push("", "## Referências");
      linhas.push(kit.referencias.length ? kit.referencias.map((r) => `- ${r}`).join("\n") : `- Nenhuma. Artes de exemplo vão em ${join(kit.pasta, "referencias")}.`);
      linhas.push("", "Miniaturas abaixo: primeiro os logos, depois as referências (até 4 de cada).");

      const imagens = [];
      for (const c of [...kit.logos.map((l) => l.caminho).slice(0, 4), ...kit.referencias.slice(0, 4)]) {
        const m = await miniatura(c);
        if (m) imagens.push(m);
      }
      return { content: [{ type: "text" as const, text: linhas.join("\n") }, ...imagens] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
    }
  },
);

server.registerTool(
  "salvar_marca",
  {
    title: "Salvar kit de marca",
    description:
      "Cria ou atualiza o kit de uma marca: cores, fontes, tom de voz e observações, e as pastas onde o usuário " +
      "coloca logo, fontes e referências. Use quando o usuário apresentar uma marca nova ou corrigir algo dela " +
      "(campos omitidos ficam como estavam). Imagens coladas no chat não viram arquivo: depois de salvar, diga ao " +
      "usuário em que pasta colocar o logo e as referências.",
    inputSchema: {
      marca: z.string().min(1).describe("Nome da marca"),
      cores: z.record(z.string()).optional().describe('Cores por papel, em hex. Ex.: {"principal": "#1D432F", "creme": "#F7F1E1"}'),
      fontes: z.record(z.string()).optional().describe('Fontes por papel. Ex.: {"titulo": "Archivo Black", "texto": "Inter"}'),
      tom: z.string().optional().describe("Tom de voz e estilo de texto da marca"),
      notas: z.string().optional().describe("Regras visuais: uso do logo, elementos recorrentes, o que evitar etc."),
    },
  },
  async ({ marca, cores, fontes, tom, notas }) => {
    try {
      const pasta = await salvarMarca({ nome: marca, cores, fontes, tom, notas });
      return {
        content: [
          {
            type: "text",
            text:
              `Kit salvo em ${pasta}\n` +
              `Peça ao usuário para colocar os arquivos nas pastas:\n` +
              `- Logo (PNG sem fundo ou SVG): ${join(pasta, "logos")}\n` +
              `- Fontes da marca (.ttf/.otf): ${join(pasta, "fontes")}\n` +
              `- Artes de referência: ${join(pasta, "referencias")}\n` +
              `Depois, chame kit_de_marca para ler tudo.`,
          },
        ],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
    }
  },
);

server.registerTool(
  "entregar_artes",
  {
    title: "Entregar artes na conversa",
    description:
      "Mostra as artes FINAIS na conversa em tamanho real, para o usuário ver e baixar, cada uma com o link do " +
      "arquivo no computador e do editável. Chame no fim do trabalho, só com as versões finais (não as que foram " +
      "corrigidas depois). Até 10 por chamada; se houver mais, chame de novo com as próximas.",
    inputSchema: {
      arquivos: z.array(z.string().min(1)).min(1).max(10).describe("Caminhos das artes finais (PNG/JPG), na ordem de publicação"),
      titulos: z.array(z.string()).optional().describe("Um título por arte, na mesma ordem (ex.: 'Post 1 · slide 1')"),
    },
  },
  async ({ arquivos, titulos }) => {
    try {
      const caminhos = await validarImagens(arquivos);
      const conteudo: any[] = [];
      for (const [i, caminho] of caminhos.entries()) {
        const bytes = await readFile(caminho);
        const info = await sharp(bytes).metadata();
        // Tamanho real. Com transparência vai PNG; sem, JPEG de alta qualidade, bem mais leve.
        const temAlfa = Boolean(info.hasAlpha) && (await bordaTransparente(bytes)) > 0;
        const imagem = temAlfa
          ? { data: (await sharp(bytes).png().toBuffer()).toString("base64"), mimeType: "image/png" }
          : { data: (await sharp(bytes).flatten({ background: "#ffffff" }).jpeg({ quality: 92, mozjpeg: true }).toBuffer()).toString("base64"), mimeType: "image/jpeg" };
        const nome = caminho.split(/[\\/]/).pop() ?? "arte";
        const editavel = caminho.replace(/\.[^.]+$/, "-editavel.html");
        const temEditavel = await access(editavel).then(() => true, () => false);
        conteudo.push(
          { type: "text", text: `${titulos?.[i] ?? nome} — ${info.width}×${info.height}px` },
          { type: "image", ...imagem },
          { type: "resource_link", uri: pathToFileURL(caminho).href, name: nome, mimeType: info.format === "png" ? "image/png" : "image/jpeg" },
        );
        if (temEditavel) {
          conteudo.push({ type: "resource_link", uri: pathToFileURL(editavel).href, name: nome.replace(/\.[^.]+$/, "-editavel.html"), mimeType: "text/html" });
        }
      }
      conteudo.push({
        type: "text",
        text:
          "Arquivos no computador:\n" +
          caminhos.map((c) => `- ${c}`).join("\n") +
          "\nPara mudar um texto sem o Claude: abra o …-editavel.html no navegador, clique no texto e aperte \"Baixar PNG\".",
      });
      return { content: conteudo };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
    }
  },
);

server.registerTool(
  "ver_imagem",
  {
    title: "Ver imagem do computador",
    description:
      "Mostra uma imagem que está salva no computador (prévia + tamanho em pixels). Use para olhar referências, " +
      "logos ou resultados antes de decidir o que fazer com eles.",
    inputSchema: {
      caminho: z.string().min(1).describe("Caminho da imagem"),
    },
  },
  async ({ caminho }) => {
    try {
      const [arquivo] = await validarImagens([caminho]);
      const bytes = await readFile(arquivo);
      const info = await sharp(bytes).metadata();
      const transparente = Boolean(info.hasAlpha) && (await bordaTransparente(bytes)) >= 0.6;
      const previa = await gerarPrevia(bytes, Boolean(info.hasAlpha));
      return {
        content: [
          { type: "image" as const, data: previa.dados, mimeType: previa.mime },
          {
            type: "text" as const,
            text: `${arquivo}\n${info.width}×${info.height}px · ${info.format}${transparente ? " · fundo transparente" : ""}`,
          },
        ],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
    }
  },
);

server.registerTool(
  "diagnostico",
  {
    title: "Diagnóstico do ClauGPT MCP",
    description:
      "Confere se tudo que o ClauGPT MCP usa está funcionando neste computador: versão, Codex CLI, login na conta do " +
      "ChatGPT, modelo de recorte, navegador para montar artes e pastas. Use quando uma ferramenta falhar sem motivo " +
      "claro, ou quando o usuário perguntar se está tudo certo. Não gasta o limite do ChatGPT.",
    inputSchema: {},
  },
  async () => {
    const itens: string[] = [];
    const item = (ok: boolean, texto: string) => itens.push(`${ok ? "OK " : "ERRO"}  ${texto}`);

    item(true, `ClauGPT MCP ${VERSAO} · Node ${process.version} · ${process.platform}`);
    const versao = await rodarCodex(["--version"]);
    item(versao.ok, versao.ok ? `Codex CLI: ${versao.saida.split(/\r?\n/).pop()} (${CODEX_BIN})` : `Codex CLI não roda (${CODEX_BIN}): ${versao.saida.replace(/\s+/g, " ").slice(0, 200)}. Rode o instalador de novo.`);
    if (versao.ok) {
      const login = await rodarCodex(["login", "status"]);
      item(login.ok, login.ok ? `Login no ChatGPT: ${login.saida.split(/\r?\n/)[0] || "ativo"}` : "Sem login no ChatGPT. Rode o instalador de novo (ele faz o login) ou, no terminal: codex login --device-auth");
    }
    const recorte = await recorteDisponivel();
    item(recorte, recorte ? `Modelo de recorte: ${MODELO_RECORTE}` : `Modelo de recorte ausente (${MODELO_RECORTE}): o recorte funciona, mas com qualidade inferior. Rode o instalador de novo para baixar.`);
    try {
      item(true, `Navegador para montar artes: ${acharNavegador()}`);
    } catch (e) {
      item(false, (e as Error).message);
    }
    for (const [rotulo, pasta] of [["Pasta das artes", PASTA_IMAGENS], ["Pasta das marcas", PASTA_MARCAS]] as const) {
      try {
        await mkdir(pasta, { recursive: true });
        const teste = join(pasta, `.teste-${process.pid}`);
        await writeFile(teste, "");
        await rm(teste, { force: true });
        item(true, `${rotulo}: ${pasta}`);
      } catch (e) {
        item(false, `${rotulo} sem permissão de escrita (${pasta}): ${(e as Error).message}`);
      }
    }
    const geradas = await readdir(join(CODEX_HOME, "generated_images")).catch(() => undefined);
    itens.push(`      Imagens do Codex: ${join(CODEX_HOME, "generated_images")}${geradas ? ` (${geradas.length} conversas)` : " (ainda vazia)"}`);
    const at = estadoAtualizacao();
    const atOk = at.situacao !== "erro";
    item(
      atOk,
      `Atualização automática: ${at.situacao}` +
        (at.ultima ? ` (última publicada: ${at.ultima})` : "") +
        (at.detalhe ? ` · ${at.detalhe}` : "") +
        (at.linkInstalador ? ` · instalador: ${at.linkInstalador}` : ""),
    );
    const andamento = [...tarefas.entries()].filter(([, t]) => !t.resultado);
    if (andamento.length) itens.push(`      Trabalhos em andamento: ${andamento.map(([id, t]) => `${id} (${t.nome})`).join(", ")}`);

    const erros = itens.filter((i) => i.startsWith("ERRO")).length;
    itens.push("", erros ? `${erros} problema(s). Explique ao usuário o que fazer em cada um.` : "Tudo certo.");
    return { content: [{ type: "text", text: itens.join("\n") }] };
  },
);

server.registerTool(
  "atualizar_mcp",
  {
    title: "Atualizar o ClauGPT MCP",
    description:
      "Confere agora no GitHub se saiu versão nova do ClauGPT MCP e, se só o código mudou, instala sozinha " +
      "(vale depois de reiniciar o Claude). Se a versão nova precisar do instalador, devolve o link. O servidor já " +
      "confere sozinho a cada 12 horas; use quando o usuário pedir para atualizar ou perguntar a versão.",
    inputSchema: {},
  },
  async () => {
    const r = await verificarAtualizacao(VERSAO);
    tirarAviso(); // a resposta abaixo já diz tudo
    const linhas = [`Versão instalada: ${VERSAO}`, `Situação: ${r.situacao}${r.detalhe ? ` (${r.detalhe})` : ""}`];
    if (r.ultima) linhas.push(`Última versão publicada: ${r.ultima}`);
    if (r.situacao === "instalada") linhas.push("Diga ao usuário para reiniciar o Claude (ícone perto do relógio → Sair, e abrir de novo) para usar a versão nova.");
    if (r.situacao === "precisa do instalador") linhas.push(`Instalador da versão nova: ${r.linkInstalador}`);
    return { isError: r.situacao === "erro", content: [{ type: "text", text: linhas.join("\n") }] };
  },
);

function basenameSemExt(caminho: string): string {
  const nome = caminho.split(/[\\/]/).pop() ?? "imagem";
  return nome.slice(0, nome.length - extname(nome).length);
}

await server.connect(new StdioServerTransport());
agendarAtualizacoes(VERSAO);
