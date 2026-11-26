// Servidor local da tela "Pedidos em aberto". Somente leitura sobre o banco local; não fala com o Nomus.
// Escuta só em 127.0.0.1 (a tela mostra nome e telefone de clientes e valores financeiros).
//
//   node --no-warnings src/servidor.mjs        ->  http://127.0.0.1:3300
import http from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual, randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.mjs";
import { montarEndereco } from "./util.mjs";
import { abrirBanco } from "./db.mjs";
import { rotaDaCidade } from "./rotas.mjs";
import { calcularItem, dividirTinta, PARAMETROS_PADRAO, totalDoPedido } from "./calculo.mjs";
import { criarAtualizador } from "./atualizador.mjs";
import { criarAssistente, ErroAssistente } from "./assistente.mjs";
import { criarConsulta } from "./consulta-ia.mjs";

const MINIMO = config.pedidoMinimo;

// Pedidos encerrados (baixa local: entregues/cancelados pela planilha ou baixados à mão) saem das listas "em aberto".
const SEM_BAIXA = "NOT EXISTS (SELECT 1 FROM baixa_pedido b WHERE b.numero = p.numero)";
const filtroBaixa = (modo) => (modo === "so" ? "EXISTS (SELECT 1 FROM baixa_pedido b WHERE b.numero = p.numero)" : modo === "todos" ? "1 = 1" : SEM_BAIXA);
const PORTA = config.porta;
const HOST = config.host;
const LOCAL = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(HOST);
// Fora do próprio computador (container) a tela só pode subir protegida por token: sem ele qualquer um na rede leria clientes e valores.
if (!LOCAL && config.acessoToken.length < 24) {
  console.error("PEDIDOS_HOST diferente de 127.0.0.1 exige PEDIDOS_TOKEN com pelo menos 24 caracteres.");
  process.exit(1);
}
const TOKEN_ESPERADO = Buffer.from(config.acessoToken);
const HOSTS_ACEITOS = new Set(["127.0.0.1", "localhost", ...config.hostsPermitidos]);
/** Compara o token enviado com o esperado em tempo constante. */
function tokenConfere(recebido) {
  if (!TOKEN_ESPERADO.length) return true; // sem token configurado (uso local): vale só a checagem de host
  const r = Buffer.from(String(recebido ?? ""));
  return r.length === TOKEN_ESPERADO.length && timingSafeEqual(r, TOKEN_ESPERADO);
}
const PAGINA = path.join(config.raiz, "public", "index.html");

abrirBanco(config.arquivoBanco).close(); // garante o esquema (tabelas novas, como baixa_pedido) antes das consultas
const db = new DatabaseSync(config.arquivoBanco);
db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
const atualizador = criarAtualizador({ db, config });
// O assistente de IA só enxerga o que estas funções (somente leitura) devolvem, através das ferramentas de src/assistente-ferramentas.mjs.
const assistente = criarAssistente({
  dados: {
    listaPedidos: () => listaPedidos(),
    listaAguardando: () => listaAguardando(),
    listaEncerrados: () => listaPedidos("so"),
    detalhePedido: (id) => detalhePedido(id),
    materiaisDaCarteira: () => materiaisDaCarteira(),
    materiaisPorPedido: () => materiaisPorPedido(),
    // Consulta livre (SELECT) numa cópia do banco local sem dados pessoais; nunca no Nomus (ver consulta-ia.mjs).
    consultarBanco: (sql) => consultarBanco(sql),
  },
});
let consultaPronta = null;
const consultarBanco = (sql) => (consultaPronta ??= criarConsulta({ arquivoBanco: config.arquivoBanco, todos, listaPedidos, listaAguardando }))(sql);

// Conexão de escrita (só para as baixas); o resto do servidor usa a conexão somente leitura.
let conexaoEscrita = null;
const escrita = () => (conexaoEscrita ??= abrirBanco(config.arquivoBanco));

/** Lê o corpo JSON de um POST (até 200 KB). */
function lerCorpoJson(req, limite = 200_000) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const partes = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > limite) {
        reject(new ErroAssistente("Mensagem grande demais.", 413));
        req.destroy();
      } else partes.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(partes).toString("utf8") || "{}"));
      } catch {
        reject(new ErroAssistente("Corpo da requisição inválido.", 400));
      }
    });
    req.on("error", reject);
  });
}

const hojeLocal = () => new Date().toLocaleDateString("sv-SE"); // aaaa-mm-dd no fuso local
const todos = (sql, params = {}) => db.prepare(sql).all(params);
const um = (sql, params = {}) => db.prepare(sql).get(params);

