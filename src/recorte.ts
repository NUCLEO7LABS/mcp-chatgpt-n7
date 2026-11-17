// Recorte de fundo com IA, rodando no computador (sem gastar o limite do ChatGPT).
//
// 1. Segmentação: o modelo IS-Net (DIS, uso geral) acha o objeto principal. É leve: ~850 MB de memória
//    e poucos segundos num PC comum (o BiRefNet usado antes pedia uns 7 GB).
// 2. Fundo: quando o fundo é liso ou um degradê suave (o que pedimos ao GPT), a cor dele é ajustada por
//    uma superfície em cada ponto da imagem. Com a cor do fundo conhecida, a transparência de cada pixel
//    da borda sai da conta da mistura de cores (pixel = alfa·objeto + (1−alfa)·fundo), e não do palpite do
//    modelo: fios, pelos, vidro e bordas finas saem com a transparência certa.
// 3. Sombras projetadas no fundo (escurecimento da mesma cor do fundo) são tiradas, ou mantidas como
//    sombra preta semitransparente, se pedido.
// 4. Cor das bordas: com o fundo conhecido, a cor do fundo é tirada de cada pixel semitransparente
//    (nada de halo branco ou colorido em volta).
// 5. Limpeza: o interior do objeto fica 100% opaco, o fundo 100% transparente, e pontinhos soltos somem.
// Num fundo que não é liso (foto, cenário), vale só a máscara do modelo, refinada nas bordas da imagem.

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";

export const MODELO_RECORTE =
  process.env.CHATGPT_MODELO_RECORTE ?? join(homedir(), ".mcp-chatgpt", "modelos", "isnet-general-use.onnx");

// Entrada do IS-Net: 1024×1024, cores em 0–1 menos 0,5.
const LADO_MODELO = 1024;
const MEDIA = [0.5, 0.5, 0.5];
const DESVIO = [1, 1, 1];

let sessao: Promise<ort.InferenceSession> | undefined;
let descarregar: NodeJS.Timeout | undefined;
// O modelo sai da memória depois de um tempo sem recortes.
const DESCARREGAR_APOS_MS = 60_000;

export async function recorteDisponivel(): Promise<boolean> {
  try {
    await access(MODELO_RECORTE);
    return true;
  } catch {
    return false;
  }
}

function carregarModelo(): Promise<ort.InferenceSession> {
  // Carrega uma vez e reaproveita enquanto houver recortes: abrir o modelo leva alguns segundos.
  // Sem a reserva de memória do onnxruntime: com ela, cada recorte guardava mais memória em vez de
  // devolver ao sistema.
  sessao ??= ort.InferenceSession.create(MODELO_RECORTE, {
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
  descarregar.unref(); // não segura o servidor aberto
}

// Probabilidade de cada pixel ser objeto, na grade do modelo (LADO_MODELO²).
async function rodarModelo(rgb: Buffer): Promise<Float32Array> {
  const n = LADO_MODELO * LADO_MODELO;
  const entrada = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) entrada[c * n + i] = (rgb[i * 3 + c] / 255 - MEDIA[c]) / DESVIO[c];
  }
  clearTimeout(descarregar);
  const modelo = await carregarModelo();
  const saida = await modelo.run({ [modelo.inputNames[0]]: new ort.Tensor("float32", entrada, [1, 3, LADO_MODELO, LADO_MODELO]) });
  // O IS-Net devolve várias saídas; a primeira é a máscara final, na resolução cheia.
  const bruto = saida[modelo.outputNames[0]].data as Float32Array;
  agendarDescarga();

  // Já vem entre 0 e 1 (sigmoide); se vier em logits, converte.
  let fora = false;
  for (let i = 0; i < bruto.length; i += 997) if (bruto[i] < -0.01 || bruto[i] > 1.01) fora = true;
  const p = new Float32Array(n);
  for (let i = 0; i < n; i++) p[i] = Math.min(1, Math.max(0, fora ? 1 / (1 + Math.exp(-bruto[i])) : bruto[i]));
  return p;
}

