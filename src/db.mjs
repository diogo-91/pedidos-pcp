import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");

export function abrirBanco(arquivo) {
  mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrar(db);
  return db;
}

// Bancos criados antes de uma coluna existir: CREATE TABLE IF NOT EXISTS não a acrescenta, então confere e adiciona.
function migrar(db) {
  const colunas = (tabela) => new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name));
  const garantir = (tabela, coluna, definicao) => {
    if (!colunas(tabela).has(coluna)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
  };
  garantir("cliente", "endereco_completo", "TEXT NOT NULL DEFAULT ''");
  garantir("cliente", "cep", "TEXT NOT NULL DEFAULT ''");
  garantir("sync_run", "pid", "INTEGER"); // processo que está rodando a sincronização (a trava reconhece processo morto)
  garantir("pedido", "aguardando", "INTEGER NOT NULL DEFAULT 0"); // 1 = tem item em "Aguardando liberação" (status 1) na última sincronização completa
}

export function emTransacao(db, fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (erro) {
    db.exec("ROLLBACK");
    throw erro;
  }
}
