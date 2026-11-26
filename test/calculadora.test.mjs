import test from "node:test";
import assert from "node:assert/strict";
import { calcularExpressao, fifoDeEstoque } from "../src/calculadora.mjs";
import { criarFerramentas } from "../src/assistente-ferramentas.mjs";

test("calculadora: precedência, potência, percentual e funções", () => {
  assert.equal(calcularExpressao("2 + 3 * 4"), 14);
  assert.equal(calcularExpressao("-2 ^ 2"), -4);
  assert.equal(calcularExpressao("2 ^ 3 ^ 2"), 512);
  assert.equal(calcularExpressao("15% * 200"), 30);
  assert.equal(calcularExpressao("0.1 + 0.2"), 0.3);
  assert.equal(calcularExpressao("soma(1; 2; 3) + media(2, 4)"), 9);
  assert.equal(calcularExpressao("arred(10 / 3; 2)"), 3.33);
  assert.equal(calcularExpressao("teto(82.4 * 2 / 50)"), 4);
});

test("calculadora: recusa o que não é conta", () => {
  for (const ruim of ["process.exit(1)", "1 / 0", "2 +", "3,5 * 2", "1 000 + 1", "constructor(1)", "toString(1)", "(".repeat(300) + "1" + ")".repeat(300)]) {
    assert.throws(() => calcularExpressao(ruim), ruim);
  }
});

test("FIFO de estoque consome o lote mais antigo primeiro", () => {
  const r = fifoDeEstoque(
    [{ lote: "B", data: "2026-02-01", quantidade: 100, custo_unitario: 12 }, { lote: "A", data: "2026-01-01", quantidade: 100, custo_unitario: 10 }],
    [{ quantidade: 150 }]
  );
  assert.deepEqual(r.saidas[0].consumo.map((c) => [c.lote, c.quantidade]), [["A", 100], ["B", 50]]);
  assert.equal(r.saidas[0].custo_total, 1600);
  assert.equal(r.estoque_final.quantidade, 50);
  assert.equal(r.estoque_final.valor, 600);
});

test("FIFO de estoque informa a falta e não usa lote que ainda não entrou", () => {
  const r = fifoDeEstoque(
    [{ data: "2026-01-01", quantidade: 10, custo_unitario: 5 }, { data: "2026-03-01", quantidade: 10, custo_unitario: 6 }],
    [{ data: "2026-02-01", quantidade: 15 }]
  );
  assert.equal(r.saidas[0].quantidade_atendida, 10);
  assert.equal(r.saidas[0].falta_estoque, 5);
});

const pedido = (numero, data, saldo, kg) => ({ numero, codigo: `PD ${numero}`, cliente: "C", data_emissao: data, saldo, bobina_kg: kg, financeiro: "a_vencer" });
const ferramentas = criarFerramentas({
  listaPedidos: () => ({ hoje: "2026-11-26", pedidos: [pedido(3, "2026-11-03", 300, 10), pedido(1, "2026-11-01", 100, 60), pedido(2, "2026-11-02", 200, 50), pedido(4, "2026-11-04", 400, 0)] }),
});

test("fila FIFO estrita para no primeiro que não cabe na bobina", () => {
  const r = ferramentas.executar("fila_fifo", { bobina_disponivel_kg: 80 });
  assert.deepEqual(r.pedidos.map((p) => p.codigo), ["PD 1"]);
  assert.equal(r.parou_em.codigo, "PD 2");
  assert.equal(r.bobina_sobra_kg, 20);
});

test("fila FIFO pulando quem não cabe, e parando na meta", () => {
  const pulando = ferramentas.executar("fila_fifo", { bobina_disponivel_kg: 80, quando_nao_couber: "pular" });
  assert.deepEqual(pulando.pedidos.map((p) => p.codigo), ["PD 1", "PD 3"]);
  const meta = ferramentas.executar("fila_fifo", { meta_valor: 250 });
  assert.deepEqual(meta.pedidos.map((p) => p.codigo), ["PD 1", "PD 2"]);
  assert.equal(meta.meta_atingida, true);
});