// Máscara do objeto principal (0–1), já na resolução da imagem.
async function segmentar(rgb: Buffer, w: number, h: number): Promise<Float32Array> {
  const reduzida = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
    .resize(LADO_MODELO, LADO_MODELO, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();
  const n = LADO_MODELO * LADO_MODELO;
  const p = await rodarModelo(reduzida);
  // 16 bits para a ampliação não criar degraus na borda.
  const media = new Uint16Array(n);
  for (let i = 0; i < n; i++) media[i] = Math.round(p[i] * 65535);

  // O vetor de 16 bits vai direto (como Buffer, o sharp leria cada byte como um pixel).
  const ampliada = await sharp(media, { raw: { width: LADO_MODELO, height: LADO_MODELO, channels: 1 } })
    .toColourspace("grey16")
    .resize(w, h, { fit: "fill", kernel: "cubic" })
    .extractChannel(0) // sem isso o sharp pode devolver 3 canais e a máscara sai listrada
    .raw({ depth: "ushort" })
    .toBuffer();
  const valores = new Uint16Array(ampliada.buffer, ampliada.byteOffset, w * h);
  const alfa = new Float32Array(w * h);
  for (let i = 0; i < alfa.length; i++) alfa[i] = Math.min(1, Math.max(0, valores[i] / 65535));
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

// ---------- Fundo liso ou degradê suave ----------

// Termos do polinômio cúbico em (x, y): cobre fundo liso, degradê e vinheta.
const TERMOS = 10;
function termos(x: number, y: number, t: Float64Array) {
  t[0] = 1;
  t[1] = x;
  t[2] = y;
  t[3] = x * x;
  t[4] = x * y;
  t[5] = y * y;
  t[6] = x * x * x;
  t[7] = x * x * y;
  t[8] = x * y * y;
  t[9] = y * y * y;
}

// Mínimos quadrados: resolve (AᵀA)·c = Aᵀb por eliminação de Gauss com pivô.
function resolver(ata: Float64Array, atb: Float64Array): Float64Array {
  const m = TERMOS;
  const a = Float64Array.from(ata);
  const b = Float64Array.from(atb);
  for (let i = 0; i < m; i++) a[i * m + i] += 1e-9; // estabilidade
  for (let k = 0; k < m; k++) {
    let p = k;
    for (let i = k + 1; i < m; i++) if (Math.abs(a[i * m + k]) > Math.abs(a[p * m + k])) p = i;
    if (p !== k) {
      for (let j = 0; j < m; j++) [a[k * m + j], a[p * m + j]] = [a[p * m + j], a[k * m + j]];
      [b[k], b[p]] = [b[p], b[k]];
    }
    for (let i = k + 1; i < m; i++) {
      const f = a[i * m + k] / a[k * m + k];
      for (let j = k; j < m; j++) a[i * m + j] -= f * a[k * m + j];
      b[i] -= f * b[k];
    }
  }
  const c = new Float64Array(m);
  for (let i = m - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < m; j++) s -= a[i * m + j] * c[j];
    c[i] = s / a[i * m + i];
  }
  return c;
}

type Fundo = { cor: Float32Array[]; ruido: number };

// Ajusta a cor do fundo como uma superfície suave, a partir dos pixels que o modelo diz serem fundo.
// Devolve undefined quando o fundo não é liso nem degradê (foto, cenário, textura).
function ajustarFundo(c: Float32Array[], seg: Float32Array, w: number, h: number): Fundo | undefined {
  const n = w * h;
  const passo = Math.max(1, Math.floor(Math.sqrt(n / 40000)));
  const amostras: number[] = [];
  for (let y = 0; y < h; y += passo) for (let x = 0; x < w; x += passo) if (seg[y * w + x] < 0.03) amostras.push(y * w + x);
  if (amostras.length < 1500) return undefined;

  const nx = (x: number) => (2 * x) / Math.max(1, w - 1) - 1;
  const ny = (y: number) => (2 * y) / Math.max(1, h - 1) - 1;
  const t = new Float64Array(TERMOS);
  let dentro = new Uint8Array(amostras.length).fill(1);
  let coef: Float64Array[] = [];
  let ruido = 0;
  for (let rodada = 0; rodada < 4; rodada++) {
    const ata = new Float64Array(TERMOS * TERMOS);
    const atb = [new Float64Array(TERMOS), new Float64Array(TERMOS), new Float64Array(TERMOS)];
    for (let k = 0; k < amostras.length; k++) {
      if (!dentro[k]) continue;
      const i = amostras[k];
      termos(nx(i % w), ny(Math.floor(i / w)), t);
      for (let a = 0; a < TERMOS; a++) {
        for (let b = 0; b < TERMOS; b++) ata[a * TERMOS + b] += t[a] * t[b];
        for (let ch = 0; ch < 3; ch++) atb[ch][a] += t[a] * c[ch][i];
      }
    }
    coef = atb.map((v) => resolver(ata, v));
    // Resíduo de cada amostra; as muito fora (pedaços do objeto, sombra) saem da próxima rodada.
    const res = new Float64Array(amostras.length);
    for (let k = 0; k < amostras.length; k++) {
      const i = amostras[k];
      termos(nx(i % w), ny(Math.floor(i / w)), t);
      let s = 0;
      for (let ch = 0; ch < 3; ch++) {
        let v = 0;
        for (let a = 0; a < TERMOS; a++) v += coef[ch][a] * t[a];
        s += (c[ch][i] - v) ** 2;
      }
      res[k] = Math.sqrt(s);
    }
    const ordenado = Float64Array.from(res).sort();
    const limite = Math.max(6, 4 * 1.4826 * ordenado[ordenado.length >> 1]);
    dentro = new Uint8Array(amostras.length);
    let soma = 0;
    let conta = 0;
    for (let k = 0; k < amostras.length; k++) {
      if (res[k] <= limite) {
        dentro[k] = 1;
        soma += res[k] * res[k];
        conta++;
      }
    }
    ruido = Math.sqrt(soma / Math.max(1, conta));
    if (rodada === 3 && (conta / amostras.length < 0.8 || ruido > 10)) return undefined;
  }

  const cor = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      termos(nx(x), ny(y), t);
      for (let ch = 0; ch < 3; ch++) {
        let v = 0;
        for (let a = 0; a < TERMOS; a++) v += coef[ch][a] * t[a];
        cor[ch][y * w + x] = v;
      }
    }
  }
  return { cor, ruido };
}