// Parcelas a receber agrupadas por pedido (o vencido depende do dia de hoje).
const FINANCEIRO = `
  SELECT pedido_numero,
         COUNT(*)                                                                       AS parcelas,
         ROUND(SUM(recebido), 2)                                                        AS recebido,
         ROUND(SUM(CASE WHEN quitada = 0 THEN saldo ELSE 0 END), 2)                     AS saldo,
         ROUND(SUM(CASE WHEN quitada = 0 AND data_vencimento < :hoje THEN saldo ELSE 0 END), 2) AS vencido,
         MIN(CASE WHEN quitada = 0 THEN data_vencimento END)                            AS proximo_vencimento
  FROM conta_receber GROUP BY pedido_numero`;

// A entrada é a primeira parcela do pedido ("Pedido PD nnnnn - Parcela 1 de N"); o rótulo (ENTRADA, 100% PAGO...) vem do pedido.
const PRIMEIRA_PARCELA = `descricao LIKE '%Parcela 1 de %'`;

/** Coeficientes de cálculo (tabela parametro_calculo, com os padrões como reserva). */
function parametrosDeCalculo() {
  const p = { ...PARAMETROS_PADRAO };
  for (const r of todos("SELECT chave, valor FROM parametro_calculo")) p[r.chave] = r.valor;
  return p;
}
/** Chapas por metro de telha (sanduíche e forro: 2; simples e semi: 1). null para o que não é telha. */
const chapasPorMetro = (categoria, p) => ({ SIMPLES: p.chapas_simples, SEMI: p.chapas_semi, SANDUICHE: p.chapas_sanduiche, FORRO: p.chapas_forro })[categoria] ?? null;

/** Acrescenta a rota de entrega (pela cidade do cliente) a uma linha que tenha municipio e uf. */
function comRota(r) {
  const x = rotaDaCidade(r.municipio, r.uf);
  return { ...r, rota_numero: x?.numero ?? null, rota: x?.nome ?? "Sem rota" };
}

function situacaoFinanceira(r) {
  if (!r.parcelas) return "sem_titulo";
  if (r.vencido > 0) return "vencido";
  if (r.saldo <= 0.005) return "quitado";
  return "a_vencer";
}

/** modo: "nao" = só em aberto (padrão), "so" = só encerrados (baixados), "todos". */
function listaPedidos(modo = "nao") {
  const hoje = hojeLocal();
  const linhas = todos(
    `SELECT p.id, p.codigo, p.numero, c.nome AS cliente, c.telefone, c.municipio, c.uf, c.endereco_completo, p.data_emissao, p.valor_total, p.condicao_pagamento,
            (SELECT b.situacao FROM baixa_pedido b WHERE b.numero = p.numero) AS baixa_situacao,
            (SELECT b.origem FROM baixa_pedido b WHERE b.numero = p.numero) AS baixa_origem,
            (SELECT b.baixado_em FROM baixa_pedido b WHERE b.numero = p.numero) AS baixa_em,
            (SELECT x.observacao FROM pedido_parcela x WHERE x.pedido_id = p.id AND x.seq = 1) AS entrada_rotulo,
            e1.valor AS entrada_valor, COALESCE(e1.recebido, 0) AS entrada_recebido, e1.quitada AS entrada_paga,
            e1.data_baixa AS entrada_baixa, e1.data_vencimento AS entrada_vencimento,
            (SELECT MIN(i.data_entrega) FROM pedido_item i WHERE i.pedido_id = p.id AND i.status = :liberado) AS primeira_entrega,
            (SELECT COUNT(*) FROM pedido_item i WHERE i.pedido_id = p.id AND i.status = :liberado)            AS itens,
            (SELECT group_concat(DISTINCT k.categoria) FROM item_calculo k WHERE k.pedido_id = p.id)          AS tipos,
            COALESCE(f.parcelas, 0) AS parcelas, COALESCE(f.recebido, 0) AS recebido, COALESCE(f.saldo, 0) AS saldo,
            COALESCE(f.vencido, 0) AS vencido, f.proximo_vencimento,
            COALESCE(m.bobina_kg, 0) AS bobina_kg, COALESCE(m.eps_m, 0) AS eps_m, COALESCE(m.cola_tubos, 0) AS cola_tubos,
            COALESCE(m.tinta_kg, 0) AS tinta_kg, COALESCE(m.itens_a_revisar, 0) AS itens_a_revisar, COALESCE(m.itens_sem_regra, 0) AS itens_sem_regra
     FROM pedido p
     LEFT JOIN cliente c ON c.id = p.id_cliente
     LEFT JOIN (${FINANCEIRO}) f ON f.pedido_numero = p.numero
     LEFT JOIN (SELECT pedido_numero, valor, recebido, quitada, data_baixa, data_vencimento FROM conta_receber WHERE ${PRIMEIRA_PARCELA}) e1 ON e1.pedido_numero = p.numero
     LEFT JOIN pedido_material m ON m.pedido_id = p.id
     WHERE ${modo === "so" ? "(p.liberado = 1 OR p.aguardando = 1)" : "p.liberado = 1"} AND p.numero >= :minimo AND ${filtroBaixa(modo)}
     ORDER BY primeira_entrega, p.numero`,
    { hoje, liberado: config.statusLiberado, minimo: config.pedidoMinimo }
  );
  return { hoje, pedidos: linhas.map((r) => ({ ...comRota(r), financeiro: situacaoFinanceira(r) })) };
}

