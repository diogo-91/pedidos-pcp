// Sincroniza o banco local com o Nomus (somente leitura no Nomus).
//
//   node src/sync.mjs                         todas as etapas
//   node src/sync.mjs --etapas pedidos,contas só essas
//   node src/sync.mjs --limite-paginas 1      teste rápido (só 1 página de pedidos; não marca "saiu da carteira")
//
// Etapas (nesta ordem): pedidos, formas, clientes, produtos, ordens, contas.
// Padrão: todas menos "ordens" (adiada; ver PADRAO abaixo).

import path from "node:path";
import { pathToFileURL } from "node:url";
import { config, exigirCredencial } from "./config.mjs";
import { abrirBanco, emTransacao } from "./db.mjs";
import { NomusClient } from "./nomus.mjs";
import { dataIso, limpar, lotes, montarEndereco, nulo, numeroDoCodigo, parseNum } from "./util.mjs";

const TODAS = ["pedidos", "formas", "clientes", "produtos", "ordens", "contas"];
// "ordens" fica fora da sincronização padrão: o endpoint /ordens do Nomus é muito limitado (429 constante e 400 esporádico),
// o que tornava a carga das OPs de ~990 itens inviável. Rode explicitamente com --etapas ordens quando houver outra estratégia.
const PADRAO = TODAS.filter((e) => e !== "ordens");
const STATUS_AGUARDANDO = 1; // itensPedido[].status = Aguardando liberação
const SETE_DIAS = 7 * 24 * 3600 * 1000;
const TRINTA_DIAS = 30 * 24 * 3600 * 1000;

function lerArgumentos(argv) {
  const a = { etapas: PADRAO, limitePaginas: Infinity, completa: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--completa") a.completa = true; // contas de TODOS os pedidos (o padrão pula os já quitados)
    else if (argv[i] === "--etapas") a.etapas = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === "--limite-paginas") a.limitePaginas = Number(argv[++i]);
  }
  const invalidas = a.etapas.filter((e) => !TODAS.includes(e));
  if (invalidas.length) throw new Error(`Etapa(s) desconhecida(s): ${invalidas.join(", ")}. Válidas: ${TODAS.join(", ")}`);
  return a;
}

const agora = () => new Date().toISOString();
const log = (m) => console.log(`${new Date().toLocaleTimeString("pt-BR")}  ${m}`);

// ------------------------------------------------------------------ pedidos

