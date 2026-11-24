// Rota de entrega de cada pedido, pela cidade do cliente. A tabela cidade → rota é a aba "Rotas" da planilha de programação
// (config/rotas-cidades.csv) e os nomes das rotas vêm da tabela do Gferro-PCP (config/rotas.csv). Para corrigir ou acrescentar
// uma cidade, edite o CSV e reinicie o servidor.
import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";

/** "Araçoiaba da  Serra - SP" -> "aracoiaba da serra-sp" */
export function chaveCidade(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function lerCsv(arquivo) {
  const linhas = readFileSync(path.join(config.raiz, "config", arquivo), "utf8").split(/\r?\n/).filter(Boolean);
  return linhas.slice(1).map((l) => l.split(";").map((c) => c.trim()));
}

const rotas = new Map(lerCsv("rotas.csv").map(([numero, nome]) => [Number(numero), { numero: Number(numero), nome: `Rota ${numero} – ${nome}` }]));
const porCidade = new Map(lerCsv("rotas-cidades.csv").map(([cidade, numero]) => [chaveCidade(cidade), Number(numero)]));

/** { numero, nome } da rota da cidade (e UF), ou null quando a cidade não está na tabela. */
export function rotaDaCidade(municipio, uf) {
  const n = porCidade.get(chaveCidade(`${municipio}-${uf}`));
  return n === undefined ? null : (rotas.get(n) ?? null);
}

export const todasAsRotas = () => [...rotas.values()];
