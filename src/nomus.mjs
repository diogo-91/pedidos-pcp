import { dormir } from "./util.mjs";

export class NomusHttpError extends Error {
  constructor(mensagem, status, corpo) {
    super(mensagem);
    this.name = "NomusHttpError";
    this.status = status;
    this.corpo = corpo;
  }
}

/** Cliente somente-leitura (GET) da API REST do Nomus, com retry em 429/5xx/rede e intervalo mínimo entre chamadas. */
export class NomusClient {
  constructor({ baseUrl, token, timeoutMs = 30_000, maxRetries = 10, intervaloMs = 1200, log = console.log }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.intervaloMs = intervaloMs;
    this.log = log;
    this.ultimaChamada = 0;
    this.chamadas = 0;
  }

  url(endpoint, params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    const qs = q.toString();
    return `${this.baseUrl}/${endpoint.replace(/^\/+/, "")}${qs ? `?${qs}` : ""}`;
  }

  async get(endpoint, params) {
    const url = this.url(endpoint, params);
    let tentativas400 = 0;
    for (let tentativa = 0; ; tentativa++) {
      const espera = this.ultimaChamada + this.intervaloMs - Date.now();
      if (espera > 0) await dormir(espera);
      this.ultimaChamada = Date.now();
      this.chamadas++;
      try {
        return await this.umaVez(url, endpoint);
      } catch (erro) {
        const pausa = this.pausaParaRepetir(erro);
        // 400 costuma ser engasgo da instância logo após um 429 (observado: o mesmo pedido de ids que falha passa isolado),
        // mas pode ser consulta recusada de verdade: poucas tentativas, com espera crescente, e quem chamou decide
        // (por exemplo, dividindo o lote). Não gasta o limite de tentativas do 429/5xx.
        if (erro.status === 400 && ++tentativas400 > 4) throw erro;
        if (pausa === null || (erro.status !== 400 && tentativa >= this.maxRetries)) throw erro;
        if (erro.status === 400) await dormir(3000 * tentativas400);
        if (erro.status === 429) this.log(`  [429] ${endpoint}: aguardando ${Math.round(pausa / 1000)}s`);
        await dormir(pausa);
      }
    }
  }

  /** O Nomus pagina em 50 por página (?pagina=N) sem informar total: lê até vir uma página incompleta. */
  async todasAsPaginas(endpoint, params = {}, { limitePaginas = Infinity, aoReceber } = {}) {
    const registros = [];
    for (let pagina = 1; pagina <= limitePaginas; pagina++) {
      const lote = await this.get(endpoint, { ...params, pagina });
      if (!Array.isArray(lote)) throw new NomusHttpError(`Resposta de ${endpoint} (pág. ${pagina}) não é uma lista.`);
      registros.push(...lote);
      if (aoReceber) aoReceber(lote, pagina);
      if (lote.length < 50) break;
    }
    return registros;
  }

  async umaVez(url, endpoint) {
    const controle = new AbortController();
    const timer = setTimeout(() => controle.abort(), this.timeoutMs);
    let resposta;
    let corpo;
    try {
      resposta = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Basic ${this.token}` },
        signal: controle.signal,
      });
      corpo = await resposta.text();
    } catch (erro) {
      throw new NomusHttpError(`Falha de rede em ${endpoint}: ${erro?.name ?? erro}`);
    } finally {
      clearTimeout(timer);
    }
    if (resposta.status === 401) throw new NomusHttpError("Credencial do Nomus inválida (401).", 401, "");
    if (!resposta.ok) throw new NomusHttpError(`Nomus respondeu ${resposta.status} em ${endpoint}`, resposta.status, corpo.slice(0, 300));
    try {
      return JSON.parse(corpo);
    } catch {
      throw new NomusHttpError(`Corpo não-JSON em ${endpoint}`, resposta.status, corpo.slice(0, 200));
    }
  }

  pausaParaRepetir(erro) {
    if (!(erro instanceof NomusHttpError)) return null;
    if (erro.status === 401) return null;
    if (erro.status === 429) {
      let seg = 3;
      try {
        seg = Number(JSON.parse(erro.corpo || "{}").tempoAteLiberar) || 3;
      } catch {
        // corpo sem JSON: usa o padrão
      }
      return Math.min(seg * 1000 + 1500, 30_000);
    }
    if (erro.status === undefined || erro.status >= 500) return 5000;
    // 400 esporádico sob carga foi observado nessa instância: uma tentativa extra curta.
    if (erro.status === 400) return 3000;
    return null;
  }
}
