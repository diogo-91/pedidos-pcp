// Regras de consumo de material por item de pedido. Funções puras (sem banco), testadas em test/calculo.test.mjs.
//
// Fonte das regras: áudios e texto do PCP (08/11/2026), bobina = 3,2 confirmada em 24/11/2026.
//   "metros"  = quantidade do item em M2 (peças × comprimento, tratado como m²).
//   Bobina    = metros × chapas × 3,2 kg      (simples 1 chapa, semi 1, sanduíche 2, forro 2)
//   EPS       = metros (simples = 0)          (arredonda p/ cima no total do pedido)
//   Cola      = tubos: sanduíche/forro metros × 2 ÷ 50; semi metros ÷ 50; simples 0   (arredonda p/ cima no pedido)
//   Tinta     = metros × faces pintadas ÷ 5 kg (vale para simples, sanduíche, semi e forro)

export const PARAMETROS_PADRAO = {
  bobina_kg_por_metro: 3.2,
  chapas_simples: 1,
  chapas_semi: 1,
  chapas_sanduiche: 2,
  chapas_forro: 2,
  cola_m2_por_tubo: 50,
  cola_fator_sanduiche_forro: 2,
  cola_fator_semi: 1,
  tinta_m2_por_kg: 5,
};

const semAcento = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

const CATEGORIAS_TELHA = ["SIMPLES", "SEMI", "SANDUICHE", "FORRO"];

/** Categoria de consumo pela descrição do produto no Nomus. */
export function categoriaDoProduto(descricao) {
  const d = semAcento(descricao);
  if (!d) return "SEM_PRODUTO";
  if (/PARAFUSO|METALON|VIGA\s+U|TELA\s+SOLD|^EPS\b|^PU\s|^BOBINA|TRANSLUCID|LEITOSA/.test(d)) return "REVENDA";
  if (/PINTURA\s+ELETROSTATICA/.test(d)) return "SERVICO_PINTURA";
  if (/FORRO\s+PVC/.test(d)) return "FORRO_PVC";
  if (/^PAINEL/.test(d)) return "PAINEL";
  if (/TELHA\s+SANDUICHE/.test(d)) return "SANDUICHE";
  if (/TELHA\s+SEMI/.test(d)) return "SEMI";
  if (/TELHA\s+SIMPLES/.test(d)) return "SIMPLES";
  if (/TELHA\s+FORRO/.test(d)) return "FORRO";
  if (/CUMIEIRA|CUMEEIRA|ACABAMENTO|TRANSPASSE|^CORTE\s+\d|BOCAL|TAMPA|REFILO/.test(d)) return "ACESSORIO";
  return "SEM_PRODUTO";
}

/** Faces pintadas pelo nome do produto ("UMA FACE PINTADA", "SEM PINTURA", "COM PINTURA EXTERNA"...). null = não informa. */
export function facesDoProduto(descricao) {
  const d = semAcento(descricao);
  if (/PRE[\s-]?PINTAD/.test(d)) return 0; // chapa já pintada: não consome tinta
  if (/SEM\s+PINTURA/.test(d)) return 0;
  if (/DUAS\s+FACES?/.test(d)) return 2;
  if (/UMA\s+FACE/.test(d)) return 1;
  if (/COM\s+PINTURA/.test(d)) return 1; // "COM PINTURA EXTERNA": a face de cima
  return null;
}