// Espalha as cores dos pixels de "peso" para os pixels de "alvo", em escalas crescentes: cada alvo pega a
// média dos pixels de peso mais próximos. Usado para estimar a cor do objeto (ou do fundo) atrás da borda.
function difundir(c: Float32Array[], peso: Float32Array, alvo: Uint8Array, w: number, h: number): Float32Array[] {
  const n = w * h;
  const out = c.map((canal) => Float32Array.from(canal));
  const falta = Uint8Array.from(alvo);
  let restam = falta.reduce((s, v) => s + v, 0);
  const ponderado = c.map((canal) => {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = canal[i] * peso[i];
    return v;
  });
  for (let r = 1; restam > 0 && r <= Math.max(w, h); r *= 2) {
    const mp = mediaJanela(peso, w, h, r);
    const mc = ponderado.map((v) => mediaJanela(v, w, h, r));
    for (let i = 0; i < n; i++) {
      if (!falta[i] || mp[i] < 1e-3) continue;
      for (let ch = 0; ch < 3; ch++) out[ch][i] = mc[ch][i] / mp[i];
      falta[i] = 0;
      restam--;
    }
  }
  return out;
}

// Marca os pixels de "livre" ligados à borda da imagem por um caminho só de pixels livres.
function ligadoABorda(livre: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const marcado = new Uint8Array(n);
  const fila = new Int32Array(n);
  let ini = 0;
  let fim = 0;
  const entrar = (i: number) => {
    if (livre[i] && !marcado[i]) {
      marcado[i] = 1;
      fila[fim++] = i;
    }
  };
  for (let x = 0; x < w; x++) (entrar(x), entrar((h - 1) * w + x));
  for (let y = 0; y < h; y++) (entrar(y * w), entrar(y * w + w - 1));
  while (ini < fim) {
    const i = fila[ini++];
    const x = i % w;
    if (x > 0) entrar(i - 1);
    if (x < w - 1) entrar(i + 1);
    if (i >= w) entrar(i - w);
    if (i < n - w) entrar(i + w);
  }
  return marcado;
}

// Zera, em "marca", os grupos ligados de pixels marcados com menos de "minimo" pixels.
function marcarAreasPequenas(marca: Uint8Array, w: number, h: number, minimo: number) {
  const n = w * h;
  const visto = new Uint8Array(n);
  const fila = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!marca[s] || visto[s]) continue;
    let ini = 0;
    let fim = 0;
    fila[fim++] = s;
    visto[s] = 1;
    while (ini < fim) {
      const i = fila[ini++];
      const x = i % w;
      for (const v of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1]) {
        if (v >= 0 && marca[v] && !visto[v]) {
          visto[v] = 1;
          fila[fim++] = v;
        }
      }
    }
    if (fim < minimo) for (let k = 0; k < fim; k++) marca[fila[k]] = 0;
  }
}