// Fila de pedidos com itens em "Aguardando liberação" (status 1): ainda não são carteira. Mesmo corte de número mínimo da carteira.
function listaAguardando() {
  const hoje = hojeLocal();
  const linhas = todos(
    `SELECT p.id, p.codigo, p.numero, c.nome AS cliente, c.telefone, c.municipio, c.uf, c.endereco_completo, p.data_emissao, p.valor_total,
            (SELECT MIN(i.data_entrega) FROM pedido_item i WHERE i.pedido_id = p.id AND i.status = 1) AS primeira_entrega,
            (SELECT COUNT(*) FROM pedido_item i WHERE i.pedido_id = p.id AND i.status = 1) AS itens,
            (SELECT x.observacao FROM pedido_parcela x WHERE x.pedido_id = p.id AND x.seq = 1) AS entrada_rotulo,
            e1.valor AS entrada_valor, COALESCE(e1.recebido, 0) AS entrada_recebido, e1.quitada AS entrada_paga,
            e1.data_baixa AS entrada_baixa, e1.data_vencimento AS entrada_vencimento,
            COALESCE(f.parcelas, 0) AS parcelas, COALESCE(f.recebido, 0) AS recebido, COALESCE(f.saldo, 0) AS saldo,
            COALESCE(f.vencido, 0) AS vencido, f.proximo_vencimento
     FROM pedido p
     LEFT JOIN cliente c ON c.id = p.id_cliente
     LEFT JOIN (${FINANCEIRO}) f ON f.pedido_numero = p.numero
     LEFT JOIN (SELECT pedido_numero, valor, recebido, quitada, data_baixa, data_vencimento FROM conta_receber WHERE ${PRIMEIRA_PARCELA}) e1 ON e1.pedido_numero = p.numero
     WHERE p.aguardando = 1 AND p.numero >= :minimo AND ${SEM_BAIXA}
     ORDER BY p.data_emissao, p.numero`,
    { hoje, minimo: MINIMO }
  );
  const escondidos = um("SELECT COUNT(*) AS n FROM pedido WHERE aguardando = 1 AND numero < :minimo", { minimo: MINIMO }).n;
  const diasDesde = (iso) => (iso ? Math.max(0, Math.round((Date.parse(hoje) - Date.parse(iso.slice(0, 10))) / 86400000)) : null);
  return { hoje, escondidos, pedidos: linhas.map((r) => ({ ...comRota(r), financeiro: situacaoFinanceira(r), dias_aguardando: diasDesde(r.data_emissao) })) };
}

