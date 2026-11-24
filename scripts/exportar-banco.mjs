// Gera uma cópia limpa e consistente do banco (inclui as baixas) para levar ao volume do servidor.
//   node --no-warnings scripts/exportar-banco.mjs [destino]      (padrão: data/nomus-local-export.sqlite)
// Usa VACUUM INTO: copiar o .sqlite "no braço" perde o que ainda está no arquivo -wal.
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { config } from "../src/config.mjs";

const destino = path.resolve(process.argv[2] ?? path.join(path.dirname(config.arquivoBanco), "nomus-local-export.sqlite"));
if (destino === config.arquivoBanco) throw new Error("O destino não pode ser o próprio banco.");
if (existsSync(destino)) rmSync(destino);
const db = new DatabaseSync(config.arquivoBanco, { readOnly: true });
db.exec(`VACUUM INTO '${destino.replaceAll("'", "''")}'`);
db.close();
console.log(`Banco exportado em ${destino}`);
