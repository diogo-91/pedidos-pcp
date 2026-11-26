// Processo separado que executa UMA consulta da IA na cópia de consulta (ver consulta-ia.mjs), aberta somente para leitura.
// Recebe o arquivo como argumento e o SQL pela entrada; devolve JSON. Quem chamou interrompe o processo se demorar.
import { DatabaseSync } from "node:sqlite";

const MAX_LINHAS = 200;
const MAX_TEXTO = 50_000;

let sql = "";
for await (const pedaco of process.stdin) sql += pedaco;

let resposta;
try {
  const db = new DatabaseSync(process.argv[2], { readOnly: true });
  const linhas = [];
  let cortado = false;
  let tamanho = 0;
  for (const linha of db.prepare(sql).iterate()) {
    tamanho += JSON.stringify(linha).length;
    if (linhas.length >= MAX_LINHAS || tamanho > MAX_TEXTO) { cortado = true; break; }
    linhas.push(linha);
  }
  resposta = { linhas_devolvidas: linhas.length, ...(cortado ? { cortado: true, aviso: "Há mais linhas: use SUM/COUNT/GROUP BY ou filtre mais." } : {}), linhas };
} catch (erro) {
  resposta = { erro: `Consulta com erro: ${erro?.message ?? erro}` };
}
process.stdout.write(JSON.stringify(resposta, (_, v) => (typeof v === "bigint" ? Number(v) : v)));