function detalhePedido(id) {
  const hoje = hojeLocal();
  const p = um(
    `SELECT p.*, c.nome AS cliente, c.telefone, c.municipio, c.uf, fp.nome AS forma_pagamento
     FROM pedido p LEFT JOIN cliente c ON c.id = p.id_cliente LEFT JOIN forma_pagamento fp ON fp.id = p.id_forma_pagamento WHERE p.id = :id`,
    { id }
  );
  if (!p) return null;
  delete p.raw_json;
  const itens = todos(
    `SELECT i.id, i.item, i.status, i.quantidade, i.valor_unitario, i.data_entrega, i.info_adicional, i.observacoes,
            pr.descricao AS produto, pr.unidade, k.categoria, k.situacao, k.metros, k.faces, k.bobina_kg, k.eps_m, k.cola_tubos, k.tinta_kg, k.aviso,
            (SELECT group_concat(t.cor || ' ' || printf('%.1f', t.kg) || ' kg', ' · ') FROM item_tinta t WHERE t.item_id = i.id) AS tinta_cores
     FROM pedido_item i LEFT JOIN produto pr ON pr.id = i.id_produto LEFT JOIN item_calculo k ON k.item_id = i.id
     WHERE i.pedido_id = :id ORDER BY i.id`,
    { id }
  );
  const parcelas = todos(
    `SELECT x.seq, x.valor, x.data_vencimento, x.gera_adiantamento, x.observacao, fp.nome AS forma
     FROM pedido_parcela x LEFT JOIN forma_pagamento fp ON fp.id = x.id_forma_pagamento WHERE x.pedido_id = :id ORDER BY x.seq`,
    { id }
  );
  const contas = todos(
    `SELECT descricao, valor, recebido, saldo, data_vencimento, data_baixa, quitada, forma_pagamento
     FROM conta_receber WHERE pedido_numero = :n ORDER BY data_vencimento, id`,
    { n: p.numero }
  ).map((c) => ({ ...c, vencida: c.quitada === 0 && c.data_vencimento < hoje }));
  const resumoFin = um(`SELECT * FROM (${FINANCEIRO}) WHERE pedido_numero = :n`, { hoje, n: p.numero }) ?? { parcelas: 0, recebido: 0, saldo: 0, vencido: 0, proximo_vencimento: null };
  const e1 = um(
    `SELECT valor, recebido, quitada, data_baixa, data_vencimento FROM conta_receber WHERE pedido_numero = :n AND ${PRIMEIRA_PARCELA}`,
    { n: p.numero }
  );
  const entrada = e1
    ? { rotulo: parcelas[0]?.observacao ?? "", valor: e1.valor, recebido: e1.recebido, paga: e1.quitada === 1, data_baixa: e1.data_baixa, vencimento: e1.data_vencimento }
    : null;
  // Endereços do cadastro do cliente: o principal e os alternativos ativos (ex.: "Entrega").
  let enderecos = { principal: "", outros: [] };
  const cli = um("SELECT raw_json FROM cliente WHERE id = :id", { id: p.id_cliente });
  if (cli) {
    const raw = JSON.parse(cli.raw_json);
    enderecos = {
      principal: montarEndereco(raw),
      outros: (raw.enderecos ?? []).filter((e) => e.ativo !== false).map((e) => ({ tipo: e.tipoEndereco || "Outro", texto: montarEndereco(e) })).filter((e) => e.texto),
    };
  }
  let material = um("SELECT * FROM pedido_material WHERE pedido_id = :id", { id }) ?? null;
  let tintaPorCor = todos(
    `SELECT t.cor, ROUND(SUM(t.kg), 2) AS kg FROM item_tinta t JOIN pedido_item i ON i.id = t.item_id WHERE i.pedido_id = :id GROUP BY t.cor ORDER BY kg DESC`,
    { id }
  );
  // Itens "Aguardando liberação" não passam pelo cálculo em lote da carteira: calcula na hora, só para mostrar no detalhe
  // (não entram nos totais da carteira, que são só dos itens liberados).
  const semCalculo = itens.filter((i) => i.status === 1 && !i.situacao);
  if (semCalculo.length) {
    const params = { ...PARAMETROS_PADRAO };
    for (const r of todos("SELECT chave, valor FROM parametro_calculo")) params[r.chave] = r.valor;
    const calculados = [];
    const cores = new Map();
    for (const i of semCalculo) {
      const r = calcularItem({ descricao: i.produto, unidade: i.unidade, quantidade: i.quantidade, textos: `${i.info_adicional} ${i.observacoes}` }, params);
      calculados.push(r);
      const partes = dividirTinta(r);
      for (const x of partes) cores.set(x.cor, (cores.get(x.cor) ?? 0) + x.kg);
      Object.assign(i, {
        categoria: r.categoria, situacao: r.situacao, metros: r.metros, faces: r.faces, bobina_kg: r.bobina_kg, eps_m: r.eps_m,
        cola_tubos: r.cola_tubos, tinta_kg: r.tinta_kg, aviso: r.aviso, tinta_cores: partes.map((x) => `${x.cor} ${x.kg.toFixed(1)} kg`).join(" · ") || null,
      });
    }
    if (!material) {
      material = { ...totalDoPedido(calculados), ao_vivo: true };
      tintaPorCor = [...cores].map(([cor, kg]) => ({ cor, kg: Math.round(kg * 100) / 100 })).sort((a, b) => b.kg - a.kg);
    }
  }
  const baixa = um("SELECT situacao, origem, motivo, baixado_em FROM baixa_pedido WHERE numero = :n", { n: p.numero }) ?? null;
  return { hoje, pedido: p, baixa, rota: comRota(p).rota, enderecos, entrada, financeiro: { ...resumoFin, situacao: situacaoFinanceira(resumoFin) }, itens, parcelas, contas, material, tintaPorCor };
}

