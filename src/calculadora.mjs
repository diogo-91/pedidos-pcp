// Contas exatas para o assistente de IA (modelo de linguagem erra aritmética): uma calculadora de expressões, sem eval, e o FIFO/PEPS
// de estoque (o primeiro lote que entra é o primeiro que sai). Funções puras, testadas em test/calculadora.test.mjs.

const arredondarResultado = (v) => Number(v.toFixed(10));

const FUNCOES = {
  soma: { min: 1, f: (a) => a.reduce((t, x) => t + x, 0) },
  media: { min: 1, f: (a) => a.reduce((t, x) => t + x, 0) / a.length },
  min: { min: 1, f: (a) => Math.min(...a) },
  max: { min: 1, f: (a) => Math.max(...a) },
  abs: { min: 1, max: 1, f: ([x]) => Math.abs(x) },
  raiz: { min: 1, max: 1, f: ([x]) => Math.sqrt(x) },
  arred: { min: 1, max: 2, f: ([x, casas = 0]) => Math.round((x + Math.sign(x) * Number.EPSILON) * 10 ** casas) / 10 ** casas },
  teto: { min: 1, max: 1, f: ([x]) => Math.ceil(x - 1e-9) },
  piso: { min: 1, max: 1, f: ([x]) => Math.floor(x + 1e-9) },
};

/**
 * Calcula uma expressão: + - * / ^, parênteses, % depois do número (15% = 0,15) e soma, media, min, max, abs, raiz, arred(x; casas),
 * teto, piso. Decimais com PONTO e sem separador de milhar; argumentos separados por vírgula ou ponto e vírgula.
 */
export function calcularExpressao(texto) {
  const fonte = String(texto ?? "").trim();
  if (!fonte) throw new Error("expressão vazia");
  if (fonte.length > 1000) throw new Error("expressão grande demais");
  const fichas = fonte.match(/\d+(?:\.\d+)?|\.\d+|[A-Za-zÀ-ú_]+|\S/g) ?? [];
  let i = 0;
  let nivel = 0;
  const ver = () => fichas[i];
  const comer = (esperada) => {
    if (fichas[i] !== esperada) throw new Error(`esperava "${esperada}" e veio "${fichas[i] ?? "fim"}"`);
    i++;
  };

  function somaESubtracao() {
    if (++nivel > 100) throw new Error("expressão com parênteses demais");
    let v = produto();
    while (ver() === "+" || ver() === "-") v = fichas[i++] === "+" ? v + produto() : v - produto();
    nivel--;
    return v;
  }
  function produto() {
    let v = sinal();
    while (ver() === "*" || ver() === "/") {
      const op = fichas[i++];
      const d = sinal();
      if (op === "/" && d === 0) throw new Error("divisão por zero");
      v = op === "*" ? v * d : v / d;
    }
    return v;
  }
  function sinal() {
    if (ver() === "-") { i++; return -sinal(); }
    if (ver() === "+") { i++; return sinal(); }
    return potencia();
  }
  function potencia() {
    const base = valor();
    if (ver() === "^") { i++; return base ** sinal(); }
    return base;
  }
  function valor() {
    const f = ver();
    let v;
    if (f === "(") {
      i++;
      v = somaESubtracao();
      comer(")");
    } else if (/^(\d|\.\d)/.test(f ?? "")) {
      i++;
      v = Number(f);
    } else if (/^[A-Za-zÀ-ú_]+$/.test(f ?? "")) {
      const nome = f.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      const funcao = Object.hasOwn(FUNCOES, nome) ? FUNCOES[nome] : null;
      if (!funcao) throw new Error(`função desconhecida: ${f}`);
      i++;
      comer("(");
      const args = [somaESubtracao()];
      while (ver() === "," || ver() === ";") { i++; args.push(somaESubtracao()); }
      comer(")");
      if (args.length < funcao.min || (funcao.max && args.length > funcao.max)) throw new Error(`número de argumentos errado em ${nome}`);
      v = funcao.f(args);
    } else {
      throw new Error(`não entendi "${f ?? "fim da expressão"}"`);
    }
    while (ver() === "%") { i++; v /= 100; }
    return v;
  }

  const resultado = somaESubtracao();
  if (i < fichas.length) throw new Error(`sobrou "${fichas.slice(i).join(" ")}" (use ponto nos decimais e não use separador de milhar)`);
  if (!Number.isFinite(resultado)) throw new Error("resultado não é um número finito");
  return arredondarResultado(resultado);
}

