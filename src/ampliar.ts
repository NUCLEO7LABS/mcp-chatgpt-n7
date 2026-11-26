// Ampliação com IA, no próprio computador: as imagens do GPT pela assinatura vêm com ~1 megapixel
// (1024×1536 no vertical), pouco para um story 1080×1920 ou para exportar em 2×. Esticadas, ficam moles.
//
// Modelo: Real-ESRGAN "general x4 v3" (SRVGGNetCompact, licença BSD-3), misturado meio a meio com a variante
// "wdn", que preserva mais textura (o ajuste de "força de redução de ruído" do próprio Real-ESRGAN). Tem 4,9 MB
// e vai junto com o servidor (modelos/). Amplia 4× em pedaços de 192 px (para gastar pouca memória) e reduz
// com lanczos para o fator pedido: o resultado sai mais nítido do que ampliar direto no fator.
// A transparência é ampliada à parte, sem IA (o contorno do recorte já é suave).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { GITHUB, REPO } from "./atualizacao.js";

export const MODELO_AMPLIAR =
  process.env.CHATGPT_MODELO_AMPLIAR ??
  join(dirname(dirname(fileURLToPath(import.meta.url))), "modelos", "ampliar-x4.onnx");

const ESCALA_MODELO = 4;
const PEDACO = 192;
const MARGEM = 12; // contexto em volta de cada pedaço, para não aparecer emenda
const DESCARREGAR_APOS_MS = 60_000;
// Até onde ampliar: lado maior de 4096 px já cobre um story em 2× e não pesa demais.
export const LADO_MAXIMO = 4096;

let sessao: Promise<ort.InferenceSession> | undefined;
let descarregar: NodeJS.Timeout | undefined;
let fila: Promise<unknown> = Promise.resolve(); // uma ampliação por vez: cada uma já usa todos os núcleos

// O modelo vai no pacote do servidor, mas quem atualizou de uma versão anterior à 1.12 pela atualização
// automática não o recebe (o código de atualização antigo não conhece a pasta modelos/). Nesse caso, baixa
// da versão publicada no GitHub na primeira vez que precisar, com a impressão digital conferida.
const SHA_MODELO = "62a4c281fb1bccbf27a545be7ad14ebfb6c2075ced7f43f5f1edc1365ab4bb25";
let baixando: Promise<boolean> | undefined;

export function ampliacaoDisponivel(): Promise<boolean> {
  if (existsSync(MODELO_AMPLIAR)) return Promise.resolve(true);
  if (process.env.CHATGPT_MODELO_AMPLIAR) return Promise.resolve(false);
  baixando ??= baixarModelo().finally(() => (baixando = undefined));
  return baixando;
}

async function baixarModelo(): Promise<boolean> {
  try {
    const r = await fetch(`${GITHUB}/${REPO}/releases/latest/download/ampliar-x4.onnx`, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) return false;
    const bytes = Buffer.from(await r.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== SHA_MODELO) return false;
    await mkdir(dirname(MODELO_AMPLIAR), { recursive: true });
    const parcial = `${MODELO_AMPLIAR}.${process.pid}.part`;
    await writeFile(parcial, bytes);
    await rename(parcial, MODELO_AMPLIAR).catch(async () => {
      await rm(parcial, { force: true }); // outra cópia do servidor baixou ao mesmo tempo
    });
    return existsSync(MODELO_AMPLIAR);
  } catch {
    return false;
  }
}