export function gravarPedido(db, p, syncId) {
  const t = agora();
  db.prepare(
    `INSERT INTO pedido (id, codigo, numero, id_empresa, id_cliente, id_vendedor, data_emissao, data_modificacao, data_entrega_padrao,
        valor_total, valor_frete, valor_outras_despesas, id_forma_pagamento, condicao_pagamento, observacoes, observacoes_internas, liberado, aguardando, ultimo_sync_id, raw_json, atualizado_em)
     VALUES (:id, :codigo, :numero, :empresa, :cliente, :vendedor, :emissao, :modificacao, :entrega, :total, :frete, :outras, :forma, :cond, :obs, :obsint, :liberado, :aguardando, :sync, :raw, :t)
     ON CONFLICT(id) DO UPDATE SET codigo=excluded.codigo, numero=excluded.numero, id_empresa=excluded.id_empresa, id_cliente=excluded.id_cliente,
        id_vendedor=excluded.id_vendedor, data_emissao=excluded.data_emissao, data_modificacao=excluded.data_modificacao,
        data_entrega_padrao=excluded.data_entrega_padrao, valor_total=excluded.valor_total, valor_frete=excluded.valor_frete,
        valor_outras_despesas=excluded.valor_outras_despesas, id_forma_pagamento=excluded.id_forma_pagamento,
        condicao_pagamento=excluded.condicao_pagamento, observacoes=excluded.observacoes, observacoes_internas=excluded.observacoes_internas,
        liberado=excluded.liberado, aguardando=excluded.aguardando, ultimo_sync_id=excluded.ultimo_sync_id, raw_json=excluded.raw_json, atualizado_em=excluded.atualizado_em`
  ).run({
    id: p.id,
    codigo: limpar(p.codigoPedido),
    numero: nulo(numeroDoCodigo(p.codigoPedido)),
    empresa: nulo(p.idEmpresa),
    cliente: nulo(p.idPessoaCliente),
    vendedor: nulo(p.idPessoaVendedor),
    emissao: dataIso(p.dataEmissao),
    modificacao: dataIso(p.dataModificacao),
    entrega: dataIso(p.dataEntregaPadrao),
    total: parseNum(p.valorTotal),
    frete: parseNum(p.valorTotalFrete),
    outras: parseNum(p.valorTotalOutrasDespesasAcessorias),
    forma: nulo(p.idFormaPagamento),
    cond: limpar(p.condicaoPagamentoTexto),
    obs: String(p.observacoes ?? "").trim(),
    obsint: String(p.observacoesInternas ?? "").trim(),
    // As duas situações saem dos próprios itens do pedido (status por item): Liberado (2) = carteira; Aguardando liberação (1) = fila.
    liberado: (p.itensPedido ?? []).some((i) => i.status === config.statusLiberado) ? 1 : 0,
    aguardando: (p.itensPedido ?? []).some((i) => i.status === STATUS_AGUARDANDO) ? 1 : 0,
    sync: syncId,
    raw: JSON.stringify(p),
    t,
  });

  // Itens e parcelas são reescritos por inteiro: item removido no Nomus some daqui também.
  db.prepare("DELETE FROM pedido_item WHERE pedido_id = ?").run(p.id);
  db.prepare("DELETE FROM pedido_parcela WHERE pedido_id = ?").run(p.id);

  const inserirItem = db.prepare(
    `INSERT OR REPLACE INTO pedido_item (id, pedido_id, item, id_produto, status, quantidade, id_unidade_medida, valor_unitario, valor_desconto,
        percentual_desconto, valor_acrescimo, percentual_acrescimo, data_entrega, info_adicional, observacoes, raw_json)
     VALUES (:id, :pedido, :item, :produto, :status, :qtd, :un, :vu, :vd, :pd, :va, :pa, :entrega, :info, :obs, :raw)`
  );
  for (const it of p.itensPedido ?? []) {
    if (typeof it.id !== "number") continue;
    inserirItem.run({
      id: it.id,
      pedido: p.id,
      item: limpar(it.item),
      produto: nulo(it.idProduto),
      status: nulo(it.status),
      qtd: parseNum(it.quantidade),
      un: nulo(it.idUnidadeMedida),
      vu: parseNum(it.valorUnitario),
      vd: parseNum(it.valorDesconto),
      pd: parseNum(it.percentualDesconto),
      va: parseNum(it.valorAcrescimo),
      pa: parseNum(it.percentualAcrescimo),
      entrega: dataIso(it.dataEntrega),
      info: limpar(it.informacoesAdicionaisProduto),
      obs: String(it.observacoes ?? "").trim(),
      raw: JSON.stringify(it),
    });
  }

  const inserirParcela = db.prepare(
    `INSERT OR REPLACE INTO pedido_parcela (pedido_id, seq, valor, id_forma_pagamento, data_vencimento, gera_adiantamento, observacao)
     VALUES (:pedido, :seq, :valor, :forma, :venc, :adiant, :obs)`
  );
  (p.parcelas ?? []).forEach((pc, i) =>
    inserirParcela.run({
      pedido: p.id,
      seq: i + 1,
      valor: parseNum(pc.valorParcela),
      forma: nulo(pc.idFormaPagamento),
      venc: dataIso(pc.dataVencimento),
      adiant: pc.geraAdiantamento === true ? 1 : 0,
      obs: limpar(pc.observacao),
    })
  );
}

