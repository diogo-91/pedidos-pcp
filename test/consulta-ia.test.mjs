import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { abrirBanco } from "../src/db.mjs";
import { criarConsulta, ocultarDadosPessoais } from "../src/consulta-ia.mjs";

const pasta = mkdtempSync(path.join(os.tmpdir(), "consulta-ia-teste-"));
const arquivoBanco = path.join(pasta, "base.sqlite");
const db = abrirBanco(arquivoBanco);
db.exec(`INSERT INTO pedido (id, codigo, numero, id_cliente, data_emissao, valor_total, observacoes, liberado, raw_json, atualizado_em)
         VALUES (1, 'PD 02000', 2000, 1, '2026-11-01', 100, 'ligar (15) 99690-9100 CPF 123.456.789-09 fulano@exemplo.com', 1, '{}', 'x')`);
const todos = (sql, p = {}) => db.prepare(sql).all(p);
const pedidoFalso = { numero: 2000, codigo: "PD 02000", cliente: "CLIENTE TESTE", telefone: "+55 15 996909100", endereco_completo: "Rua Secreta, 1", valor_total: 100, saldo: 40, bobina_kg: 12 };
const consultar = criarConsulta({
  arquivoBanco, todos,
  listaPedidos: (modo) => ({ hoje: "2026-11-26", pedidos: modo === "so" ? [] : [pedidoFalso] }),
  listaAguardando: () => ({ hoje: "2026-11-26", pedidos: [] }),
});
test.after(() => { db.close(); try { rmSync(pasta, { recursive: true, force: true }); } catch { /* Windows pode segurar o arquivo */ } });

test("consulta a cópia do banco local", async () => {
  const r = await consultar("SELECT codigo, cliente, saldo_a_receber, bobina_kg, grupo FROM pedidos;");
  assert.deepEqual(r.linhas.map((l) => ({ ...l })), [{ codigo: "PD 02000", cliente: "CLIENTE TESTE", saldo_a_receber: 40, bobina_kg: 12, grupo: "liberado" }]);
});

test("a cópia não tem dados pessoais", async () => {
  const tudo = JSON.stringify(await consultar("SELECT * FROM pedidos")) + JSON.stringify(await consultar("SELECT sql FROM sqlite_master"));
  for (const segredo of ["99690", "Rua Secreta", "123.456.789-09", "fulano@exemplo.com", "raw_json", "telefone", "endereco"]) assert.ok(!tudo.includes(segredo), segredo);
  assert.ok((await consultar("SELECT * FROM cliente")).erro);
});

test("só leitura: recusa outros comandos e não deixa escrever", async () => {
  for (const sql of ["ATTACH DATABASE 'x' AS y", "PRAGMA table_info(pedidos)", "DELETE FROM pedidos", "WITH a AS (SELECT 1) DELETE FROM pedidos"]) {
    assert.ok((await consultar(sql)).erro, sql);
  }
  assert.equal((await consultar("SELECT COUNT(*) AS n FROM pedidos")).linhas[0].n, 1);
});

test("consulta que não termina é interrompida", async () => {
  const r = await consultar("WITH x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT SUM(n) FROM x");
  assert.ok(r.erro);
});

test("limita a quantidade de linhas", async () => {
  const r = await consultar("WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x WHERE n < 1000) SELECT n FROM x");
  assert.equal(r.linhas.length, 200);
  assert.equal(r.cortado, true);
});

test("oculta telefone, CPF, CNPJ e e-mail em texto livre sem apagar medidas", () => {
  const t = ocultarDadosPessoais("15 99690-9100 / 12.345.678/0001-90 / 11996909100 / 10 peças 6,00 m TR40 980mm PD 02000");
  assert.ok(!/99690|345\.678/.test(t));
  assert.ok(t.includes("10 peças 6,00 m TR40 980mm PD 02000"));
});