function materiaisDaCarteira() {
  const total = um(
    `SELECT COUNT(*) AS pedidos, ROUND(SUM(bobina_kg)) AS bobina_kg, ROUND(SUM(eps_m_exato)) AS eps_exato, SUM(eps_m) AS eps_m,
            ROUND(SUM(cola_tubos_exato), 1) AS cola_exato, SUM(cola_tubos) AS cola_tubos, ROUND(SUM(tinta_kg)) AS tinta_kg,
            SUM(itens_a_revisar) AS itens_a_revisar, SUM(itens_sem_regra) AS itens_sem_regra
     FROM pedido_material m JOIN pedido p ON p.id = m.pedido_id WHERE p.liberado = 1 AND p.numero >= :minimo AND ${SEM_BAIXA}`,
    { minimo: MINIMO }
  );
  const porMes = todos(
    `SELECT substr(e.primeira_entrega, 1, 7) AS mes, COUNT(*) AS pedidos, ROUND(SUM(m.bobina_kg)) AS bobina_kg, SUM(m.eps_m) AS eps_m,
            SUM(m.cola_tubos) AS cola_tubos, ROUND(SUM(m.tinta_kg)) AS tinta_kg
     FROM pedido p JOIN pedido_material m ON m.pedido_id = p.id
     JOIN (SELECT pedido_id, MIN(data_entrega) AS primeira_entrega FROM pedido_item WHERE status = :liberado GROUP BY pedido_id) e ON e.pedido_id = p.id
     WHERE p.liberado = 1 AND p.numero >= :minimo AND ${SEM_BAIXA} GROUP BY mes ORDER BY mes`,
    { liberado: config.statusLiberado, minimo: MINIMO }
  );
  const porTipo = todos(
    `SELECT k.categoria, k.situacao, COUNT(*) AS itens, ROUND(SUM(k.metros)) AS metros, ROUND(SUM(k.bobina_kg)) AS bobina_kg,
            ROUND(SUM(k.eps_m)) AS eps_m, ROUND(SUM(k.cola_tubos), 1) AS cola_tubos, ROUND(SUM(k.tinta_kg)) AS tinta_kg
     FROM item_calculo k JOIN pedido p ON p.id = k.pedido_id WHERE p.liberado = 1 AND p.numero >= :minimo AND ${SEM_BAIXA} GROUP BY k.categoria, k.situacao ORDER BY itens DESC`,
    { minimo: MINIMO }
  );
  const paramsCalc = parametrosDeCalculo();
  for (const r of porTipo) {
    const c = chapasPorMetro(r.categoria, paramsCalc);
    r.metros_telha = r.metros;
    r.metros = r.metros == null || c === null ? r.metros : r.metros * c;
  }
  const tintaPorCor = todos(
    `SELECT t.cor, ROUND(SUM(t.kg), 1) AS kg, COUNT(DISTINCT t.item_id) AS itens
     FROM item_tinta t JOIN pedido_item i ON i.id = t.item_id JOIN pedido p ON p.id = i.pedido_id WHERE p.liberado = 1 AND p.numero >= :minimo AND ${SEM_BAIXA} GROUP BY t.cor ORDER BY kg DESC`,
    { minimo: MINIMO }
  );
  return { total, porMes, porTipo, tintaPorCor, porRota: resumoPorRota(materiaisPorPedido()) };
}