async function etapaPedidos(ctx) {
  const { db, nomus, syncId, args } = ctx;
  const vistos = new Set();
  let outraEmpresa = 0;
  const completa = args.limitePaginas === Infinity;
  // Duas varreduras: itens Liberados (a carteira) e itens Aguardando liberação (a fila). O mesmo pedido pode vir nas duas: é gravado uma vez.
  // O filtro por item faz join: o mesmo pedido pode vir repetido entre páginas.
  for (const status of [config.statusLiberado, STATUS_AGUARDANDO]) {
    await nomus.todasAsPaginas(
      "pedidos",
      { query: `itensPedido.status=${status}` },
      {
        limitePaginas: args.limitePaginas,
        aoReceber: (lote, pagina) => {
          emTransacao(db, () => {
            for (const p of lote) {
              // Não confia só no filtro da API: precisa ter de fato um item nesse status.
              const temStatus = (p.itensPedido ?? []).some((i) => i.status === status);
              if (typeof p.id !== "number" || !temStatus || vistos.has(p.id)) continue;
              vistos.add(p.id);
              // Instância compartilhada com a Constelha (empresa 1): pedido de outra empresa não entra.
              if (p.idEmpresa !== undefined && p.idEmpresa !== config.idEmpresa) {
                outraEmpresa++;
                continue;
              }
              gravarPedido(db, p, syncId);
            }
          });
          log(`  pedidos (itens no status ${status}): página ${pagina} (+${lote.length}), ${vistos.size - outraEmpresa} pedidos da empresa ${config.idEmpresa} até agora`);
        },
      }
    );
  }
  let sairam = 0;
  if (completa) {
    // Varredura completa: quem não apareceu em nenhuma das duas deixou de ter item Liberado ou Aguardando (faturado, cancelado...).
    sairam = db.prepare("UPDATE pedido SET liberado = 0, aguardando = 0 WHERE (liberado = 1 OR aguardando = 1) AND ultimo_sync_id IS NOT ?").run(syncId).changes;
  }
  const t = db.prepare("SELECT COALESCE(SUM(liberado), 0) AS liberados, COALESCE(SUM(aguardando), 0) AS aguardando FROM pedido").get();
  return { pedidosLiberados: Number(t.liberados), pedidosAguardando: Number(t.aguardando), ignoradosOutraEmpresa: outraEmpresa, sairamDaCarteira: sairam, varreduraCompleta: completa };
}

// ------------------------------------------------------------------ formas de pagamento

async function etapaFormas(ctx) {
  const { db, nomus } = ctx;
  const formas = await nomus.todasAsPaginas("formasPagamento");
  emTransacao(db, () => {
    const ins = db.prepare(
      "INSERT INTO forma_pagamento (id, nome, raw_json) VALUES (:id, :nome, :raw) ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, raw_json=excluded.raw_json"
    );
    for (const f of formas) if (typeof f.id === "number") ins.run({ id: f.id, nome: limpar(f.nome), raw: JSON.stringify(f) });
  });
  return { formas: formas.length };
}

// ------------------------------------------------------------------ cadastros auxiliares (cliente, produto)

/** Busca em lote `id=1,id=2,...` (o RSQL do Nomus não tem "in"); o que não vier no lote é consultado um a um. */
async function buscarPorIds(nomus, endpoint, ids) {
  const achados = new Map();
  for (const lote of lotes(ids, 20)) {
    try {
      const lista = await nomus.get(endpoint, { query: lote.map((id) => `id=${id}`).join(",") });
      for (const r of Array.isArray(lista) ? lista : []) if (typeof r.id === "number" && lote.includes(r.id)) achados.set(r.id, r);
    } catch (erro) {
      log(`  ${endpoint}: lote falhou (${erro.message}); consultando um a um`);
    }
    for (const id of lote) {
      if (achados.has(id)) continue;
      try {
        achados.set(id, await nomus.get(`${endpoint}/${id}`));
      } catch (erro) {
        log(`  ${endpoint}/${id} não pôde ser consultado: ${erro.message}`);
      }
    }
  }
  return achados;
}

function idsDesatualizados(db, tabela, idsNecessarios, validadeMs) {
  const limite = new Date(Date.now() - validadeMs).toISOString();
  const frescos = new Set(db.prepare(`SELECT id FROM ${tabela} WHERE atualizado_em >= ?`).all(limite).map((r) => r.id));
  return idsNecessarios.filter((id) => !frescos.has(id));
}

async function etapaClientes(ctx) {
  const { db, nomus } = ctx;
  const necessarios = db.prepare("SELECT DISTINCT id_cliente AS id FROM pedido WHERE (liberado = 1 OR aguardando = 1) AND id_cliente IS NOT NULL").all().map((r) => r.id);
  const faltam = idsDesatualizados(db, "cliente", necessarios, SETE_DIAS);
  const achados = await buscarPorIds(nomus, "pessoas", faltam);
  emTransacao(db, () => {
    for (const [id, r] of achados) gravarCliente(db, id, r);
  });
  return { necessarios: necessarios.length, consultados: faltam.length, gravados: achados.size, semRetorno: faltam.length - achados.size };
}