function carregarModelo(): Promise<ort.InferenceSession> {
  sessao ??= ort.InferenceSession.create(MODELO_AMPLIAR, {
    graphOptimizationLevel: "all",
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
  return sessao;
}

function agendarDescarga() {
  clearTimeout(descarregar);
  descarregar = setTimeout(() => {
    const atual = sessao;
    sessao = undefined;
    void atual?.then((s) => s.release()).catch(() => {});
  }, DESCARREGAR_APOS_MS);
  descarregar.unref();
}

// Fator que faz sentido para uma imagem: 2× por padrão, sem passar de LADO_MAXIMO. 1 = não precisa.
export function fatorPara(largura: number, altura: number, pedido = 2): number {
  const maior = Math.max(largura, altura);
  return Math.max(1, Math.min(pedido, LADO_MAXIMO / maior));
}

export type Ampliacao = { bytes: Buffer; largura: number; altura: number; transparente: boolean; segundos: number };

// Amplia e devolve PNG (com transparência) ou JPEG de alta qualidade (sem: um PNG desse tamanho passaria de 10 MB).
export function ampliar(bytes: Buffer, fator = 2): Promise<Ampliacao> {
  const tarefa = fila.then(() => ampliarAgora(bytes, fator));
  fila = tarefa.catch(() => undefined);
  return tarefa;
}

async function ampliarAgora(bytes: Buffer, fatorPedido: number): Promise<Ampliacao> {
  const inicio = Date.now();
  const meta = await sharp(bytes).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) throw new Error("não consegui ler a imagem");
  const fator = fatorPara(W, H, fatorPedido);
  const largura = Math.round(W * fator);
  const altura = Math.round(H * fator);
  const temAlfa = Boolean(meta.hasAlpha);
  if (fator < 1.05) return { bytes, largura: W, altura: H, transparente: temAlfa, segundos: 0 };

  const { data: rgb } = await sharp(bytes).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const L = W * ESCALA_MODELO;
  const grande = Buffer.alloc(L * H * ESCALA_MODELO * 3);

  clearTimeout(descarregar);
  try {
    const modelo = await carregarModelo();
    const nomeEntrada = modelo.inputNames[0];
    const nomeSaida = modelo.outputNames[0];
    for (let ty = 0; ty < H; ty += PEDACO) {
      for (let tx = 0; tx < W; tx += PEDACO) {
        const x0 = Math.max(0, tx - MARGEM);
        const y0 = Math.max(0, ty - MARGEM);
        const x1 = Math.min(W, tx + PEDACO + MARGEM);
        const y1 = Math.min(H, ty + PEDACO + MARGEM);
        const w = x1 - x0;
        const h = y1 - y0;
        const plano = w * h;
        const entrada = new Float32Array(3 * plano);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const o = ((y0 + y) * W + x0 + x) * 3;
            const i = y * w + x;
            entrada[i] = rgb[o] / 255;
            entrada[plano + i] = rgb[o + 1] / 255;
            entrada[2 * plano + i] = rgb[o + 2] / 255;
          }
        }
        const resultado = await modelo.run({ [nomeEntrada]: new ort.Tensor("float32", entrada, [1, 3, h, w]) });
        const saida = resultado[nomeSaida].data as Float32Array;
        const ws = w * ESCALA_MODELO;
        const planoS = ws * h * ESCALA_MODELO;
        // Só o miolo do pedaço (sem a margem) vai para a imagem grande.
        const cx = (tx - x0) * ESCALA_MODELO;
        const cy = (ty - y0) * ESCALA_MODELO;
        const cw = Math.min(PEDACO, W - tx) * ESCALA_MODELO;
        const ch = Math.min(PEDACO, H - ty) * ESCALA_MODELO;
        for (let y = 0; y < ch; y++) {
          for (let x = 0; x < cw; x++) {
            const s = (cy + y) * ws + cx + x;
            const d = ((ty * ESCALA_MODELO + y) * L + tx * ESCALA_MODELO + x) * 3;
            for (let c = 0; c < 3; c++) {
              const v = Math.round(saida[c * planoS + s] * 255);
              grande[d + c] = v < 0 ? 0 : v > 255 ? 255 : v;
            }
          }
        }
      }
    }
  } finally {
    agendarDescarga();
  }

  let imagem = sharp(grande, { raw: { width: L, height: H * ESCALA_MODELO, channels: 3 } }).resize(largura, altura, {
    kernel: "lanczos3",
  });
  if (temAlfa) {
    const alfa = await sharp(bytes)
      .rotate()
      .ensureAlpha()
      .extractChannel(3)
      .resize(largura, altura, { kernel: "lanczos3" })
      .raw()
      .toBuffer();
    const cor = await imagem.raw().toBuffer();
    imagem = sharp(cor, { raw: { width: largura, height: altura, channels: 3 } }).joinChannel(alfa, {
      raw: { width: largura, height: altura, channels: 1 },
    });
    const png = await imagem.png({ compressionLevel: 9 }).toBuffer();
    return { bytes: png, largura, altura, transparente: true, segundos: (Date.now() - inicio) / 1000 };
  }
  const jpeg = await imagem.jpeg({ quality: 95, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
  return { bytes: jpeg, largura, altura, transparente: false, segundos: (Date.now() - inicio) / 1000 };
}