// Relação de material: uma linha por pedido (com valor total do pedido e tinta por cor).
function materiaisPorPedido() {
  return todos(
    `SELECT p.id, p.codigo, p.numero, c.nome AS cliente, c.municipio, c.uf, p.valor_total,
            (SELECT MIN(i.data_entrega) FROM pedido_item i WHERE i.pedido_id = p.id AND i.status = :liberado) AS primeira_entrega,
            -- metros = metragem de chapa (telha × chapas por metro: sanduíche e forro contam 2); a bobina é essa metragem × kg por metro
            (SELECT ROUND(SUM(k.metros * CASE k.categoria WHEN 'SANDUICHE' THEN :ch_sand WHEN 'FORRO' THEN :ch_forro WHEN 'SEMI' THEN :ch_semi ELSE :ch_simples END), 2)
               FROM item_calculo k WHERE k.pedido_id = p.id AND k.categoria IN ('SIMPLES', 'SEMI', 'SANDUICHE', 'FORRO')) AS metros,
            (SELECT ROUND(SUM(k.metros), 2) FROM item_calculo k WHERE k.pedido_id = p.id AND k.categoria IN ('SIMPLES', 'SEMI', 'SANDUICHE', 'FORRO')) AS metros_telha,
            m.bobina_kg, m.eps_m_exato, m.eps_m, m.cola_tubos_exato, m.cola_tubos, m.tinta_kg, m.itens_calculados, m.itens_a_revisar, m.itens_sem_regra,
            (SELECT group_concat(x.cor || ' ' || printf('%.1f', x.kg) || ' kg', ' · ')
               FROM (SELECT t.cor, SUM(t.kg) AS kg FROM item_tinta t JOIN pedido_item i ON i.id = t.item_id WHERE i.pedido_id = p.id GROUP BY t.cor ORDER BY SUM(t.kg) DESC) x) AS tinta_cores
     FROM pedido p
     LEFT JOIN cliente c ON c.id = p.id_cliente
     LEFT JOIN pedido_material m ON m.pedido_id = p.id
     WHERE p.liberado = 1 AND p.numero >= :minimo AND ${SEM_BAIXA}
     ORDER BY p.numero`,
    (() => {
      const c = parametrosDeCalculo();
      return { liberado: config.statusLiberado, minimo: MINIMO, ch_sand: c.chapas_sanduiche, ch_forro: c.chapas_forro, ch_semi: c.chapas_semi, ch_simples: c.chapas_simples };
    })()
  ).map(comRota);
}

// Totais por rota de entrega (soma da relação por pedido; pedidos de cidade fora da tabela de rotas ficam em "Sem rota").
function resumoPorRota(pedidos) {
  const grupos = new Map();
  for (const p of pedidos) {
    const chave = p.rota_numero ?? 0;
    const g = grupos.get(chave) ?? { rota_numero: p.rota_numero, rota: p.rota, pedidos: 0, valor_total: 0, metros: 0, bobina_kg: 0, eps_m: 0, cola_tubos: 0, tinta_kg: 0 };
    g.pedidos++;
    for (const k of ["valor_total", "metros", "bobina_kg", "eps_m", "cola_tubos", "tinta_kg"]) g[k] += p[k] || 0;
    grupos.set(chave, g);
  }
  return [...grupos.values()].sort((a, b) => (a.rota_numero ?? 999) - (b.rota_numero ?? 999));
}

// Relação de material: uma linha por item liberado (sem os itens de revenda, que não consomem bobina, EPS, cola nem tinta).
function materiaisPorItem() {
  const params = parametrosDeCalculo();
  const itens = todos(
    `SELECT p.id AS pedido_id, p.codigo, p.numero, c.nome AS cliente, c.municipio, c.uf, i.id AS item_id, i.item, pr.descricao AS produto, i.data_entrega,
            k.categoria, k.situacao, k.metros, k.faces, k.bobina_kg, k.eps_m, k.cola_tubos, k.tinta_kg, k.aviso,
            (SELECT group_concat(t.cor || ' ' || printf('%.1f', t.kg) || ' kg', ' · ') FROM item_tinta t WHERE t.item_id = i.id) AS tinta_cores
     FROM item_calculo k
     JOIN pedido_item i ON i.id = k.item_id
     JOIN pedido p ON p.id = k.pedido_id
     LEFT JOIN cliente c ON c.id = p.id_cliente
     LEFT JOIN produto pr ON pr.id = i.id_produto
     WHERE p.liberado = 1 AND p.numero >= :minimo AND ${SEM_BAIXA} AND k.situacao <> 'revenda'
     ORDER BY p.numero, i.id`,
    { minimo: MINIMO }
  ).map(comRota).map((r) => {
    // metros = metragem de chapa (com a 2ª chapa da sanduíche e do forro); metros_telha = metros da própria telha
    const c = chapasPorMetro(r.categoria, params);
    return { ...r, metros_telha: r.metros, metros: r.metros == null || c === null ? r.metros : r.metros * c };
  });
  const revenda = um(
    `SELECT COUNT(*) AS n FROM item_calculo k JOIN pedido p ON p.id = k.pedido_id WHERE p.liberado = 1 AND p.numero >= :minimo AND ${SEM_BAIXA} AND k.situacao = 'revenda'`,
    { minimo: MINIMO }
  );
  return { itens, itensDeRevenda: revenda.n };
}