export function gravarCliente(db, id, r, atualizadoEm = agora()) {
  db.prepare(
    `INSERT INTO cliente (id, nome, telefone, municipio, uf, endereco_completo, cep, raw_json, atualizado_em)
     VALUES (:id, :nome, :tel, :mun, :uf, :end, :cep, :raw, :t)
     ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, telefone=excluded.telefone, municipio=excluded.municipio, uf=excluded.uf,
        endereco_completo=excluded.endereco_completo, cep=excluded.cep, raw_json=excluded.raw_json, atualizado_em=excluded.atualizado_em`
  ).run({
    id, nome: limpar(r.nome), tel: limpar(r.telefone), mun: limpar(r.municipio), uf: limpar(r.uf).toUpperCase(),
    end: montarEndereco(r), cep: limpar(r.cep), raw: JSON.stringify(r), t: atualizadoEm,
  });
}

async function etapaProdutos(ctx) {
  const { db, nomus } = ctx;
  const necessarios = db.prepare("SELECT DISTINCT i.id_produto AS id FROM pedido_item i JOIN pedido p ON p.id = i.pedido_id WHERE (p.liberado = 1 OR p.aguardando = 1) AND i.id_produto IS NOT NULL").all().map((r) => r.id);
  const faltam = idsDesatualizados(db, "produto", necessarios, TRINTA_DIAS);
  const achados = await buscarPorIds(nomus, "produtos", faltam);
  emTransacao(db, () => {
    const ins = db.prepare(
      `INSERT INTO produto (id, codigo, descricao, tipo, unidade, raw_json, atualizado_em) VALUES (:id, :cod, :desc, :tipo, :un, :raw, :t)
       ON CONFLICT(id) DO UPDATE SET codigo=excluded.codigo, descricao=excluded.descricao, tipo=excluded.tipo, unidade=excluded.unidade, raw_json=excluded.raw_json, atualizado_em=excluded.atualizado_em`
    );
    for (const [id, r] of achados)
      ins.run({ id, cod: limpar(r.codigo), desc: limpar(r.descricao), tipo: limpar(r.nomeTipoProduto), un: limpar(r.siglaUnidadeMedida), raw: JSON.stringify(r), t: agora() });
  });
  return { necessarios: necessarios.length, consultados: faltam.length, gravados: achados.size, semRetorno: faltam.length - achados.size };
}

// ------------------------------------------------------------------ ordens de produção

async function etapaOrdens(ctx) {
  const { db, nomus } = ctx;
  const itens = db.prepare("SELECT i.id FROM pedido_item i JOIN pedido p ON p.id = i.pedido_id WHERE p.liberado = 1 AND i.status = ?").all(config.statusLiberado).map((r) => r.id);
  const conjunto = new Set(itens);
  const ordens = new Map();
  const vinculos = new Set();

  // A consulta por vários ids recusa (400) lotes grandes (5 ids funciona, 10 não): se recusar, divide o lote ao meio.
  async function consultar(lote) {
    try {
      return await nomus.todasAsPaginas("ordens", { query: lote.map((id) => `itensPedido.id=${id}`).join(",") });
    } catch (erro) {
      if (erro.status === 400 && lote.length > 1) {
        const meio = Math.ceil(lote.length / 2);
        return [...(await consultar(lote.slice(0, meio))), ...(await consultar(lote.slice(meio)))];
      }
      throw erro;
    }
  }

  let feitos = 0;
  for (const lote of lotes(itens, 5)) {
    const lista = await consultar(lote);
    feitos += lote.length;
    if (feitos % 100 < 5) log(`  ordens: ${feitos}/${itens.length} itens consultados`);
    for (const o of lista) {
      if (typeof o.id !== "number") continue;
      for (const it of o.itensPedido ?? []) {
        if (typeof it.id === "number" && conjunto.has(it.id)) {
          ordens.set(o.id, o);
          vinculos.add(`${o.id}:${it.id}`);
        }
      }
    }
  }
  emTransacao(db, () => {
    // Reescreve os vínculos dos itens consultados (OP cancelada/desvinculada some).
    const apagar = db.prepare("DELETE FROM ordem_item WHERE item_pedido_id = ?");
    for (const id of itens) apagar.run(id);
    const insO = db.prepare(
      `INSERT INTO ordem (id, nome, status, inicio_planejado, raw_json, atualizado_em) VALUES (:id, :nome, :status, :ini, :raw, :t)
       ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, status=excluded.status, inicio_planejado=excluded.inicio_planejado, raw_json=excluded.raw_json, atualizado_em=excluded.atualizado_em`
    );
    for (const o of ordens.values())
      insO.run({ id: o.id, nome: limpar(o.nome), status: limpar(o.status), ini: dataIso(o.dataHoraInicialPlanejada), raw: JSON.stringify(o), t: agora() });
    const insV = db.prepare("INSERT OR IGNORE INTO ordem_item (ordem_id, item_pedido_id) VALUES (?, ?)");
    for (const v of vinculos) {
      const [o, i] = v.split(":").map(Number);
      insV.run(o, i);
    }
  });
  return { itensConsultados: itens.length, ordens: ordens.size, vinculos: vinculos.size };
}

