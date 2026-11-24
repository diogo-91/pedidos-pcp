/** Número no formato do Nomus ("32.468,04", "1,2") ou número JS. Vazio/ilegível = null. */
export function parseNum(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  // O Nomus omite as casas decimais quando são zero: "1.386" é 1386 (ponto de milhar), não 1,386.
  // Decimal vem sempre com vírgula, então ponto seguido de exatamente 3 dígitos (em grupos) é milhar.
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "dd/mm/aaaa" ou "dd/mm/aaaa hh:mm[:ss]" (ou já ISO) -> "aaaa-mm-dd" / "aaaa-mm-ddThh:mm:ss". Senão null. */
export function dataIso(v) {
  const t = String(v ?? "").trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/.exec(t);
  let r = null;
  if (br) r = br[4] ? `${br[3]}-${br[2]}-${br[1]}T${br[4]}` : `${br[3]}-${br[2]}-${br[1]}`;
  else {
    const iso = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/.exec(t);
    if (iso) r = iso[0].replace(" ", "T");
  }
  // Só data (sem hora) quando a hora é meia-noite: datas de pedido/vencimento comparam como texto "aaaa-mm-dd".
  return r ? r.replace(/T00:00(?::00)?$/, "") : null;
}

/** "PD 01279" -> 1279 */
export function numeroDoCodigo(codigo) {
  const m = /\bPD\s*0*(\d+)\b/i.exec(String(codigo ?? ""));
  return m ? Number(m[1]) : null;
}

export const limpar = (t) => String(t ?? "").replace(/\s+/g, " ").trim();

/** Endereço em uma linha a partir de uma pessoa (ou de um item de `enderecos`) do Nomus. */
export function montarEndereco(r) {
  const tipo = limpar(r.tipoLogradouro);
  const logradouro = limpar(r.endereco);
  // Alguns cadastros já trazem o tipo dentro do logradouro ("RUA X"): não repete.
  const via = tipo && !logradouro.toUpperCase().startsWith(tipo.toUpperCase()) ? `${tipo} ${logradouro}` : logradouro;
  const rua = [via, limpar(r.numero)].filter(Boolean).join(", ");
  const cidade = [limpar(r.municipio), limpar(r.uf).toUpperCase()].filter(Boolean).join("/");
  const cep = limpar(r.cep);
  return [rua, limpar(r.complemento), limpar(r.bairroDistrito ?? r.bairro), cidade, cep ? `CEP ${cep}` : ""].filter(Boolean).join(" - ");
}
export const nulo = (v) => (v === undefined ? null : v);
export const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
export function* lotes(lista, tamanho) {
  for (let i = 0; i < lista.length; i += tamanho) yield lista.slice(i, i + tamanho);
}
