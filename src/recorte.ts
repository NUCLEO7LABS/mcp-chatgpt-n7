// Recorte de fundo com IA, rodando no computador (sem gastar o limite do ChatGPT).
//
// 1. Segmentação: o modelo BiRefNet acha o objeto principal e devolve uma máscara 1024×1024.
// 2. Refinamento: a máscara é ampliada para a resolução da imagem e "colada" nas bordas reais com um
//    filtro guiado (a própria imagem serve de guia), o que tira o serrilhado e preserva detalhes finos.
// 3. Descontaminação: nas bordas semitransparentes, a cor do fundo antigo que vazou é removida,
//    acabando com o halo colorido em volta do objeto.

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";

export const MODELO_RECORTE =
  process.env.CHATGPT_MODELO_RECORTE ?? join(homedir(), ".mcp-chatgpt", "modelos", "birefnet_lite.onnx");

const LADO_MODELO = 1024;
const MEDIA = [0.485, 0.456, 0.406];
const DESVIO = [0.229, 0.224, 0.225];

let sessao: Promise<ort.InferenceSession> | undefined;

export async function recorteDisponivel(): Promise<boolean> {
  try {
    await access(MODELO_RECORTE);
    return true;
  } catch {
    return false;
  }
}

function carregarModelo(): Promise<ort.InferenceSession> {
  // Carrega uma vez só e reaproveita: abrir o modelo leva alguns segundos.
  sessao ??= ort.InferenceSession.create(MODELO_RECORTE, { graphOptimizationLevel: "all" });
  return sessao;
}

// Máscara do objeto principal (0–1), já na resolução da imagem.
async function segmentar(rgb: Buffer, w: number, h: number): Promise<Float32Array> {
  const reduzida = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
    .resize(LADO_MODELO, LADO_MODELO, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();
  const n = LADO_MODELO * LADO_MODELO;
  const entrada = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) entrada[c * n + i] = (reduzida[i * 3 + c] / 255 - MEDIA[c]) / DESVIO[c];
  }

  const modelo = await carregarModelo();
  const saida = await modelo.run({ [modelo.inputNames[0]]: new ort.Tensor("float32", entrada, [1, 3, LADO_MODELO, LADO_MODELO]) });
  const bruto = saida[modelo.outputNames[modelo.outputNames.length - 1]].data as Float32Array;

  // A saída do BiRefNet são logits; se já vier entre 0 e 1, usa direto.
  let fora = false;
  for (let i = 0; i < bruto.length; i += 997) if (bruto[i] < -0.01 || bruto[i] > 1.01) fora = true;
  const mascara = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const v = fora ? 1 / (1 + Math.exp(-bruto[i])) : bruto[i];
    mascara[i] = Math.round(Math.min(1, Math.max(0, v)) * 255);
  }

  const ampliada = await sharp(mascara, { raw: { width: LADO_MODELO, height: LADO_MODELO, channels: 1 } })
    .resize(w, h, { fit: "fill", kernel: "cubic" })
    .extractChannel(0) // sem isso o sharp devolve 3 canais (RGB) e a máscara sai listrada
    .raw()
    .toBuffer();
  const alfa = new Float32Array(w * h);
  for (let i = 0; i < alfa.length; i++) alfa[i] = ampliada[i] / 255;
  return alfa;
}