/**
 * FIFO / PEPS de estoque: cada saída consome primeiro os lotes mais antigos. entradas: [{ lote?, data?, quantidade, custo_unitario }];
 * saidas: [{ descricao?, data?, quantidade }]. Com data (aaaa-mm-dd), vale a ordem das datas e uma saída só usa lotes que já tinham
 * entrado; sem data, vale a ordem informada.
 */
export function fifoDeEstoque(entradas, saidas) {
  if (!Array.isArray(entradas) || !entradas.length) throw new Error("informe as entradas (lotes) com quantidade e custo_unitario");
  if (!Array.isArray(saidas) || !saidas.length) throw new Error("informe as saídas com quantidade");
  if (entradas.length > 500 || saidas.length > 500) throw new Error("no máximo 500 entradas e 500 saídas");
  const numero = (v, nome) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${nome} inválido: ${v}`);
    return n;
  };
  const porData = (a, b) => (a.data && b.data ? a.data.localeCompare(b.data) : 0) || a.ordem - b.ordem;
  const lotes = entradas
    .map((e, ordem) => ({ ordem, lote: e.lote || `lote ${ordem + 1}`, data: e.data || null, quantidade: numero(e.quantidade, "quantidade da entrada"), custo_unitario: numero(e.custo_unitario, "custo_unitario") }))
    .sort(porData);
  const restante = new Map(lotes.map((l) => [l, l.quantidade]));
  const r2 = (v) => Math.round(v * 100) / 100;
  const q = (v) => Math.round(v * 10000) / 10000;

  const resultado = saidas
    .map((s, ordem) => ({ ordem, descricao: s.descricao || `saída ${ordem + 1}`, data: s.data || null, quantidade: numero(s.quantidade, "quantidade da saída") }))
    .sort(porData)
    .map((s) => {
      let falta = s.quantidade;
      const consumo = [];
      let custo = 0;
      for (const l of lotes) {
        if (falta <= 1e-9) break;
        if (s.data && l.data && l.data > s.data) continue; // lote que ainda não tinha entrado
        const usa = Math.min(falta, restante.get(l));
        if (usa <= 1e-9) continue;
        restante.set(l, restante.get(l) - usa);
        falta -= usa;
        custo += usa * l.custo_unitario;
        consumo.push({ lote: l.lote, quantidade: q(usa), custo_unitario: l.custo_unitario, custo: r2(usa * l.custo_unitario) });
      }
      const atendida = s.quantidade - falta;
      return { saida: s.descricao, data: s.data, quantidade_pedida: s.quantidade, quantidade_atendida: q(atendida), falta_estoque: q(Math.max(0, falta)), custo_total: r2(custo), custo_medio_da_saida: atendida > 0 ? q(custo / atendida) : 0, consumo };
    });

  const sobras = lotes.map((l) => ({ lote: l.lote, data: l.data, quantidade: q(restante.get(l)), custo_unitario: l.custo_unitario, valor: r2(restante.get(l) * l.custo_unitario) })).filter((l) => l.quantidade > 0);
  return {
    metodo: "FIFO / PEPS: primeiro que entra, primeiro que sai",
    saidas: resultado,
    custo_total_das_saidas: r2(resultado.reduce((t, s) => t + s.custo_total, 0)),
    estoque_final: { lotes: sobras, quantidade: q(sobras.reduce((t, l) => t + l.quantidade, 0)), valor: r2(sobras.reduce((t, l) => t + l.valor, 0)) },
  };
}