// Cores (nome canônico), da mais específica para a mais genérica. Casa por palavra ou código RAL/PCS do fabricante da tinta.
const CORES = [
  [/PRETO\s+FOSCO/, "PRETO FOSCO"],
  [/PRETO\s+SEMI|PSN\s*001/, "PRETO SEMI-BRILHO"],
  [/PRETO\s+BRILH|RAL\s*9005/, "PRETO BRILHANTE"],
  [/PRETO/, "PRETO"],
  [/BRANC|BRNCO|RAL\s*9003/, "BRANCO"],
  [/CERAMIC|RAL\s*8023/, "CERAMICA"],
  [/GRAFITE|RAL\s*7024|10040/, "CINZA GRAFITE"],
  [/CINZA\s+CLARO|RAL\s*7035|20723/, "CINZA CLARO"],
  [/JANELA|RAL\s*7040|10478/, "CINZA JANELA"],
  [/PRATA|FSW\s*010/, "CINZA PRATA"],
  [/CINZA\s+(BRILH|MEDIO)|RAL\s*7042|10035/, "CINZA BRILHANTE"],
  [/CINZA/, "CINZA"],
  [/CASTANHO|10437/, "MARROM CASTANHO"],
  [/SEPIA.*BRILH|10438/, "MARROM SEPIA BRILHO"],
  [/SEPIA|RAL\s*8014/, "MARROM SEPIA FOSCO"],
  [/MARROM|MARRON/, "MARROM"],
  [/CORTEN/, "ACO CORTEN"],
  [/BEGE|BEJE|RAL\s*1015/, "BEGE"],
  [/DEL\s*REY|AZUL.*10015/, "AZUL DEL REY"],
  [/AZUL.*CLARO|20529|PBJ\s*035/, "AZUL CLARO"],
  [/AZUL.*SEMI|11006/, "AZUL SEMI-BRILHO"],
  [/AZUL.*BRILH|10016|PBJ\s*125/, "AZUL BRILHANTE"],
  [/AZUL/, "AZUL"],
  [/AMARELO/, "AMARELO"],
  [/LARANJA/, "LARANJA"],
  [/VERDE.*(ESCURO|6005)/, "VERDE ESCURO"],
  [/VERDE.*(CLARO|6002)/, "VERDE CLARO"],
  [/VERDE.*ESMERALDA|10602/, "VERDE ESMERALDA"],
  [/VERDE.*FOLHA|PDS\s*10002/, "VERDE FOLHA"],
  [/VERDE/, "VERDE"],
  [/CARMIM|3002/, "VERMELHO CARMIM"],
  [/VERMELH/, "VERMELHO"],
  [/AMADEIRADO\s+ESCURO/, "AMADEIRADO ESCURO"],
  [/AMADEIRADO\s+CLARO/, "AMADEIRADO CLARO"],
  [/AMADEIRADO/, "AMADEIRADO"],
  [/NATURAL/, "NATURAL"],
];

/** Cores citadas no texto, na ordem em que aparecem, sem repetir. */
export function coresDoTexto(texto) {
  const t = semAcento(texto);
  const achadas = [];
  const usados = []; // trechos já consumidos por uma cor mais específica
  for (const [regex, nome] of CORES) {
    const m = new RegExp(regex.source, "g");
    let r;
    while ((r = m.exec(t))) {
      const ini = r.index, fim = ini + r[0].length;
      if (usados.some(([a, b]) => ini < b && fim > a)) continue;
      usados.push([ini, fim]);
      achadas.push({ nome, pos: ini });
    }
  }
  achadas.sort((a, b) => a.pos - b.pos);
  const nomes = [...new Set(achadas.map((a) => a.nome))];
  // "MARROM SEPIA": a palavra genérica (MARROM) é descartada quando uma cor específica da mesma família foi achada.
  return nomes.filter((n) => !nomes.some((outro) => outro.startsWith(`${n} `)));
}

const arred = (n, casas = 6) => Number(n.toFixed(casas));

/**
 * Consumo de um item. Devolve { categoria, situacao, metros, faces, bobina_kg, eps_m, cola_tubos, tinta_kg, cores, aviso }.
 *   item: { quantidade, unidade, descricao, textos: string } — textos = observações/medidas do item (para cor e avisos)
 */