// Média numa janela (2r+1)² usando tabela de somas acumuladas: custo fixo por pixel, qualquer raio.
function mediaJanela(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const soma = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let linha = 0;
    for (let x = 0; x < w; x++) {
      linha += src[y * w + x];
      soma[(y + 1) * (w + 1) + x + 1] = soma[y * (w + 1) + x + 1] + linha;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const s = soma[y1 * (w + 1) + x1] - soma[y0 * (w + 1) + x1] - soma[y1 * (w + 1) + x0] + soma[y0 * (w + 1) + x0];
      out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

// Filtro guiado (He et al.): faz a máscara seguir as bordas reais da imagem guia.
function filtroGuiado(guia: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h;
  const ii = new Float32Array(n);
  const ip = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ii[i] = guia[i] * guia[i];
    ip[i] = guia[i] * p[i];
  }
  const mI = mediaJanela(guia, w, h, r);
  const mP = mediaJanela(p, w, h, r);
  const mII = mediaJanela(ii, w, h, r);
  const mIP = mediaJanela(ip, w, h, r);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = mII[i] - mI[i] * mI[i];
    const cov = mIP[i] - mI[i] * mP[i];
    a[i] = cov / (varI + eps);
    b[i] = mP[i] - a[i] * mI[i];
  }
  const mA = mediaJanela(a, w, h, r);
  const mB = mediaJanela(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = mA[i] * guia[i] + mB[i];
  return q;
}

export type ResultadoRecorte = { png: Buffer; largura: number; altura: number; segundos: number };

// Recorta o objeto principal. A imagem pode ter fundo de qualquer tipo; se já tiver alfa, ele é ignorado.
export async function recortarComIA(bytes: Buffer): Promise<ResultadoRecorte> {
  const inicio = Date.now();
  const { data: rgb, info } = await sharp(bytes)
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const n = w * h;

  const bruta = await segmentar(rgb, w, h);

  // Refinamento das bordas na resolução cheia.
  const guia = new Float32Array(n);
  for (let i = 0; i < n; i++) guia[i] = (0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]) / 255;
  const raio = Math.max(2, Math.round(Math.max(w, h) / 400));
  const refinada = filtroGuiado(guia, bruta, w, h, raio, 1e-3);

  // Interior 100% opaco e fundo 100% transparente; só a faixa da borda fica com meio-termo.
  const alfa = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // O filtro guiado só ajusta perto de bordas; longe delas, vale a máscara do modelo.
    const v = Math.abs(bruta[i] - 0.5) > 0.45 ? bruta[i] : refinada[i];
    alfa[i] = Math.min(1, Math.max(0, (v - 0.06) / 0.88));
  }

  const pesoFundo = new Float32Array(n);
  for (let i = 0; i < n; i++) pesoFundo[i] = alfa[i] < 0.02 ? 1 : 0;

  // Meio-termo só faz sentido na borda, encostado no fundo. Manchas semitransparentes no meio do objeto
  // (dúvida do modelo) viram sólidas; buracos de verdade têm fundo 100% transparente e continuam vazados.
  const pertoDoFundo = mediaJanela(pesoFundo, w, h, Math.max(3, Math.round(Math.max(w, h) / 200)));
  for (let i = 0; i < n; i++) if (alfa[i] >= 0.02 && pertoDoFundo[i] === 0) alfa[i] = 1;

  // Descontaminação: estima a cor do fundo perto de cada borda e a remove dos pixels semitransparentes.
  const raioFundo = Math.max(8, Math.round(Math.max(w, h) / 60));
  const somaPeso = mediaJanela(pesoFundo, w, h, raioFundo);
  const fundo: Float32Array[] = [];
  for (let c = 0; c < 3; c++) {
    const canal = new Float32Array(n);
    for (let i = 0; i < n; i++) canal[i] = rgb[i * 3 + c] * pesoFundo[i];
    fundo.push(mediaJanela(canal, w, h, raioFundo));
  }

  const saida = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const a = alfa[i];
    for (let c = 0; c < 3; c++) {
      let cor = rgb[i * 3 + c];
      if (a > 0.02 && a < 0.98 && somaPeso[i] > 0.001) {
        const corFundo = fundo[c][i] / somaPeso[i];
        cor = (cor - (1 - a) * corFundo) / a;
      }
      saida[i * 4 + c] = Math.round(Math.min(255, Math.max(0, cor)));
    }
    saida[i * 4 + 3] = Math.round(a * 255);
  }

  const png = await sharp(saida, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  return { png, largura: w, altura: h, segundos: (Date.now() - inicio) / 1000 };
}
