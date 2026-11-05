// Monta artes a partir de HTML/CSS: o Claude faz o layout (texto exato, fontes, logo real, cores da marca)
// e um navegador sem janela (Chrome ou Edge já instalados no PC) tira a "foto" no tamanho exato.

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer, { type Browser } from "puppeteer-core";

function acharNavegador(): string {
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA ?? "";
  const candidatos = [
    process.env.CHATGPT_NAVEGADOR,
    join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    join(local, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  ].filter((c): c is string => Boolean(c));
  const achado = candidatos.find((c) => existsSync(c));
  if (!achado) {
    throw new Error(
      "Não achei Chrome nem Edge neste PC para montar a arte. Instale o Google Chrome ou o Microsoft Edge " +
        "(ou aponte a variável CHATGPT_NAVEGADOR para o executável de um deles).",
    );
  }
  return achado;
}

let navegador: Promise<Browser> | undefined;

function abrirNavegador(): Promise<Browser> {
  // Fica aberto entre uma arte e outra: abrir o navegador leva alguns segundos.
  navegador ??= puppeteer
    .launch({
      executablePath: acharNavegador(),
      headless: true,
      args: ["--allow-file-access-from-files", "--font-render-hinting=none", "--hide-scrollbars"],
    })
    .then((b) => {
      b.on("disconnected", () => (navegador = undefined));
      return b;
    })
    .catch((e) => {
      navegador = undefined;
      throw e;
    });
  return navegador;
}

// Caminhos do Windows dentro do HTML (src="C:\...", url('C:\...')) viram file:///, para o Claude poder
// usar direto os caminhos que as outras ferramentas devolvem.
function converterCaminhos(html: string): string {
  const paraUrl = (caminho: string) => pathToFileURL(caminho.replace(/\//g, "\\")).href;
  return html
    .replace(/(\b(?:src|href)\s*=\s*)(["'])([A-Za-z]:[\\/][^"']*)\2/g, (_m, attr, q, caminho) => `${attr}${q}${paraUrl(caminho)}${q}`)
    .replace(/url\(\s*(["']?)([A-Za-z]:[\\/][^"')]*)\1\s*\)/g, (_m, q, caminho) => `url(${q}${paraUrl(caminho)}${q})`);
}

function documentoCompleto(html: string, largura: number, altura: number): string {
  // Base mínima: a página tem exatamente o tamanho da arte e nada vaza para fora.
  const base =
    `<style>html,body{margin:0;padding:0;width:${largura}px;height:${altura}px;overflow:hidden}` +
    `*{box-sizing:border-box}</style>`;
  if (/<html[\s>]/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + base);
  return `<!doctype html><html><head><meta charset="utf-8">${base}</head><body>${html}</body></html>`;
}

// ---------- Arquivo editável ----------
// Um .html que funciona sozinho (imagens embutidas): abre no navegador, clica no texto, edita e baixa o PNG.

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
};

async function embutirArquivos(html: string): Promise<string> {
  const padrao = /(["'(])((?:file:\/\/\/)?[A-Za-z]:[\\/][^"')]*?\.(png|jpe?g|webp|gif|svg|ttf|otf|woff2?))(?=["')])/gi;
  const caminhos = new Set<string>();
  for (const m of html.matchAll(padrao)) caminhos.add(m[2]);
  const dados = new Map<string, string>();
  for (const bruto of caminhos) {
    const caminho = bruto.startsWith("file:") ? decodeURIComponent(new URL(bruto).pathname.slice(1)) : bruto;
    try {
      const ext = extname(caminho).toLowerCase();
      dados.set(bruto, `data:${MIME[ext] ?? "application/octet-stream"};base64,${(await readFile(caminho)).toString("base64")}`);
    } catch {
      // arquivo sumiu: fica o caminho, e o navegador mostra a imagem quebrada
    }
  }
  return html.replace(padrao, (m, abre, bruto) => (dados.has(bruto) ? abre + dados.get(bruto) : m));
}

const EDITOR = `
<div id="barra-edicao" style="position:fixed;top:12px;right:12px;z-index:2147483647;display:flex;gap:8px;align-items:center;font:600 14px/1.2 system-ui,sans-serif;background:#141a2b;color:#fff;padding:10px 12px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);zoom:var(--desfaz-zoom,1)">
  <span style="opacity:.75;font-weight:500">Clique num texto para editar</span>
  <button id="baixar-png" type="button" style="font:inherit;background:#7d97ff;color:#0e1220;border:0;border-radius:8px;padding:8px 12px;cursor:pointer">Baixar PNG</button>
</div>
<style>
  [data-editavel]{outline:2px dashed transparent;outline-offset:4px;cursor:text}
  [data-editavel]:hover{outline-color:rgba(125,151,255,.7)}
  [data-editavel]:focus{outline-color:#7d97ff}
  /* A página em volta centraliza a arte; a arte (body) fica sem margem, para o PNG sair sem bordas. */
  html{background:#2a2f3d;display:flex;justify-content:center;padding-block:12px}
  body{flex:none;box-shadow:0 10px 40px rgba(0,0,0,.45)}
</style>
<script src="https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js"></script>
<script>
(() => {
  const L = __LARGURA__, A = __ALTURA__, NOME = __NOME__;
  const barra = document.getElementById("barra-edicao");
  // Torna editável todo elemento que tem texto próprio.
  for (const el of document.body.querySelectorAll("*")) {
    if (barra.contains(el) || ["SCRIPT", "STYLE", "SVG", "PATH"].includes(el.tagName.toUpperCase())) continue;
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
      el.contentEditable = "true";
      el.spellcheck = false;
      el.setAttribute("data-editavel", "");
    }
  }
  // Cabe na janela para editar; o PNG sai no tamanho real.
  const ajustar = () => {
    const z = Math.min(1, (innerWidth - 24) / L, (innerHeight - 24) / A);
    document.body.style.zoom = z;
    document.documentElement.style.setProperty("--desfaz-zoom", String(1 / z));
  };
  addEventListener("resize", ajustar);
  ajustar();
  document.getElementById("baixar-png").addEventListener("click", async (ev) => {
    const b = ev.currentTarget;
    b.textContent = "Gerando…";
    document.activeElement && document.activeElement.blur();
    try {
      const url = await htmlToImage.toPng(document.body, {
        width: L, height: A, pixelRatio: 1, cacheBust: true,
        // Sem o zoom, a margem e a sombra que só servem para mostrar a arte na tela de edição.
        style: { zoom: "1", boxShadow: "none" },
        filter: (n) => n.id !== "barra-edicao",
      });
      const a = document.createElement("a");
      a.href = url;
      a.download = NOME + ".png";
      a.click();
      b.textContent = "Baixar PNG";
    } catch (e) {
      b.textContent = "Erro ao gerar — tente de novo";
      console.error(e);
    }
  });
})();
</script>`;

// Troca cada <link> do Google Fonts por um <style> com as fontes embutidas. Sem isso, o "Baixar PNG" do
// arquivo editável sai com fonte reserva: o navegador não deixa ler fontes de outro site a partir de um
// arquivo local. De quebra, o editável passa a funcionar sem internet.
async function embutirFontesGoogle(html: string): Promise<string> {
  const links = [...html.matchAll(/<link\b[^>]*href=["'](https:\/\/fonts\.googleapis\.com\/[^"']+)["'][^>]*>/gi)];
  for (const [tag, hrefBruto] of links) {
    const href = hrefBruto.replace(/&amp;/g, "&");
    try {
      // User-Agent de navegador atual: o Google então responde com woff2.
      const css = await (await fetch(href, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" } })).text();
      const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]))];
      let embutido = css;
      for (const u of urls) {
        const b64 = Buffer.from(await (await fetch(u)).arrayBuffer()).toString("base64");
        embutido = embutido.split(u).join(`data:font/woff2;base64,${b64}`);
      }
      html = html.replace(tag, `<style>${embutido}</style>`);
    } catch {
      // sem internet: mantém o <link>; o PNG baixado pode sair com fonte reserva
    }
  }
  return html;
}

export async function montarEditavel(html: string, largura: number, altura: number, nome: string): Promise<string> {
  const doc = documentoCompleto(await embutirFontesGoogle(await embutirArquivos(html)), largura, altura);
  const editor = EDITOR.replace("__LARGURA__", String(largura))
    .replace("__ALTURA__", String(altura))
    .replace("__NOME__", JSON.stringify(nome));
  return doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, editor + "</body>") || doc + editor;
}

export type Renderizacao = { png: Buffer; avisos: string[]; segundos: number };

export async function renderizarHtml(html: string, largura: number, altura: number, escala = 1): Promise<Renderizacao> {
  const inicio = Date.now();
  const pasta = await mkdtemp(join(tmpdir(), "mcp-arte-"));
  const arquivo = join(pasta, "arte.html");
  await writeFile(arquivo, documentoCompleto(converterCaminhos(html), largura, altura), "utf8");

  const avisos: string[] = [];
  const browser = await abrirNavegador();
  const pagina = await browser.newPage();
  try {
    pagina.on("requestfailed", (r) => avisos.push(`Não carregou: ${decodeURI(r.url()).slice(0, 200)}`));
    pagina.on("pageerror", (e) => avisos.push(`Erro no script da arte: ${(e as Error).message}`));
    await pagina.setViewport({ width: largura, height: altura, deviceScaleFactor: escala });
    await pagina.goto(pathToFileURL(arquivo).href, { waitUntil: "networkidle0", timeout: 30_000 });
    // Espera fontes e imagens de verdade, para não sair com fonte reserva ou imagem faltando.
    await pagina.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images).map((img) =>
          img.complete
            ? undefined
            : new Promise((ok) => {
                img.addEventListener("load", ok, { once: true });
                img.addEventListener("error", ok, { once: true });
              }),
        ),
      );
    });
    const quebradas = await pagina.evaluate(() =>
      Array.from(document.images)
        .filter((i) => i.complete && i.naturalWidth === 0)
        .map((i) => decodeURI(i.src)),
    );
    for (const q of quebradas) avisos.push(`Imagem não encontrada: ${q}`);
    const fontes = await pagina.evaluate(() =>
      Array.from(document.fonts)
        .filter((f) => f.status === "error")
        .map((f) => f.family),
    );
    for (const f of fontes) avisos.push(`Fonte não carregou (saiu com a reserva): ${f}`);

    const png = Buffer.from(await pagina.screenshot({ type: "png", clip: { x: 0, y: 0, width: largura, height: altura }, omitBackground: true }));
    return { png, avisos: [...new Set(avisos)], segundos: (Date.now() - inicio) / 1000 };
  } finally {
    await pagina.close().catch(() => {});
    await rm(pasta, { recursive: true, force: true }).catch(() => {});
  }
}