export function calcularItem(item, params = PARAMETROS_PADRAO) {
  const categoria = categoriaDoProduto(item.descricao);
  const base = { categoria, situacao: "sem_regra", metros: null, faces: null, bobina_kg: null, eps_m: null, cola_tubos: null, tinta_kg: null, cores: [], aviso: "" };

  if (categoria === "REVENDA") return { ...base, situacao: "revenda" };
  const avisos = [];

  if (categoria === "SERVICO_PINTURA") {
    // Regra de tinta assumida igual à da telha (m² ÷ 5 por face); o PCP não confirmou para o serviço de pintura.
    const metros = Number(item.quantidade) || 0;
    const tinta = arred((metros * 1) / params.tinta_m2_por_kg);
    const cores = coresDoTexto(item.textos);
    return { ...base, situacao: "revisar", metros, faces: 1, tinta_kg: tinta, cores, aviso: "Serviço de pintura: tinta calculada como 1 face (regra da telha), não confirmada pelo PCP." };
  }
  if (!CATEGORIAS_TELHA.includes(categoria)) {
    const motivo = { FORRO_PVC: "Forro PVC (comprado de terceiros)", PAINEL: "Painel de forro sem regra definida", ACESSORIO: "Acessório/peça dobrada sem regra de bobina definida", SEM_PRODUTO: "Produto não reconhecido" }[categoria];
    return { ...base, aviso: motivo ?? "" };
  }
  if (String(item.unidade).toUpperCase() !== "M2") {
    return { ...base, situacao: "revisar", aviso: `Unidade ${item.unidade || "?"} em vez de M2: metragem não confiável.` };
  }
  const metros = Number(item.quantidade);
  if (!Number.isFinite(metros) || metros <= 0) return { ...base, situacao: "revisar", aviso: "Quantidade ausente ou zero." };

  let faces = facesDoProduto(item.descricao);
  if (faces === null) {
    faces = 0;
    avisos.push("Produto não informa pintura: assumido sem pintura.");
  }
  const chapas = { SIMPLES: params.chapas_simples, SEMI: params.chapas_semi, SANDUICHE: params.chapas_sanduiche, FORRO: params.chapas_forro }[categoria];
  const bobina = metros * chapas * params.bobina_kg_por_metro;
  const eps = categoria === "SIMPLES" ? 0 : metros;
  const fatorCola = categoria === "SIMPLES" ? 0 : categoria === "SEMI" ? params.cola_fator_semi : params.cola_fator_sanduiche_forro;
  const cola = (metros * fatorCola) / params.cola_m2_por_tubo;
  const tinta = (metros * faces) / params.tinta_m2_por_kg;

  // Cor: do texto do item; no forro, a cor do próprio produto ("(AMADEIRADO ESCURO)") vem primeiro.
  let cores = [];
  if (faces > 0) {
    const doProduto = categoria === "FORRO" ? coresDoTexto((String(item.descricao).match(/\(([^)]*)\)/) ?? [])[1] ?? "") : [];
    cores = doProduto.length ? doProduto : coresDoTexto(item.textos);
  }
  if (/PIR/.test(semAcento(item.descricao))) avisos.push("Produto com PIR: EPS calculado como nas demais, confirmar com o PCP.");
  if (faces === 0 && /PINTURA\s+(EXTERNA|INTERNA)|COR\s*:/.test(semAcento(item.textos))) avisos.push("Texto do item cita pintura/cor, mas o produto é sem pintura.");

  return {
    categoria,
    situacao: avisos.length ? "revisar" : "calculado",
    metros,
    faces,
    bobina_kg: arred(bobina),
    eps_m: arred(eps),
    cola_tubos: arred(cola),
    tinta_kg: arred(tinta),
    cores,
    aviso: avisos.join(" "),
  };
}

/** Total de um pedido: soma os itens e arredonda EPS e cola PARA CIMA (inteiros). */
export function totalDoPedido(itensCalculados) {
  const t = { bobina_kg: 0, eps_m_exato: 0, cola_tubos_exato: 0, tinta_kg: 0, itens_calculados: 0, itens_a_revisar: 0, itens_sem_regra: 0 };
  for (const c of itensCalculados) {
    t.bobina_kg += c.bobina_kg ?? 0;
    t.eps_m_exato += c.eps_m ?? 0;
    t.cola_tubos_exato += c.cola_tubos ?? 0;
    t.tinta_kg += c.tinta_kg ?? 0;
    if (c.situacao === "calculado") t.itens_calculados++;
    else if (c.situacao === "revisar") t.itens_a_revisar++;
    else if (c.situacao === "sem_regra") t.itens_sem_regra++;
  }
  t.bobina_kg = arred(t.bobina_kg, 3);
  t.tinta_kg = arred(t.tinta_kg, 3);
  t.eps_m_exato = arred(t.eps_m_exato, 3);
  t.cola_tubos_exato = arred(t.cola_tubos_exato, 3);
  return { ...t, eps_m: Math.ceil(t.eps_m_exato), cola_tubos: Math.ceil(t.cola_tubos_exato) };
}

/** Divide a tinta de um item entre as cores: duas faces com duas cores = metade para cada; senão tudo na primeira (ou "A DEFINIR"). */
export function dividirTinta(r) {
  if (!(r.tinta_kg > 0)) return [];
  const cores = r.cores?.length ? r.cores : ["A DEFINIR"];
  if (cores.length === r.faces && r.faces > 1) return cores.map((cor) => ({ cor, kg: r.tinta_kg / cores.length }));
  return [{ cor: cores[0], kg: r.tinta_kg }];
}
