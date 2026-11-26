// Consulta livre do assistente de IA ao NOSSO banco (nunca ao Nomus): uma cópia só para consulta, montada a partir do banco local,
// com tabelas simples e SEM dados pessoais (telefone, endereço, CEP, CPF/CNPJ, e-mail e o JSON bruto da API não existem nela).
//
// Proteções:
//  - o SQL da IA roda na cópia, aberta somente para leitura: mesmo um comando indevido não alcança o banco de verdade;
//  - só SELECT / WITH (assim não há ATTACH, que abriria outro arquivo, nem PRAGMA);
//  - roda num processo separado, com tempo máximo: uma consulta que não termina é interrompida sem travar o servidor;
//  - no máximo 200 linhas por consulta.
import { execFile } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const EXECUTOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "consulta-executor.mjs");
const TEMPO_MAXIMO_MS = 6_000;
const PREFIXO = "consulta-ia-";
const STATUS_ITEM = { 1: "aguardando liberação", 2: "liberado", 3: "atendido parcialmente", 4: "atendido totalmente" };

/** Esconde dados pessoais que alguém tenha digitado em texto livre (observações, medidas). */
export function ocultarDadosPessoais(texto) {
  return String(texto ?? "")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[oculto]")
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}\b/g, "[oculto]") // CNPJ
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, "[oculto]") // CPF
    .replace(/\+55[\d\s().-]{9,15}\d/g, "[oculto]")
    .replace(/\(\d{2}\)\s?9?\s?\d{4}[-.\s]?\d{4}/g, "[oculto]")
    .replace(/\b(\d{2}\s)?9?\d{4}-\d{4}\b/g, "[oculto]")
    .replace(/\b\d{10,14}\b/g, "[oculto]");
}

/** Descrição das tabelas, enviada à IA junto com a ferramenta. */
export const ESQUEMA_CONSULTA = `Tabelas (SQLite):
pedidos(numero, codigo, grupo ['liberado'=carteira em aberto | 'aguardando'=aguardando liberação | 'encerrado'=entregue/cancelado], cliente, cidade, uf, rota_numero, rota, data_emissao, primeira_entrega, dias_para_entrega [negativo=atrasado], valor_total, recebido, saldo_a_receber, vencido, situacao_financeira ['vencido'|'a_vencer'|'quitado'|'sem_titulo'], proximo_vencimento, entrada_rotulo, entrada_valor, entrada_paga [0/1], entrada_vencimento, bobina_kg, eps_m, cola_tubos, tinta_kg, itens_a_revisar, itens_sem_regra, tipos_de_telha, condicao_pagamento, encerrado_situacao, encerrado_em, observacoes)
itens(pedido_numero, produto_codigo, produto, unidade, status_item, quantidade, valor_unitario, data_entrega, medidas_texto, categoria ['SIMPLES'|'SANDUICHE'|'SEMI'|'FORRO'|'FORRO_PVC'|'PAINEL'|'ACESSORIO'|'SERVICO_PINTURA'|'REVENDA'|'SEM_PRODUTO'], situacao_calculo, metros_telha, faces_pintadas, bobina_kg, eps_m, cola_tubos, tinta_kg, aviso_calculo)
tintas(pedido_numero, cor, kg)
titulos(pedido_numero, descricao, valor, recebido, saldo, data_vencimento, data_baixa, paga [0/1], forma_pagamento)
parcelas_previstas(pedido_numero, parcela, valor, data_vencimento, observacao, forma_pagamento)
atualizacao(dados_do_nomus_em, hoje)
Datas em 'aaaa-mm-dd'; valores em reais; um pedido aparece uma vez em pedidos. NÃO existem no banco: vendedor, estoque de matéria-prima, preços de compra, ordens de produção.`;

