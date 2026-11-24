// Reconstrói as colunas tipadas a partir do raw_json já gravado, SEM chamar o Nomus.
// Use depois de corrigir uma regra de conversão (número, data...) em util.mjs/sync.mjs.
import { config } from "./config.mjs";
import { abrirBanco, emTransacao } from "./db.mjs";
import { gravarCliente, gravarConta, gravarPedido } from "./sync.mjs";

const db = abrirBanco(config.arquivoBanco);

// Pedidos de outra empresa (instância compartilhada) não fazem parte da carteira.
const removidos = db.prepare("DELETE FROM pedido WHERE id_empresa IS NOT NULL AND id_empresa <> ?").run(config.idEmpresa).changes;
const contasOutras = db.prepare("DELETE FROM conta_receber WHERE id_empresa IS NOT NULL AND id_empresa <> ?").run(config.idEmpresa).changes;

const pedidos = db.prepare("SELECT raw_json, liberado, aguardando, ultimo_sync_id FROM pedido").all();
emTransacao(db, () => {
  for (const r of pedidos) {
    const bruto = JSON.parse(r.raw_json);
    gravarPedido(db, bruto, r.ultimo_sync_id);
    // gravarPedido recalcula liberado/aguardando pelos itens do JSON (que pode ser antigo: pedido que já saiu da carteira
    // continua com itens "liberados" no JSON). Preserva a situação que o pedido já tinha no banco.
    db.prepare("UPDATE pedido SET liberado = ?, aguardando = ? WHERE id = ?").run(r.liberado, r.aguardando, bruto.id);
  }
});

const contas = db.prepare("SELECT raw_json FROM conta_receber").all();
emTransacao(db, () => {
  for (const r of contas) gravarConta(db, JSON.parse(r.raw_json));
});

// Clientes: refaz as colunas (nome, telefone, endereço...) a partir do JSON bruto, mantendo a data de atualização.
const clientes = db.prepare("SELECT id, raw_json, atualizado_em FROM cliente").all();
emTransacao(db, () => {
  for (const r of clientes) gravarCliente(db, r.id, JSON.parse(r.raw_json), r.atualizado_em);
});

console.log({ pedidosReprocessados: pedidos.length, contasReprocessadas: contas.length, clientesReprocessados: clientes.length, pedidosDeOutraEmpresaRemovidos: removidos, contasDeOutraEmpresaRemovidas: contasOutras });
db.close();
