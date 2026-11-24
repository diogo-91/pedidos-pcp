// Compara a situação dos pedidos na planilha de programação com a carteira do sistema e dá BAIXA LOCAL nos entregues/cancelados.
// O Nomus não é alterado: o pedido continua liberado lá, mas sai da lista "em aberto" daqui (e fica na visão "Encerrados"; dá para reabrir).
//
//   node --no-warnings src/baixas-planilha.mjs data/situacao-planilha.csv              só compara (nada é gravado)
//   node --no-warnings src/baixas-planilha.mjs data/situacao-planilha.csv --aplicar    dá baixa
//   node --no-warnings src/baixas-planilha.mjs --desfazer                              reabre todos os pedidos baixados por planilha
//
// Regra: baixa quando TODAS as linhas do pedido na planilha estão "entregue" (ou "entregue" + "cancelado"), ou todas "cancelado".
// "Entregue Parcial", "Devolução" e pedidos com parte ainda aberta NÃO são baixados (ficam listados no relatório).
import { readFileSync } from "node:fs";
import { abrirBanco } from "./db.mjs";
import { config } from "./config.mjs";

const args = process.argv.slice(2);
const aplicar = args.includes("--aplicar");
const desfazer = args.includes("--desfazer");
const arquivo = args.find((a) => !a.startsWith("--"));

const db = abrirBanco(config.arquivoBanco);
const dinheiro = (v) => (v ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

if (desfazer) {
  const r = db.prepare("DELETE FROM baixa_pedido WHERE origem LIKE 'planilha%'").run();
  console.log(`Reabertos ${r.changes} pedidos baixados por planilha.`);
  db.close();
  process.exit(0);
}
if (!arquivo) {
  console.error("Informe o CSV gerado por scripts/extrair-situacao-planilha.py.");
  process.exit(1);
}

const planilha = new Map(
  readFileSync(arquivo, "utf8").split(/\r?\n/).slice(1).filter(Boolean).map((l) => {
    const [pedido, linhas, sits] = l.split(";");
    return [Number(pedido), { linhas: Number(linhas), sits: new Set(sits.split("|")) }];
  })
);

function classificar(sits) {
  if (!sits) return { classe: "fora da planilha" };
  const s = [...sits];
  if (s.every((x) => x === "entregue")) return { classe: "entregue", baixar: "entregue" };
  if (s.every((x) => x === "entregue" || x === "cancelado")) return { classe: "entregue (+cancelado)", baixar: "entregue" };
  if (s.every((x) => x === "cancelado")) return { classe: "cancelado", baixar: "cancelado" };
  if (s.includes("entregue") || s.includes("entregue parcial")) return { classe: "parcial (parte entregue, parte aberta)" };
  return { classe: "aberto" };
}

// Pedidos do sistema: carteira (liberado) e fila (aguardando) que ainda não foram baixados, com o financeiro das parcelas.
const hoje = new Date().toLocaleDateString("sv-SE");
const pedidos = db
  .prepare(
    `SELECT p.numero, p.codigo, p.liberado, p.aguardando, p.valor_total,
            COALESCE((SELECT SUM(CASE WHEN c.quitada = 0 THEN c.saldo END) FROM conta_receber c WHERE c.pedido_numero = p.numero), 0) AS saldo,
            COALESCE((SELECT SUM(CASE WHEN c.quitada = 0 AND c.data_vencimento < ? THEN c.saldo END) FROM conta_receber c WHERE c.pedido_numero = p.numero), 0) AS vencido
     FROM pedido p
     WHERE (p.liberado = 1 OR p.aguardando = 1) AND NOT EXISTS (SELECT 1 FROM baixa_pedido b WHERE b.numero = p.numero)
     ORDER BY p.numero`
  )
  .all(hoje);

const grupos = {};
const baixar = [];
for (const p of pedidos) {
  const c = classificar(planilha.get(p.numero)?.sits);
  (grupos[c.classe] ??= []).push(p);
  if (c.baixar) baixar.push({ ...p, situacao: c.baixar });
}

console.log(`Planilha: ${planilha.size} pedidos | Sistema (abertos): ${pedidos.length} pedidos (carteira + aguardando)\n`);
console.table(
  Object.entries(grupos).map(([classe, l]) => ({
    classe,
    pedidos: l.length,
    valor_total: dinheiro(l.reduce((t, p) => t + p.valor_total, 0)),
    saldo_a_receber: dinheiro(l.reduce((t, p) => t + p.saldo, 0)),
    vencido: dinheiro(l.reduce((t, p) => t + p.vencido, 0)),
  }))
);

console.log(`\nPedidos a BAIXAR (${baixar.length}):`);
console.table(baixar.map((p) => ({ pedido: p.codigo, onde: p.liberado ? "carteira" : "aguardando", situacao: p.situacao, valor_total: dinheiro(p.valor_total), saldo_a_receber: dinheiro(p.saldo), vencido: dinheiro(p.vencido) })));
const comSaldo = baixar.filter((p) => p.saldo > 0.005);
console.log(`ATENÇÃO: ${comSaldo.length} dos pedidos a baixar ainda têm saldo a receber: ${dinheiro(comSaldo.reduce((t, p) => t + p.saldo, 0))} (vencido ${dinheiro(comSaldo.reduce((t, p) => t + p.vencido, 0))}). Eles saem da lista em aberto, mas ficam na visão "Encerrados".`);
for (const classe of ["parcial (parte entregue, parte aberta)", "fora da planilha"]) {
  if (grupos[classe]?.length) console.log(`Não baixados (${classe}): ${grupos[classe].map((p) => p.codigo).join(", ")}`);
}

if (!aplicar) {
  console.log("\nSimulação: nada foi gravado. Rode com --aplicar para dar baixa.");
} else {
  const origem = `planilha ${hoje}`;
  const agora = new Date().toISOString();
  const ins = db.prepare("INSERT OR IGNORE INTO baixa_pedido (numero, situacao, origem, motivo, baixado_em) VALUES (?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  let gravados = 0;
  for (const p of baixar) gravados += Number(ins.run(p.numero, p.situacao, origem, `situação "${p.situacao}" na planilha`, agora).changes);
  db.exec("COMMIT");
  console.log(`\nBaixas gravadas: ${gravados} (origem: ${origem}). Para desfazer: --desfazer.`);
}
db.close();