// ------------------------------------------------------------------ contas a receber

async function etapaContas(ctx) {
  const { db, nomus, args } = ctx;
  const abertos = db.prepare("SELECT DISTINCT numero FROM pedido WHERE (liberado = 1 OR aguardando = 1) AND numero IS NOT NULL ORDER BY numero").all().map((r) => r.numero);
  // Pedido com TODAS as parcelas já quitadas (e com as parcelas todas no banco) não muda mais: pula, e economiza ~40% das chamadas.
  // A varredura completa (--completa, feita uma vez por dia pelo atualizador) confere todos, inclusive esses.
  const pendentes = args.completa
    ? abertos
    : db
        .prepare(
          `SELECT DISTINCT p.numero FROM pedido p
           WHERE (p.liberado = 1 OR p.aguardando = 1) AND p.numero IS NOT NULL AND (
             (SELECT COUNT(*) FROM conta_receber c WHERE c.pedido_numero = p.numero) <> (SELECT COUNT(*) FROM pedido_parcela x WHERE x.pedido_id = p.id)
             OR EXISTS (SELECT 1 FROM conta_receber c WHERE c.pedido_numero = p.numero AND c.quitada = 0))
           ORDER BY p.numero`
        )
        .all()
        .map((r) => r.numero);
  const numeros = pendentes;
  const contas = new Map();
  let deOutraEmpresa = 0;
  for (const lote of lotes(numeros, 20)) {
    // Ligação pela descrição "Pedido PD nnnnn - Parcela x de y"; o filtro de empresa é feito depois (um "e" misturaria com os "ou").
    const query = lote.map((n) => `descricaoLancamento=="Pedido PD ${String(n).padStart(5, "0")}*"`).join(",");
    const lista = await nomus.todasAsPaginas("contasReceber", { query });
    for (const c of lista) {
      if (typeof c.id !== "number") continue;
      if (c.idEmpresa !== undefined && c.idEmpresa !== config.idEmpresa) {
        deOutraEmpresa++;
        continue;
      }
      contas.set(c.id, c);
    }
  }
  emTransacao(db, () => {
    for (const c of contas.values()) gravarConta(db, c);
  });
  return { completa: args.completa === true, pedidosConsultados: numeros.length, pedidosJaQuitadosPulados: abertos.length - numeros.length, parcelas: contas.size, ignoradasOutraEmpresa: deOutraEmpresa };
}

export function gravarConta(db, c) {
  // Em contas a receber os valores vêm positivos; o módulo cobre o caso de virem negativos (contas a pagar).
  const abs = (v) => (parseNum(v) === null ? null : Math.abs(parseNum(v)));
  db.prepare(
    `INSERT INTO conta_receber (id, pedido_numero, descricao, id_empresa, valor, recebido, saldo, data_vencimento, data_baixa, data_competencia, quitada, forma_pagamento, raw_json, atualizado_em)
     VALUES (:id, :pedido, :desc, :emp, :valor, :rec, :saldo, :venc, :baixa, :comp, :quit, :forma, :raw, :t)
     ON CONFLICT(id) DO UPDATE SET pedido_numero=excluded.pedido_numero, descricao=excluded.descricao, id_empresa=excluded.id_empresa, valor=excluded.valor,
        recebido=excluded.recebido, saldo=excluded.saldo, data_vencimento=excluded.data_vencimento, data_baixa=excluded.data_baixa,
        data_competencia=excluded.data_competencia, quitada=excluded.quitada, forma_pagamento=excluded.forma_pagamento, raw_json=excluded.raw_json, atualizado_em=excluded.atualizado_em`
  ).run({
    id: c.id,
    pedido: nulo(numeroDoCodigo(c.descricaoLancamento)),
    desc: limpar(c.descricaoLancamento),
    emp: nulo(c.idEmpresa),
    valor: abs(c.valorReceber),
    rec: abs(c.valorRecebido),
    saldo: abs(c.saldoReceber),
    venc: dataIso(c.dataVencimento),
    baixa: dataIso(c.dataBaixa),
    comp: dataIso(c.dataCompetencia),
    quit: c.status === true ? 1 : 0,
    forma: limpar(c.nomeFormaPagamento),
    raw: JSON.stringify(c),
    t: agora(),
  });
}