// Zera, em "cercado", as áreas cuja cor fica a menos de "limite" da cor do fundo (vãos de verdade). Usa a
// mediana: os pixels da beirada do vão, misturados com o objeto, não puxam a conta.
function tirarVaos(cercado: Uint8Array, dist: Float32Array, w: number, h: number, limite: number) {
  const n = w * h;
  const visto = new Uint8Array(n);
  const fila = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!cercado[s] || visto[s]) continue;
    let ini = 0;
    let fim = 0;
    fila[fim++] = s;
    visto[s] = 1;
    while (ini < fim) {
      const i = fila[ini++];
      const x = i % w;
      for (const v of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1]) {
        if (v >= 0 && cercado[v] && !visto[v]) {
          visto[v] = 1;
          fila[fim++] = v;
        }
      }
    }
    const valores = new Float32Array(fim);
    for (let k = 0; k < fim; k++) valores[k] = dist[fila[k]];
    valores.sort();
    if (valores[fim >> 1] < limite) for (let k = 0; k < fim; k++) cercado[fila[k]] = 0;
  }
}

// Tira pontinhos soltos: grupos pequenos de pixels visíveis que o modelo não reconhece como objeto.
function tirarIlhas(alfa: Float32Array, seg: Float32Array, w: number, h: number) {
  const n = w * h;
  const rotulo = new Int32Array(n).fill(-1);
  const fila = new Int32Array(n);
  const minimo = Math.max(64, n * 0.0002);
  for (let s = 0; s < n; s++) {
    if (rotulo[s] !== -1 || alfa[s] <= 0.1) continue;
    let ini = 0;
    let fim = 0;
    fila[fim++] = s;
    rotulo[s] = s;
    let somaSeg = 0;
    while (ini < fim) {
      const i = fila[ini++];
      somaSeg += seg[i];
      const x = i % w;
      for (const v of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (v >= 0 && v < n && rotulo[v] === -1 && alfa[v] > 0.1) {
          rotulo[v] = s;
          fila[fim++] = v;
        }
      }
    }
    if (fim < minimo && somaSeg / fim < 0.5) for (let k = 0; k < fim; k++) alfa[fila[k]] = 0;
  }
}

export type OpcoesRecorte = { manterSombra?: boolean };
export type ResultadoRecorte = {
  png: Buffer;
  largura: number;
  altura: number;
  segundos: number;
  modo: "fundo liso" | "fundo complexo";
  avisos: string[];
};