export function criarConsulta({ arquivoBanco, todos, listaPedidos, listaAguardando }) {
  const pasta = path.dirname(arquivoBanco);
  let atual = null; // { assinatura, arquivo }
  let versao = 0;

  /** Muda quando chegam dados novos do Nomus, quando há baixa/reabertura de pedido ou quando vira o dia. */
  const assinatura = (hoje) => JSON.stringify([
    hoje,
    todos("SELECT id, status, finalizado_em FROM sync_run ORDER BY id DESC LIMIT 1")[0] ?? null,
    todos("SELECT COUNT(*) AS n, MAX(baixado_em) AS m FROM baixa_pedido")[0],
  ]);

  function montar() {
    const abertos = listaPedidos("nao");
    const marca = assinatura(abertos.hoje);
    if (atual?.assinatura === marca) return atual.arquivo;

    const arquivo = path.join(pasta, `${PREFIXO}${process.pid}-${++versao}.sqlite`);
    rmSync(arquivo, { force: true });
    const copia = new DatabaseSync(arquivo);
    try {
      copia.exec(`
        PRAGMA journal_mode = OFF;
        CREATE TABLE pedidos (numero INTEGER PRIMARY KEY, codigo TEXT, grupo TEXT, cliente TEXT, cidade TEXT, uf TEXT, rota_numero INTEGER, rota TEXT, data_emissao TEXT, primeira_entrega TEXT, dias_para_entrega INTEGER, valor_total REAL, recebido REAL, saldo_a_receber REAL, vencido REAL, situacao_financeira TEXT, proximo_vencimento TEXT, entrada_rotulo TEXT, entrada_valor REAL, entrada_paga INTEGER, entrada_vencimento TEXT, bobina_kg REAL, eps_m REAL, cola_tubos REAL, tinta_kg REAL, itens_a_revisar INTEGER, itens_sem_regra INTEGER, tipos_de_telha TEXT, condicao_pagamento TEXT, encerrado_situacao TEXT, encerrado_em TEXT, observacoes TEXT);
        CREATE TABLE itens (pedido_numero INTEGER, produto_codigo TEXT, produto TEXT, unidade TEXT, status_item TEXT, quantidade REAL, valor_unitario REAL, data_entrega TEXT, medidas_texto TEXT, categoria TEXT, situacao_calculo TEXT, metros_telha REAL, faces_pintadas INTEGER, bobina_kg REAL, eps_m REAL, cola_tubos REAL, tinta_kg REAL, aviso_calculo TEXT);
        CREATE TABLE tintas (pedido_numero INTEGER, cor TEXT, kg REAL);
        CREATE TABLE titulos (pedido_numero INTEGER, descricao TEXT, valor REAL, recebido REAL, saldo REAL, data_vencimento TEXT, data_baixa TEXT, paga INTEGER, forma_pagamento TEXT);
        CREATE TABLE parcelas_previstas (pedido_numero INTEGER, parcela INTEGER, valor REAL, data_vencimento TEXT, observacao TEXT, forma_pagamento TEXT);
        CREATE TABLE atualizacao (dados_do_nomus_em TEXT, hoje TEXT);
        CREATE INDEX i_itens ON itens (pedido_numero); CREATE INDEX i_titulos ON titulos (pedido_numero);
        BEGIN;`);
      const inserir = (tabela, colunas) => copia.prepare(`INSERT OR IGNORE INTO ${tabela} VALUES (${"?,".repeat(colunas - 1)}?)`);
      const nulo = (v) => v ?? null;

      const hoje = abertos.hoje;
      const dias = (d) => (d ? Math.round((Date.parse(d.slice(0, 10)) - Date.parse(hoje)) / 86400000) : null);
      const observacoes = new Map(todos("SELECT numero, observacoes, observacoes_internas FROM pedido").map((p) => [p.numero, ocultarDadosPessoais([p.observacoes, p.observacoes_internas].filter(Boolean).join(" | ")).slice(0, 1000)]));
      const pedido = inserir("pedidos", 32);
      const incluidos = new Set();
      // Ordem de prioridade quando o mesmo pedido aparece em mais de uma lista: carteira, encerrado, aguardando.
      for (const [grupo, lista] of [["liberado", abertos.pedidos], ["encerrado", listaPedidos("so").pedidos], ["aguardando", listaAguardando().pedidos]]) {
        for (const p of lista) {
          if (incluidos.has(p.numero)) continue;
          incluidos.add(p.numero);
          pedido.run(p.numero, p.codigo, grupo, nulo(p.cliente), nulo(p.municipio), nulo(p.uf), nulo(p.rota_numero), nulo(p.rota), nulo(p.data_emissao), nulo(p.primeira_entrega), dias(p.primeira_entrega),
            nulo(p.valor_total), nulo(p.recebido), nulo(p.saldo), nulo(p.vencido), nulo(p.financeiro), nulo(p.proximo_vencimento), ocultarDadosPessoais(p.entrada_rotulo), nulo(p.entrada_valor), nulo(p.entrada_paga), nulo(p.entrada_vencimento),
            nulo(p.bobina_kg), nulo(p.eps_m), nulo(p.cola_tubos), nulo(p.tinta_kg), nulo(p.itens_a_revisar), nulo(p.itens_sem_regra), nulo(p.tipos), nulo(p.condicao_pagamento), nulo(p.baixa_situacao), nulo(p.baixa_em), observacoes.get(p.numero) ?? "");
        }
      }

      const item = inserir("itens", 18);
      for (const i of todos(
        `SELECT p.numero, pr.codigo, pr.descricao, pr.unidade, i.status, i.quantidade, i.valor_unitario, i.data_entrega, i.info_adicional, i.item, k.categoria, k.situacao, k.metros, k.faces, k.bobina_kg, k.eps_m, k.cola_tubos, k.tinta_kg, k.aviso
         FROM pedido_item i JOIN pedido p ON p.id = i.pedido_id LEFT JOIN produto pr ON pr.id = i.id_produto LEFT JOIN item_calculo k ON k.item_id = i.id`)) {
        if (!incluidos.has(i.numero)) continue;
        item.run(i.numero, nulo(i.codigo), nulo(i.descricao), nulo(i.unidade), STATUS_ITEM[i.status] ?? String(i.status ?? ""), nulo(i.quantidade), nulo(i.valor_unitario), nulo(i.data_entrega),
          ocultarDadosPessoais([i.item, i.info_adicional].filter(Boolean).join(" | ")).slice(0, 500), nulo(i.categoria), nulo(i.situacao), nulo(i.metros), nulo(i.faces), nulo(i.bobina_kg), nulo(i.eps_m), nulo(i.cola_tubos), nulo(i.tinta_kg), nulo(i.aviso));
      }
      const tinta = inserir("tintas", 3);
      for (const t of todos("SELECT p.numero, t.cor, SUM(t.kg) AS kg FROM item_tinta t JOIN pedido_item i ON i.id = t.item_id JOIN pedido p ON p.id = i.pedido_id GROUP BY p.numero, t.cor")) if (incluidos.has(t.numero)) tinta.run(t.numero, t.cor, t.kg);
      const titulo = inserir("titulos", 9);
      for (const c of todos("SELECT pedido_numero, descricao, valor, recebido, saldo, data_vencimento, data_baixa, quitada, forma_pagamento FROM conta_receber")) {
        if (incluidos.has(c.pedido_numero)) titulo.run(c.pedido_numero, c.descricao, nulo(c.valor), nulo(c.recebido), nulo(c.saldo), nulo(c.data_vencimento), nulo(c.data_baixa), nulo(c.quitada), nulo(c.forma_pagamento));
      }
      const parcela = inserir("parcelas_previstas", 6);
      for (const x of todos("SELECT p.numero, x.seq, x.valor, x.data_vencimento, x.observacao, fp.nome AS forma FROM pedido_parcela x JOIN pedido p ON p.id = x.pedido_id LEFT JOIN forma_pagamento fp ON fp.id = x.id_forma_pagamento")) {
        if (incluidos.has(x.numero)) parcela.run(x.numero, x.seq, nulo(x.valor), nulo(x.data_vencimento), ocultarDadosPessoais(x.observacao), nulo(x.forma));
      }
      const sinc = todos("SELECT finalizado_em FROM sync_run WHERE status IN ('ok','parcial') ORDER BY id DESC LIMIT 1")[0];
      inserir("atualizacao", 2).run(sinc?.finalizado_em ?? null, hoje);
      copia.exec("COMMIT");
    } finally {
      copia.close();
    }
    atual = { assinatura: marca, arquivo };
    // Apaga cópias antigas (inclusive de execuções anteriores); a que estiver em uso fica para a próxima vez.
    for (const nome of readdirSync(pasta)) {
      if (nome.startsWith(PREFIXO) && path.join(pasta, nome) !== arquivo) try { rmSync(path.join(pasta, nome), { force: true }); } catch { /* em uso */ }
    }
    return arquivo;
  }

  return async function consultar(sql) {
    const texto = String(sql ?? "").trim().replace(/;\s*$/, "");
    if (!/^(select|with)\b/i.test(texto)) return { erro: "Só consultas de leitura: comece com SELECT ou WITH." };
    if (texto.length > 6000) return { erro: "Consulta grande demais." };
    const arquivo = montar();
    return new Promise((resolver) => {
      const processo = execFile(process.execPath, ["--no-warnings", EXECUTOR, arquivo], { timeout: TEMPO_MAXIMO_MS, maxBuffer: 2_000_000, env: {}, windowsHide: true }, (erro, saida) => {
        if (erro) return resolver({ erro: erro.killed ? "A consulta demorou demais e foi interrompida. Simplifique-a (filtre ou agrupe)." : "Não foi possível executar a consulta." });
        try {
          resolver(JSON.parse(saida));
        } catch {
          resolver({ erro: "Resposta inválida da consulta." });
        }
      });
      processo.stdin.end(texto);
    });
  };
}
