import test from "node:test";
import assert from "node:assert/strict";
import { calcularItem, categoriaDoProduto, coresDoTexto, facesDoProduto, totalDoPedido } from "../src/calculo.mjs";

const telha = (descricao, quantidade, textos = "") => calcularItem({ descricao, quantidade, unidade: "M2", textos });

// Exemplos dos áudios do PCP: 5 telhas de 5 metros = 25.
test("telha simples, 1 face: bobina 25×3,2; sem EPS nem cola; tinta 25÷5", () => {
  const r = telha("TELHA SIMPLES TR25 - 1020mm - (GALVALUME) - UMA FACE PINTADA", 25);
  assert.equal(r.categoria, "SIMPLES");
  assert.equal(r.bobina_kg, 80);
  assert.equal(r.eps_m, 0);
  assert.equal(r.cola_tubos, 0);
  assert.equal(r.tinta_kg, 5);
});

test("telha simples, 2 faces: tinta dobra (50÷5 = 10 kg)", () => {
  const r = telha("TELHA SIMPLES TR25 - 1020mm - (GALVALUME) - DUAS FACES PINTADAS", 25);
  assert.equal(r.tinta_kg, 10);
});

test("sanduíche: bobina 25×2×3,2; EPS 25; cola 25×2÷50 = 1 tubo; tinta 1 face = 5 kg", () => {
  const r = telha("TELHA SANDUICHE TR25 - 1020mm - (GALVALUME) - UMA FACE PINTADA", 25);
  assert.equal(r.bobina_kg, 160);
  assert.equal(r.eps_m, 25);
  assert.equal(r.cola_tubos, 1);
  assert.equal(r.tinta_kg, 5);
});

test("sanduíche, 2 faces: 25 m² × 2 ÷ 5 = 10 kg de tinta", () => {
  assert.equal(telha("TELHA SANDUICHE TR40 - 980mm - (GALVALUME) - DUAS FACES PINTADAS", 25).tinta_kg, 10);
});

test("forro é igual à sanduíche (2 chapas, cola ×2)", () => {
  const r = telha("TELHA FORRO METÁLICO (BRANCO) TR40 - 980mm - SEM PINTURA EXTERNA", 25);
  assert.equal(r.categoria, "FORRO");
  assert.equal(r.bobina_kg, 160);
  assert.equal(r.eps_m, 25);
  assert.equal(r.cola_tubos, 1);
  assert.equal(r.tinta_kg, 0);
});

test("semi-sanduíche: bobina como a simples (25×3,2); EPS 25; cola 25÷50 = 0,5 tubo", () => {
  const r = telha("TELHA SEMI SAND. TR25 - 1020mm (GALVALUME) - SEM PINTURA", 25);
  assert.equal(r.bobina_kg, 80);
  assert.equal(r.eps_m, 25);
  assert.equal(r.cola_tubos, 0.5);
});

test("total do pedido: EPS e cola sobem para o inteiro (0,5 tubo vira 1; 22,5 m vira 23)", () => {
  const semi = telha("TELHA SEMI SAND. TR25 - 1020mm (GALVALUME) - SEM PINTURA", 22.5);
  const t = totalDoPedido([semi]);
  assert.equal(t.eps_m_exato, 22.5);
  assert.equal(t.eps_m, 23);
  assert.equal(t.cola_tubos_exato, 0.45);
  assert.equal(t.cola_tubos, 1);
});

test("total do pedido soma itens antes de arredondar (0,5 + 0,5 = 1 tubo, não 2)", () => {
  const a = telha("TELHA SEMI SAND. TR25 - 1020mm (GALVALUME) - SEM PINTURA", 25);
  const b = telha("TELHA SEMI SAND. TR25 - 1020mm (GALVALUME) - SEM PINTURA", 25);
  assert.equal(totalDoPedido([a, b]).cola_tubos, 1);
});

test("categorias e faces pelo nome do produto", () => {
  assert.equal(categoriaDoProduto("PARAFUSO 12 X 4\" POLEGADAS AUTO BROCANTE"), "REVENDA");
  assert.equal(categoriaDoProduto("TELHA TRANSLÚCIDA TR25"), "REVENDA");
  assert.equal(categoriaDoProduto("TELHA FORRO PVC (CUMARU) - TR25"), "FORRO_PVC");
  assert.equal(categoriaDoProduto("CORTE 40 (CALHA/RUFO/PINGADEIRA) SEM PINTURA"), "ACESSORIO");
  assert.equal(categoriaDoProduto("CUMIEIRA TR40 COM PINTURA"), "ACESSORIO");
  assert.equal(facesDoProduto("TELHA SANDUICHE TR25 - PRÉ PINTADA - BCO EXTERNO"), 0);
  assert.equal(facesDoProduto("TELHA FORRO METÁLICO (AMADEIRADO ESCURO) TR40 - 980mm - COM PINTURA EXTERNA"), 1);
  assert.equal(facesDoProduto("TELHA SIMPLES AMADEIRADO TR25 - 1020mm"), null);
});

test("cores: palavra ou código, na ordem do texto, sem repetir", () => {
  assert.deepEqual(coresDoTexto("Branco externo / Preto Fosco interno"), ["BRANCO", "PRETO FOSCO"]);
  assert.deepEqual(coresDoTexto("PINTURA CINZA MÉDIO PCS 10035"), ["CINZA BRILHANTE"]);
  assert.deepEqual(coresDoTexto("PINTURA EXTERNA MARROM SEPIA"), ["MARROM SEPIA FOSCO"]);
  assert.deepEqual(coresDoTexto("sem cor aqui"), []);
});

test("telha em unidade diferente de M2 vai para revisão em vez de calcular errado", () => {
  const r = calcularItem({ descricao: "TELHA SIMPLES TR25 - UMA FACE PINTADA", quantidade: 10, unidade: "UNID", textos: "" });
  assert.equal(r.situacao, "revisar");
  assert.equal(r.bobina_kg, null);
});

test("produto sem informação de pintura é calculado sem tinta e marcado para revisão", () => {
  const r = telha("TELHA SIMPLES AMADEIRADO TR25 - 1020mm", 10);
  assert.equal(r.tinta_kg, 0);
  assert.equal(r.situacao, "revisar");
});