function infoSincronizacao() {
  const ultima = um("SELECT id, iniciado_em, finalizado_em, status, etapas, erro FROM sync_run WHERE status IN ('ok','parcial') AND etapas LIKE '%pedidos%' ORDER BY id DESC LIMIT 1");
  const calculo = um("SELECT MAX(calculado_em) AS em FROM pedido_material");
  const escondidos = um("SELECT COUNT(*) AS n FROM pedido WHERE liberado = 1 AND numero < :minimo", { minimo: MINIMO });
  return { ultimaSincronizacao: ultima ?? null, calculadoEm: calculo?.em ?? null, hoje: hojeLocal(), pedidoMinimo: MINIMO, pedidosEscondidos: escondidos.n };
}

// Perguntas ao assistente rodam em segundo plano: a resposta pode levar minutos, mais do que os limites de tempo dos servidores no
// caminho (o navegador fala com a intranet, que repassa para cá). O POST devolve um número na hora e a tela pergunta o andamento.
const perguntas = new Map(); // id -> { situacao: "processando" | "pronto" | "erro", criadaEm, resultado?, status?, erro? }
const GUARDAR_PERGUNTA_MS = 20 * 60_000;
const MAX_PERGUNTAS_SIMULTANEAS = 4;
function iniciarPergunta(mensagens) {
  for (const [id, p] of perguntas) if (p.situacao !== "processando" && Date.now() - p.criadaEm > GUARDAR_PERGUNTA_MS) perguntas.delete(id);
  if ([...perguntas.values()].filter((p) => p.situacao === "processando").length >= MAX_PERGUNTAS_SIMULTANEAS) {
    throw new ErroAssistente("O assistente já está respondendo várias perguntas. Aguarde um pouco e envie de novo.", 429);
  }
  const id = randomUUID();
  const pergunta = { situacao: "processando", criadaEm: Date.now() };
  perguntas.set(id, pergunta);
  assistente.conversar(mensagens)
    .then((resultado) => Object.assign(pergunta, { situacao: "pronto", resultado }))
    .catch((erro) => {
      if (!(erro instanceof ErroAssistente)) console.error("[assistente]", erro);
      Object.assign(pergunta, { situacao: "erro", status: erro instanceof ErroAssistente ? erro.status : 500, erro: erro instanceof ErroAssistente ? erro.message : "Falha inesperada no assistente." });
    });
  return id;
}

function enviarJson(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(texto);
}

