// Kit de marca: uma pasta por marca com logo, fontes, referências e um marca.json (cores, fontes, tom).
// É daqui que o Claude pega os arquivos reais, porque uma imagem colada no chat comum não vira arquivo.
//
//   Imagens\Marcas\<Marca>\
//     marca.json      cores, fontes, tom de voz, observações
//     logos\          logo em PNG (de preferência sem fundo) ou SVG
//     fontes\         arquivos .ttf/.otf/.woff2 da marca
//     referencias\    artes que mostram o estilo da marca

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import sharp from "sharp";
import { pastaDeImagens } from "./sistema.js";

export const PASTA_MARCAS = process.env.CHATGPT_MARCAS_DIR ?? join(pastaDeImagens(), "Marcas");

const SUBPASTAS = ["logos", "fontes", "referencias"] as const;
const EXT_IMAGEM = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const EXT_FONTE = new Set([".ttf", ".otf", ".woff", ".woff2"]);

export type FichaMarca = {
  nome: string;
  cores?: Record<string, string>;
  fontes?: Record<string, string>;
  tom?: string;
  notas?: string;
};

async function listar(pasta: string, extensoes: Set<string>): Promise<string[]> {
  const nomes = await readdir(pasta).catch(() => [] as string[]);
  return nomes.filter((n) => extensoes.has(extname(n).toLowerCase())).sort().map((n) => join(pasta, n));
}

async function lerFicha(pasta: string, nome: string): Promise<FichaMarca> {
  try {
    return { nome, ...JSON.parse(await readFile(join(pasta, "marca.json"), "utf8")) };
  } catch {
    return { nome };
  }
}

export async function listarMarcas(): Promise<string[]> {
  const itens = await readdir(PASTA_MARCAS, { withFileTypes: true }).catch(() => []);
  return itens.filter((i) => i.isDirectory()).map((i) => i.name).sort();
}

// Acha a pasta da marca sem diferenciar maiúsculas e acentos ("ninno" acha "Ninno").
export async function acharMarca(nome: string): Promise<string | undefined> {
  const chave = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  return (await listarMarcas()).find((m) => chave(m) === chave(nome));
}

export type KitMarca = {
  pasta: string;
  ficha: FichaMarca;
  logos: { caminho: string; largura?: number; altura?: number; transparente: boolean }[];
  fontes: string[];
  referencias: string[];
};

export async function lerKit(nome: string): Promise<KitMarca> {
  const pasta = join(PASTA_MARCAS, nome);
  const logos: KitMarca["logos"] = [];
  for (const caminho of await listar(join(pasta, "logos"), EXT_IMAGEM)) {
    try {
      const info = await sharp(await readFile(caminho)).metadata();
      logos.push({ caminho, largura: info.width, altura: info.height, transparente: Boolean(info.hasAlpha) || extname(caminho) === ".svg" });
    } catch {
      logos.push({ caminho, transparente: false });
    }
  }
  return {
    pasta,
    ficha: await lerFicha(pasta, nome),
    logos,
    fontes: await listar(join(pasta, "fontes"), EXT_FONTE),
    referencias: await listar(join(pasta, "referencias"), EXT_IMAGEM),
  };
}

// Cria (ou completa) a marca: pastas e marca.json. Campos não informados são mantidos.
export async function salvarMarca(ficha: FichaMarca): Promise<string> {
  const nome = (await acharMarca(ficha.nome)) ?? ficha.nome.trim();
  const pasta = join(PASTA_MARCAS, nome);
  for (const sub of SUBPASTAS) await mkdir(join(pasta, sub), { recursive: true });
  const atual = await lerFicha(pasta, nome);
  const nova: FichaMarca = {
    nome,
    cores: { ...atual.cores, ...ficha.cores },
    fontes: { ...atual.fontes, ...ficha.fontes },
    tom: ficha.tom ?? atual.tom,
    notas: ficha.notas ?? atual.notas,
  };
  await writeFile(join(pasta, "marca.json"), JSON.stringify(nova, null, 2), "utf8");
  return pasta;
}

// CSS @font-face pronto para colar no HTML da arte, um por arquivo de fonte do kit.
export function cssDasFontes(fontes: string[]): string {
  return fontes
    .map((caminho) => {
      const arquivo = caminho.split(/[\\/]/).pop() ?? "";
      const familia = arquivo.slice(0, arquivo.length - extname(arquivo).length);
      return `@font-face { font-family: "${familia}"; src: url("${caminho}"); }`;
    })
    .join("\n");
}
