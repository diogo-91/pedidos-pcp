import test from "node:test";
import assert from "node:assert/strict";
import { criarFerramentas, selecionarParaMeta } from "../src/assistente-ferramentas.mjs";

const cand = (valores) => valores.map((valor, i) => ({ valor, data_ref: `2026-0${(i % 9) + 1}-01`, p: { codigo: `PD ${i + 1}` } }));
const soma = (l) => Math.round(l.reduce((t, c) => t + c.valor, 0) * 100) / 100;

test("acha a combinação exata quando existe", () => {
  const r = selecionarParaMeta(cand([35305.92, 12670.4, 47329.2, 4695, 9000, 20000]), 100000);
  // 35.305,92 + 12.670,40 + 47.329,20 + 4.695,00 = 100.000,52: fecha em reais inteiros; os centavos sobram e são informados
  assert.ok(Math.abs(soma(r.abaixo) - 100000) < 1);
});

test("prefere menos pedidos entre as combinações exatas", () => {
  // 60k + 40k (2 pedidos) ou 20k×5 (5 pedidos): deve escolher 2
  const r = selecionarParaMeta(cand([60000, 40000, 20000, 20000, 20000, 20000, 20000]), 100000);
  assert.equal(r.abaixo.length, 2);
});

test("sem passar da meta e passando: devolve as duas aproximações", () => {
  const r = selecionarParaMeta(cand([30000, 30000, 30000, 45000]), 100000);
  assert.ok(soma(r.abaixo) <= 100000.5);
  assert.ok(soma(r.acima) >= 99999.5);
});

test("mais_antigos prioriza os de data mais antiga", () => {
  const lista = [
    { valor: 50000, data_ref: "2026-11-01", p: { codigo: "NOVO" } },
    { valor: 50000, data_ref: "2026-01-01", p: { codigo: "VELHO" } },
    { valor: 50000, data_ref: "2026-06-01", p: { codigo: "MEIO" } },
  ];
  const r = selecionarParaMeta(lista, 100000, "mais_antigos");
  const codigos = r.abaixo.map((c) => c.p.codigo).sort();
  assert.deepEqual(codigos, ["MEIO", "VELHO"]);
});

test("meta inalcançável não quebra", () => {
  const r = selecionarParaMeta(cand([100, 200]), 100000);
  assert.ok(r.abaixo === null || soma(r.abaixo) < 100000);
});

// ---- ferramentas com dados falsos
const pedido = (n, saldo, vencido, extra = {}) => ({
  id: n, numero: n, codigo: `PD ${String(n).padStart(5, "0")}`, cliente: `Cliente ${n}`, municipio: "Sorocaba", uf: "SP", rota: "Rota 1", rota_numero: 1,
  valor_total: saldo * 2, recebido: saldo, saldo, vencido, financeiro: vencido > 0 ? "vencido" : "a_vencer", proximo_vencimento: "2026-10-01", primeira_entrega: "2026-11-01",
  data_emissao: "2026-09-01", telefone: "15 99999-0000", endereco_completo: "Rua Secreta, 1", ...extra,
});
const dados = {
  listaPedidos: () => ({ hoje: "2026-11-24", pedidos: [pedido(1500, 60000, 60000), pedido(1501, 40000, 0), pedido(1502, 20000, 20000)] }),
  listaEncerrados: () => ({ hoje: "2026-11-24", pedidos: [] }),
  listaAguardando: () => ({ hoje: "2026-11-24", pedidos: [pedido(1600, 5000, 5000, { dias_aguardando: 10 })] }),
  detalhePedido: () => { throw new Error("não usado"); },
  materiaisDaCarteira: () => ({ total: {}, porMes: [], porRota: [], porTipo: [], tintaPorCor: [] }),
  materiaisPorPedido: () => [],
};

test("buscar_pedidos filtra, soma e não vaza telefone nem endereço", () => {
  const f = criarFerramentas(dados);
  const r = f.executar("buscar_pedidos", { situacao_financeira: "vencido", ordenar_por: "saldo", ordem: "decrescente" });
  assert.equal(r.total_encontrado, 2);
  assert.equal(r.soma_saldo_a_receber, 80000);
  assert.equal(r.pedidos[0].codigo, "PD 01500");
  assert.ok(!JSON.stringify(r).includes("99999"));
  assert.ok(!JSON.stringify(r).includes("Secreta"));
});

test("montar_carteira_para_meta usa a base pedida e informa a diferença", () => {
  const f = criarFerramentas(dados);
  const r = f.executar("montar_carteira_para_meta", { meta: 100000, base: "saldo" });
  assert.equal(r.opcoes[0].soma_pela_base, 100000);
  assert.equal(r.opcoes[0].diferenca_para_a_meta, 0);
  assert.equal(r.opcoes[0].quantidade_de_pedidos, 2); // 60k + 40k
});

test("ferramenta desconhecida ou parâmetro ruim devolve erro em vez de quebrar", () => {
  const f = criarFerramentas(dados);
  assert.ok(f.executar("nao_existe", {}).erro);
  assert.ok(f.executar("montar_carteira_para_meta", { meta: -5 }).erro);
  assert.ok(f.executar("detalhe_pedido", {}).erro);
});

test("a definição das ferramentas está no formato de function calling", () => {
  const api = criarFerramentas(dados).paraApi();
  assert.ok(api.length >= 5);
  for (const t of api) { assert.equal(t.type, "function"); assert.ok(t.function.name && t.function.parameters.type === "object"); }
});

test("resumo_por_grupo agrega por rota numa chamada só, ordenado pelo vencido", () => {
  const d2 = {
    ...dados,
    listaPedidos: () => ({
      hoje: "2026-11-24",
      pedidos: [
        pedido(1500, 60000, 60000, { rota: "Rota 1", rota_numero: 1 }),
        pedido(1501, 40000, 10000, { rota: "Rota 1", rota_numero: 1 }),
        pedido(1502, 20000, 20000, { rota: "Rota 2", rota_numero: 2 }),
      ],
    }),
  };
  const r = criarFerramentas(d2).executar("resumo_por_grupo", { agrupar_por: "rota" });
  assert.equal(r.grupos[0].grupo, "Rota 1");
  assert.equal(r.grupos[0].vencido, 70000);
  assert.equal(r.grupos[0].pedidos, 2);
  assert.equal(r.grupos[1].grupo, "Rota 2");
  assert.ok(criarFerramentas(d2).executar("resumo_por_grupo", { agrupar_por: "xyz" }).erro);
});

test("atraso_minimo_dias filtra pelo atraso da primeira entrega", () => {
  const d3 = {
    ...dados,
    listaPedidos: () => ({
      hoje: "2026-11-24",
      pedidos: [
        pedido(1500, 100, 0, { primeira_entrega: "2026-10-01" }), // 54 dias
        pedido(1501, 100, 0, { primeira_entrega: "2026-11-20" }), // 4 dias
        pedido(1502, 100, 0, { primeira_entrega: "2026-12-10" }), // no futuro
      ],
    }),
  };
  const r = criarFerramentas(d3).executar("buscar_pedidos", { atraso_minimo_dias: 30 });
  assert.deepEqual(r.pedidos.map((p) => p.codigo), ["PD 01500"]);
});
