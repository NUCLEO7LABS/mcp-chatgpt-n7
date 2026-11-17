// Uso (na pasta do projeto): node ferramentas/mock-interface.mjs — e abra http://127.0.0.1:8765/
// Servidor de mentira da interface do instalador: GET /mock?fase=...&etapa=...&download=...&codigo=... muda o estado.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
let estado = { fase: "inicio", etapa: 0, etapas: [], versao: "1.9.0" };
function montar(q) {
  const etapa = Number(q.get("etapa") ?? 0);
  const fase = q.get("fase") ?? "inicio";
  const etapas = Array.from({ length: 8 }, (_, k) => ({
    status: fase === "pronto" ? "ok" : k + 1 < etapa ? (k === 2 ? "aviso" : "ok") : k + 1 === etapa ? (fase === "erro" ? "erro" : "ativa") : "espera",
    detalhe: k === 0 ? "ja instalado (v24.11.0)" : k === 1 ? "instalado (0.166.0)" : k === 2 ? "instaladas e compiladas" : "",
  }));
  return { fase, etapa, etapas, versao: "1.9.0", download: q.get("download") ? Number(q.get("download")) : null, codigo: q.get("codigo"), claudeAberto: true, erro: q.get("erro"), log: "C:\\Users\\Ana\\AppData\\Local\\mcp-chatgpt\\instalacao.log" };
}
createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/") return res.end(readFileSync("interface/index.html"));
  if (u.pathname === "/logo.webp") return res.writeHead(200, { "Content-Type": "image/webp" }).end(readFileSync("interface/logo.webp"));
  if (u.pathname === "/estado") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(estado));
  if (u.pathname === "/mock") { estado = montar(u.searchParams); return res.end("ok"); }
  res.writeHead(req.method === "POST" ? 200 : 404).end();
}).listen(8765, "127.0.0.1", () => console.log("mock em 8765"));
