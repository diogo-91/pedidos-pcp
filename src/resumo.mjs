// Confere o que está no banco local: contagens, últimas sincronizações e verificações de consistência.
import { config } from "./config.mjs";
import { abrirBanco } from "./db.mjs";

const db = abrirBanco(config.arquivoBanco);
const um = (sql, ...p) => db.prepare(sql).get(...p);
const todos = (sql, ...p) => db.prepare(sql).all(...p);

console.log(`Banco: ${config.arquivoBanco}\n`);
console.log("Últimas sincronizações:");
console.table(todos("SELECT id, iniciado_em, finalizado_em, status, etapas, erro FROM sync_run ORDER BY id DESC LIMIT 5"));

console.log("Linhas por tabela:");
console.table(
  ["pedido", "pedido_item", "pedido_parcela", "cliente", "produto", "forma_pagamento", "ordem", "ordem_item", "conta_receber"].map((t) => ({
    tabela: t,
    linhas: um(`SELECT COUNT(*) AS n FROM ${t}`).n,
  }))
);

console.log("Pedidos em aberto (liberados) x demais:", um("SELECT SUM(liberado=1) AS abertos, SUM(liberado=0) AS fora FROM pedido"));
console.log("Itens por status (pedidos em aberto):");
console.table(todos("SELECT i.status, COUNT(*) AS itens FROM pedido_item i JOIN pedido p ON p.id=i.pedido_id WHERE p.liberado=1 GROUP BY i.status ORDER BY i.status"));

console.log("Verificações:");
console.table([
  { verificacao: "pedido aberto sem cliente cadastrado", qtd: um("SELECT COUNT(*) n FROM pedido p WHERE liberado=1 AND NOT EXISTS (SELECT 1 FROM cliente c WHERE c.id=p.id_cliente)").n },
  { verificacao: "item aberto sem produto cadastrado", qtd: um("SELECT COUNT(*) n FROM pedido_item i JOIN pedido p ON p.id=i.pedido_id WHERE p.liberado=1 AND NOT EXISTS (SELECT 1 FROM produto x WHERE x.id=i.id_produto)").n },
  { verificacao: "item liberado sem OP (etapa 'ordens' adiada: 0 OPs carregadas = não verificado)", qtd: um("SELECT COUNT(*) n FROM pedido_item i JOIN pedido p ON p.id=i.pedido_id WHERE p.liberado=1 AND i.status=? AND NOT EXISTS (SELECT 1 FROM ordem_item o WHERE o.item_pedido_id=i.id)", config.statusLiberado).n },
  { verificacao: "pedido aberto sem nenhuma parcela a receber", qtd: um("SELECT COUNT(*) n FROM pedido p WHERE liberado=1 AND NOT EXISTS (SELECT 1 FROM conta_receber c WHERE c.pedido_numero=p.numero)").n },
  { verificacao: "pedido aberto sem data de entrega em nenhum item liberado", qtd: um("SELECT COUNT(*) n FROM pedido p WHERE liberado=1 AND NOT EXISTS (SELECT 1 FROM pedido_item i WHERE i.pedido_id=p.id AND i.status=? AND i.data_entrega IS NOT NULL)", config.statusLiberado).n },
  { verificacao: "pedido de outra empresa (id_empresa ≠ configurada)", qtd: um("SELECT COUNT(*) n FROM pedido WHERE liberado=1 AND id_empresa IS NOT NULL AND id_empresa <> ?", config.idEmpresa).n },
  { verificacao: "valor_total do pedido ≠ soma das parcelas (±R$ 0,05)", qtd: um("SELECT COUNT(*) n FROM pedido p WHERE liberado=1 AND EXISTS (SELECT 1 FROM pedido_parcela x WHERE x.pedido_id=p.id) AND ABS(p.valor_total - (SELECT SUM(valor) FROM pedido_parcela x WHERE x.pedido_id=p.id)) > 0.05").n },
]);

console.log("Financeiro dos pedidos em aberto:");
console.log(
  um(
    `SELECT COUNT(*) AS pedidos, ROUND(SUM(p.valor_total),2) AS valor_pedidos, ROUND(SUM(f.recebido),2) AS recebido, ROUND(SUM(f.saldo_aberto),2) AS saldo_aberto, ROUND(SUM(f.vencido),2) AS vencido
     FROM pedido p LEFT JOIN v_financeiro_pedido f ON f.numero = p.numero WHERE p.liberado = 1`
  )
);
db.close();
