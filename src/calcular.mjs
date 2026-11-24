// Calcula o consumo de material de todos os itens liberados e grava em item_calculo, item_tinta e pedido_material.
// Não chama o Nomus: usa o que já está no banco. Pode rodar quantas vezes quiser (refaz tudo).
//
//   node --no-warnings src/calcular.mjs
import { config } from "./config.mjs";
import { abrirBanco, emTransacao } from "./db.mjs";
import { calcularItem, PARAMETROS_PADRAO, totalDoPedido } from "./calculo.mjs";

const db = abrirBanco(config.arquivoBanco);

const params = { ...PARAMETROS_PADRAO };
for (const r of db.prepare("SELECT chave, valor FROM parametro_calculo").all()) params[r.chave] = r.valor;

const itens = db
  .prepare(
    `SELECT i.id, i.pedido_id, i.quantidade, i.info_adicional, i.observacoes, i.item, pr.descricao, pr.unidade
     FROM pedido_item i
     JOIN pedido p ON p.id = i.pedido_id
     LEFT JOIN produto pr ON pr.id = i.id_produto
     WHERE p.liberado = 1 AND i.status = ?
     ORDER BY i.pedido_id, i.id`
  )
  .all(config.statusLiberado);

const agora = new Date().toISOString();
const porPedido = new Map();

emTransacao(db, () => {
  db.exec("DELETE FROM item_tinta; DELETE FROM item_calculo; DELETE FROM pedido_material;");
  const insItem = db.prepare(
    `INSERT INTO item_calculo (item_id, pedido_id, categoria, situacao, metros, faces, bobina_kg, eps_m, cola_tubos, tinta_kg, aviso, calculado_em)
     VALUES (:id, :pedido, :cat, :sit, :metros, :faces, :bobina, :eps, :cola, :tinta, :aviso, :t)`
  );
  const insTinta = db.prepare("INSERT INTO item_tinta (item_id, cor, kg) VALUES (?, ?, ?) ON CONFLICT(item_id, cor) DO UPDATE SET kg = kg + excluded.kg");

  for (const it of itens) {
    const r = calcularItem(
      { descricao: it.descricao, unidade: it.unidade, quantidade: it.quantidade, textos: `${it.info_adicional} ${it.observacoes}` },
      params
    );
    insItem.run({
      id: it.id, pedido: it.pedido_id, cat: r.categoria, sit: r.situacao, metros: r.metros, faces: r.faces,
      bobina: r.bobina_kg, eps: r.eps_m, cola: r.cola_tubos, tinta: r.tinta_kg, aviso: r.aviso, t: agora,
    });
    if (r.tinta_kg > 0) {
      // Duas faces com duas cores: divide igualmente; senão, tudo na primeira cor (ou "A DEFINIR").
      const cores = r.cores.length ? r.cores : ["A DEFINIR"];
      if (cores.length === r.faces && r.faces > 1) cores.forEach((c) => insTinta.run(it.id, c, r.tinta_kg / cores.length));
      else insTinta.run(it.id, cores[0], r.tinta_kg);
    }
    if (!porPedido.has(it.pedido_id)) porPedido.set(it.pedido_id, []);
    porPedido.get(it.pedido_id).push(r);
  }

  const insPed = db.prepare(
    `INSERT INTO pedido_material (pedido_id, bobina_kg, eps_m_exato, eps_m, cola_tubos_exato, cola_tubos, tinta_kg, itens_calculados, itens_a_revisar, itens_sem_regra, calculado_em)
     VALUES (:id, :bobina, :epsx, :eps, :colax, :cola, :tinta, :ok, :rev, :sem, :t)`
  );
  for (const [pedidoId, lista] of porPedido) {
    const t = totalDoPedido(lista);
    insPed.run({ id: pedidoId, bobina: t.bobina_kg, epsx: t.eps_m_exato, eps: t.eps_m, colax: t.cola_tubos_exato, cola: t.cola_tubos, tinta: t.tinta_kg, ok: t.itens_calculados, rev: t.itens_a_revisar, sem: t.itens_sem_regra, t: agora });
  }
});

console.log(`Itens liberados processados: ${itens.length} em ${porPedido.size} pedidos. Parâmetros:`, params);
db.close();