const servidor = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    // Só atende quem acessa por localhost/127.0.0.1 (impede que um site qualquer, via rebind de DNS, leia a tela).
    if (!HOSTS_ACEITOS.has(String(req.headers.host ?? "").split(":")[0].toLowerCase())) return enviarJson(res, 403, { erro: "Acesso negado." });
    if (!tokenConfere(req.headers["x-pedidos-token"])) return enviarJson(res, 401, { erro: "Acesso negado." });
    if (req.method === "POST" && url.pathname === "/api/atualizar") {
      // O único POST: pede uma atualização. Exige o cabeçalho próprio e a mesma origem (proteção contra requisições de outros sites).
      const origem = req.headers.origin;
      const mesmaOrigem = !origem || new URL(origem).host === req.headers.host;
      if (req.headers["x-pedidos"] !== "1" || !mesmaOrigem) return enviarJson(res, 403, { erro: "Requisição não permitida." });
      const iniciou = atualizador.iniciar("manual");
      return enviarJson(res, iniciou ? 202 : 409, iniciou ? { iniciada: true } : { erro: "Já há uma atualização em andamento." });
    }
    if (req.method === "POST" && url.pathname === "/api/baixa") {
      // Dar baixa / reabrir um pedido NA TELA (local; o Nomus não é alterado). Mesma proteção das outras rotas de escrita.
      const origem = req.headers.origin;
      const mesmaOrigem = !origem || new URL(origem).host === req.headers.host;
      if (req.headers["x-pedidos"] !== "1" || !mesmaOrigem) return enviarJson(res, 403, { erro: "Requisição não permitida." });
      lerCorpoJson(req, 5_000)
        .then((c) => {
          const numero = Number(c.numero);
          if (!Number.isInteger(numero) || numero < 1 || numero > 99999) throw new ErroAssistente("Número de pedido inválido.", 400);
          const w = escrita();
          if (c.acao === "reabrir") {
            const r = w.prepare("DELETE FROM baixa_pedido WHERE numero = ?").run(numero);
            return { ok: true, acao: "reabrir", alterados: Number(r.changes) };
          }
          if (c.acao !== "baixar") throw new ErroAssistente("Ação inválida (use baixar ou reabrir).", 400);
          if (!w.prepare("SELECT 1 FROM pedido WHERE numero = ? AND (liberado = 1 OR aguardando = 1)").get(numero)) throw new ErroAssistente("Esse pedido não está na carteira nem na fila de aguardando.", 404);
          const situacao = ["entregue", "cancelado"].includes(c.situacao) ? c.situacao : "entregue";
          w.prepare("INSERT OR REPLACE INTO baixa_pedido (numero, situacao, origem, motivo, baixado_em) VALUES (?, ?, 'manual', ?, ?)").run(numero, situacao, String(c.motivo ?? "").slice(0, 200), new Date().toISOString());
          return { ok: true, acao: "baixar", alterados: 1 };
        })
        .then((r) => enviarJson(res, 200, r))
        .catch((erro) => enviarJson(res, erro instanceof ErroAssistente ? erro.status : 500, { erro: erro instanceof ErroAssistente ? erro.message : "Falha ao gravar a baixa." }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/assistente") {
      // Mesma proteção do botão de atualizar: cabeçalho próprio + mesma origem.
      const origem = req.headers.origin;
      const mesmaOrigem = !origem || new URL(origem).host === req.headers.host;
      if (req.headers["x-pedidos"] !== "1" || !mesmaOrigem) return enviarJson(res, 403, { erro: "Requisição não permitida." });
      lerCorpoJson(req)
        .then((corpo) => enviarJson(res, 202, { id: iniciarPergunta(corpo.mensagens) }))
        .catch((erro) => {
          if (!(erro instanceof ErroAssistente)) console.error("[assistente]", erro);
          enviarJson(res, erro instanceof ErroAssistente ? erro.status : 500, { erro: erro instanceof ErroAssistente ? erro.message : "Falha inesperada no assistente." });
        });
      return;
    }
    if (req.method !== "GET") return enviarJson(res, 405, { erro: "Método não permitido." });
    if (url.pathname === "/api/assistente/estado") return enviarJson(res, 200, assistente.estado());
    const andamento = /^\/api\/assistente\/pergunta\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (andamento) {
      const p = perguntas.get(andamento[1]);
      if (!p) return enviarJson(res, 404, { erro: "Essa pergunta se perdeu (o serviço reiniciou). Envie de novo." });
      if (p.situacao === "processando") return enviarJson(res, 200, { situacao: p.situacao, segundos: Math.round((Date.now() - p.criadaEm) / 1000) });
      if (p.situacao === "erro") return enviarJson(res, 200, { situacao: p.situacao, status: p.status, erro: p.erro });
      return enviarJson(res, 200, { situacao: p.situacao, ...p.resultado });
    }
    if (url.pathname === "/api/atualizacao") return enviarJson(res, 200, atualizador.estado());
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return res.end(readFileSync(PAGINA));
    }
    if (url.pathname === "/api/pedidos") {
      const e = url.searchParams.get("encerrados");
      return enviarJson(res, 200, listaPedidos(e === "so" ? "so" : e === "todos" ? "todos" : "nao"));
    }
    if (url.pathname === "/api/aguardando") return enviarJson(res, 200, listaAguardando());
    const m = /^\/api\/pedidos\/(\d+)$/.exec(url.pathname);
    if (m) {
      const d = detalhePedido(Number(m[1]));
      return d ? enviarJson(res, 200, d) : enviarJson(res, 404, { erro: "Pedido não encontrado." });
    }
    if (url.pathname === "/api/materiais") return enviarJson(res, 200, materiaisDaCarteira());
    if (url.pathname === "/api/materiais/pedidos") return enviarJson(res, 200, { pedidos: materiaisPorPedido() });
    if (url.pathname === "/api/materiais/itens") return enviarJson(res, 200, materiaisPorItem());
    if (url.pathname === "/api/sync") return enviarJson(res, 200, infoSincronizacao());
    return enviarJson(res, 404, { erro: "Não encontrado." });
  } catch (erro) {
    console.error(erro);
    return enviarJson(res, 500, { erro: "Falha ao ler o banco local.", detalhe: String(erro?.message ?? erro) });
  }
});

servidor.listen(PORTA, HOST, () => {
  console.log(`Pedidos em aberto: http://${HOST}:${PORTA}  (banco: ${config.arquivoBanco}${config.acessoToken ? ", com token" : ""})`);
  atualizador.agendar();
});