// Recorta o objeto principal. A imagem pode ter fundo de qualquer tipo; se já tiver alfa, ele é ignorado.
export async function recortarComIA(bytes: Buffer, opcoes: OpcoesRecorte = {}): Promise<ResultadoRecorte> {
  const inicio = Date.now();
  const { data: rgb, info } = await sharp(bytes)
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const n = w * h;
  const cor = [0, 1, 2].map((ch) => {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = rgb[i * 3 + ch];
    return v;
  });

  const seg = await segmentar(rgb, w, h);

  // Máscara do modelo refinada nas bordas reais da imagem (vale onde a conta das cores não decide).
  const guia = new Float32Array(n);
  for (let i = 0; i < n; i++) guia[i] = (0.299 * cor[0][i] + 0.587 * cor[1][i] + 0.114 * cor[2][i]) / 255;
  const refinada = filtroGuiado(guia, seg, w, h, Math.max(2, Math.round(Math.max(w, h) / 400)), 1e-3);
  const alfaModelo = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.abs(seg[i] - 0.5) > 0.45 ? seg[i] : refinada[i];
    alfaModelo[i] = Math.min(1, Math.max(0, (v - 0.06) / 0.88));
  }

  const ajuste = ajustarFundo(cor, seg, w, h);
  const modo = ajuste ? "fundo liso" : "fundo complexo";
  const avisos: string[] = [];
  const ruido = ajuste ? Math.max(6, 3 * ajuste.ruido) : 18;

  // Cor do fundo atrás de cada pixel: a superfície ajustada, ou (fundo complexo) a cor do fundo vizinho.
  const pesoFundo = new Float32Array(n);
  for (let i = 0; i < n; i++) pesoFundo[i] = seg[i] < 0.03 ? 1 : 0;
  const fundo = ajuste
    ? ajuste.cor
    : difundir(cor, pesoFundo, Uint8Array.from(seg, (v) => (v >= 0.03 ? 1 : 0)), w, h);

  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    dist[i] = Math.hypot(cor[0][i] - fundo[0][i], cor[1][i] - fundo[1][i], cor[2][i] - fundo[2][i]);
  }

  // Sombra projetada: a mesma cor do fundo, só que mais escura por igual nos três canais.
  const sombra = new Float32Array(n);
  if (ajuste) {
    const folga = 0.05 + (2 * ruido) / 255;
    for (let i = 0; i < n; i++) {
      if (seg[i] >= 0.5 || dist[i] < ruido) continue;
      let min = Infinity;
      let max = -Infinity;
      let soma = 0;
      let ok = true;
      for (let ch = 0; ch < 3; ch++) {
        const b = fundo[ch][i];
        if (b < 25) {
          ok = false;
          break;
        }
        const r = cor[ch][i] / b;
        min = Math.min(min, r);
        max = Math.max(max, r);
        soma += r;
      }
      const m = soma / 3;
      if (ok && m < 0.99 && m > 0.08 && max - min < folga) sombra[i] = 1 - m;
    }
  }

  // Fundo de verdade é o que se liga à borda da imagem por pixels com cara de fundo. Uma área da cor do
  // fundo cercada pelo objeto (leite branco num copo sobre fundo branco) é objeto, a não ser que o modelo
  // tenha certeza de que ali é um vão (o buraco da alça de uma xícara).
  // Áreas que o modelo chama de fundo mas que ficam cercadas pelo objeto, sem caminho até a borda da
  // imagem. Vãos pequenos (entre fios de cabelo, pelos, folhas) continuam fundo: só áreas grandes contam.
  // Numa área grande, um vão de verdade mostra exatamente a cor do fundo; um pedaço claro do objeto (leite,
  // vidro fosco) tem cor parecida, mas sempre um pouco diferente. Só no fundo liso, onde a cor é conhecida.
  const cercado = new Uint8Array(n);
  if (ajuste) {
    const caraDeFundo = new Uint8Array(n);
    for (let i = 0; i < n; i++) caraDeFundo[i] = seg[i] < 0.5 || sombra[i] > 0 ? 1 : 0;
    const ligado = ligadoABorda(caraDeFundo, w, h);
    for (let i = 0; i < n; i++) cercado[i] = caraDeFundo[i] && !ligado[i] ? 1 : 0;
    marcarAreasPequenas(cercado, w, h, Math.max(400, n * 0.004));
    tirarVaos(cercado, dist, w, h, Math.max(3, 1.5 * ajuste.ruido));
  }

  // Mapa: 1 = objeto com certeza, 0 = fundo com certeza, 2 = borda (decide pela conta das cores).
  const mapa = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    // cercado = 1 só nas áreas cercadas grandes que são objeto
    const vao = !cercado[i];
    if (cercado[i] || seg[i] > 0.97 || (seg[i] > 0.6 && dist[i] > 80)) mapa[i] = 1;
    else if (sombra[i] > 0 && vao) mapa[i] = 0;
    else if (seg[i] < 0.03 && (!ajuste || dist[i] < 2 * ruido)) mapa[i] = 0;
    else if (dist[i] < ruido && seg[i] < 0.5 && vao) mapa[i] = 0;
    else if (dist[i] < ruido && !vao) mapa[i] = 1;
    else mapa[i] = 2;
  }

  // Cor do objeto atrás de cada pixel de borda: a dos pixels de objeto mais próximos.
  const pesoObjeto = new Float32Array(n);
  for (let i = 0; i < n; i++) pesoObjeto[i] = mapa[i] === 1 ? 1 : 0;
  const objeto = difundir(cor, pesoObjeto, Uint8Array.from(mapa, (v) => (v === 2 ? 1 : 0)), w, h);

  const alfa = new Float32Array(n);
  let bordas = 0;
  let parecidas = 0;
  for (let i = 0; i < n; i++) {
    if (mapa[i] !== 2) {
      alfa[i] = mapa[i];
      continue;
    }
    // pixel = alfa·objeto + (1−alfa)·fundo  →  alfa = projeção de (pixel − fundo) em (objeto − fundo)
    let dot = 0;
    let den = 0;
    for (let ch = 0; ch < 3; ch++) {
      const fb = objeto[ch][i] - fundo[ch][i];
      dot += (cor[ch][i] - fundo[ch][i]) * fb;
      den += fb * fb;
    }
    const separacao = Math.sqrt(den);
    const pelaCor = den > 0 ? Math.min(1, Math.max(0, dot / den)) : 0;
    // Objeto e fundo de cores parecidas: a conta não decide, vale mais o modelo.
    let confianca = Math.min(1, Math.max(0, (separacao - 2 * ruido) / 40));
    if (!ajuste) confianca *= 0.8;
    alfa[i] = confianca * pelaCor + (1 - confianca) * alfaModelo[i];
    bordas++;
    if (confianca < 0.3) parecidas++;
    if (alfa[i] < 0.03) alfa[i] = 0;
    else if (alfa[i] > 0.97) alfa[i] = 1;
  }

  // Meio-termo só faz sentido na borda, encostado no fundo: manchas semitransparentes no meio do objeto
  // (dúvida do modelo) viram sólidas; buracos de verdade têm fundo 100% transparente e continuam vazados.
  const vazio = new Float32Array(n);
  for (let i = 0; i < n; i++) vazio[i] = alfa[i] < 0.02 ? 1 : 0;
  const pertoDoVazio = mediaJanela(vazio, w, h, Math.max(3, Math.round(Math.max(w, h) / 200)));
  for (let i = 0; i < n; i++) if (alfa[i] >= 0.02 && alfa[i] < 1 && pertoDoVazio[i] === 0) alfa[i] = 1;

  tirarIlhas(alfa, seg, w, h);

  // Cor final: nas bordas, tira a cor do fundo que vazou (pixel = alfa·objeto + (1−alfa)·fundo).
  const saida = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const a = alfa[i];
    for (let ch = 0; ch < 3; ch++) {
      let v = cor[ch][i];
      if (a > 0 && a < 1) {
        const exata = fundo[ch][i] + (v - fundo[ch][i]) / a;
        // Com alfa muito baixo a conta amplifica o ruído: puxa para a cor estimada do objeto.
        const t = Math.min(1, Math.max(0, (a - 0.05) / 0.3));
        const peso = t * t * (3 - 2 * t);
        v = peso * exata + (1 - peso) * (mapa[i] === 2 ? objeto[ch][i] : v);
      }
      saida[i * 4 + ch] = Math.round(Math.min(255, Math.max(0, v)));
    }
    saida[i * 4 + 3] = Math.round(a * 255);
  }

  // Sombra mantida: preta semitransparente por baixo do objeto.
  if (opcoes.manterSombra && ajuste) {
    for (let i = 0; i < n; i++) {
      const s = Math.min(0.9, sombra[i]);
      if (s <= 0.01) continue;
      const a = alfa[i];
      const total = a + s * (1 - a);
      for (let ch = 0; ch < 3; ch++) saida[i * 4 + ch] = Math.round((saida[i * 4 + ch] * a) / total);
      saida[i * 4 + 3] = Math.round(total * 255);
    }
  }

  // Avisos para o Claude passar adiante.
  let naBorda = 0;
  let perimetro = 0;
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) (perimetro++, alfa[y * w + x] > 0.5 && naBorda++);
  for (let y = 1; y < h - 1; y++) for (const x of [0, w - 1]) (perimetro++, alfa[y * w + x] > 0.5 && naBorda++);
  if (naBorda / perimetro > 0.02) avisos.push("O objeto encosta na borda da imagem: pode ter sido cortado já na geração.");
  if (!ajuste) avisos.push("O fundo não é liso (foto ou cenário): o recorte usa só a IA. Confira as bordas.");
  else if (bordas > 0 && parecidas / bordas > 0.3) {
    avisos.push("Partes da borda têm cor parecida com a do fundo: confira essas bordas. Gerar de novo com um fundo de cor bem diferente do objeto resolve.");
  }

  const png = await sharp(saida, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  return { png, largura: w, altura: h, segundos: (Date.now() - inicio) / 1000, modo, avisos };
}