// ------------------------------------------------------------------ principal

const ETAPAS = { pedidos: etapaPedidos, formas: etapaFormas, clientes: etapaClientes, produtos: etapaProdutos, ordens: etapaOrdens, contas: etapaContas };

async function main() {
  const args = lerArgumentos(process.argv.slice(2));
  exigirCredencial();
  const db = abrirBanco(config.arquivoBanco);
  // Trava: uma sincronização por vez (a manual e a automática não podem se sobrepor: o Nomus limita as chamadas e o banco teria dois escritores).
  // Uma rodada "rodando" há mais de 60 min é de um processo que morreu: é encerrada como erro.
  // Rodada "rodando" também é encerrada na hora quando o processo dela já morreu (servidor fechado no meio, janela do .cmd fechada...).
  const vivo = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (erro) {
      return erro.code === "EPERM"; // existe, mas é de outro usuário
    }
  };
  for (const r of db.prepare("SELECT id, pid, iniciado_em FROM sync_run WHERE status = 'rodando'").all()) {
    const velha = Date.parse(r.iniciado_em) < Date.now() - 60 * 60 * 1000;
    if (velha || (r.pid && !vivo(r.pid))) {
      db.prepare("UPDATE sync_run SET status = 'erro', finalizado_em = ?, erro = 'interrompida (processo encerrado)' WHERE id = ?").run(agora(), r.id);
    }
  }
  const emAndamento = db.prepare("SELECT id FROM sync_run WHERE status = 'rodando' LIMIT 1").get();
  if (emAndamento) {
    console.error(`Já existe uma sincronização em andamento (#${emAndamento.id}); nada foi feito.`);
    db.close();
    process.exitCode = 2;
    return;
  }
  const nomus = new NomusClient({ baseUrl: config.baseUrl, token: config.token, log });
  const syncId = Number(db.prepare("INSERT INTO sync_run (iniciado_em, etapas, pid) VALUES (?, ?, ?)").run(agora(), args.etapas.join(","), process.pid).lastInsertRowid);
  log(`Sincronização #${syncId} — banco: ${config.arquivoBanco}`);

  const resumo = {};
  const erros = [];
  for (const etapa of args.etapas) {
    const t0 = Date.now();
    log(`Etapa: ${etapa}`);
    try {
      resumo[etapa] = await ETAPAS[etapa]({ db, nomus, syncId, args });
      log(`  ok em ${((Date.now() - t0) / 1000).toFixed(0)}s: ${JSON.stringify(resumo[etapa])}`);
    } catch (erro) {
      erros.push(`${etapa}: ${erro.message}`);
      resumo[etapa] = { erro: erro.message };
      log(`  FALHOU: ${erro.message}`);
      if (etapa === "pedidos") break; // sem pedidos, as demais etapas não têm o que buscar
    }
  }
  const status = erros.length === 0 ? "ok" : erros.length === args.etapas.length ? "erro" : "parcial";
  db.prepare("UPDATE sync_run SET finalizado_em = ?, status = ?, resumo_json = ?, erro = ? WHERE id = ?").run(
    agora(), status, JSON.stringify({ ...resumo, chamadasApi: nomus.chamadas }), erros.join(" | ") || null, syncId
  );
  log(`Sincronização #${syncId} terminou: ${status} (${nomus.chamadas} chamadas à API)`);
  db.close();
  if (status === "erro") process.exitCode = 1;
}

// Só roda a sincronização quando chamado direto (o reprocessar.mjs importa gravarPedido/gravarConta daqui).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((erro) => {
    console.error(`Erro: ${erro.message}`);
    process.exitCode = 1;
  });
}
