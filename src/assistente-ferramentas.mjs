// Ferramentas (SOMENTE LEITURA, sempre sobre o banco local — nunca o Nomus) que o assistente de IA pode chamar. Todo número que a IA diz vem daqui: ela interpreta o pedido,
// escolhe a ferramenta e explica o resultado, mas não faz conta nem decide valores sozinha.
//
// Privacidade: as ferramentas devolvem nome do cliente, cidade/UF e rota; NÃO devolvem telefone, endereço completo nem CPF/CNPJ.
import { config } from "./config.mjs";
import { calcularExpressao, fifoDeEstoque } from "./calculadora.mjs";
import { ESQUEMA_CONSULTA } from "./consulta-ia.mjs";

const centavos = (v) => Math.round((Number(v) || 0) * 100) / 100;
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const diasEntre = (de, ate) => Math.round((Date.parse(String(ate).slice(0, 10) + "T00:00:00") - Date.parse(String(de).slice(0, 10) + "T00:00:00")) / 86400000);
const STATUS_ITEM = { 1: "aguardando liberação", 2: "liberado", 3: "atendido parcialmente", 4: "atendido totalmente" };

const BASES = {
  saldo: (p) => p.saldo,
  valor_total: (p) => p.valor_total,
  vencido: (p) => p.vencido,
};

/**
 * Seleciona pedidos cuja soma chegue o mais perto possível da meta (programação dinâmica / soma de subconjuntos). Exportada para teste.
 * Com `limite` ({ de: (candidato) => consumo, maximo }) o consumo total (ex.: kg de bobina) não passa do máximo: entre as combinações
 * de mesma soma fica a que consome MENOS, e só valem as que cabem no máximo.
 */
export function selecionarParaMeta(candidatos, meta, preferencia = "menos_pedidos", limite = null) {
  // Trabalha em "unidades" de R$ para limitar a memória (meta de 100 mil = 1 R$ por unidade; metas maiores arredondam em degraus maiores).
  const unidade = Math.max(1, Math.floor(meta / 100000));
  const alvo = Math.round(meta / unidade);
  const folga = Math.max(Math.ceil(500 / unidade), Math.ceil(alvo * 0.05));
  const T = alvo + folga;

  const ordenados = [...candidatos];
  if (preferencia === "mais_antigos") ordenados.sort((a, b) => String(a.data_ref).localeCompare(String(b.data_ref)));
  const itens = ordenados
    // A parcela mínima no custo (1e-6 por pedido) só desempata: com mesmo consumo, menos pedidos.
    .map((c, rank) => ({ c, w: Math.round(c.valor / unidade), custo: limite ? Math.max(0, limite.de(c)) + 1e-6 : preferencia === "mais_antigos" ? rank + 1 : 1 }))
    .filter((x) => x.w > 0 && x.w <= T && (!limite || x.custo <= limite.maximo + 0.001));
  const cabe = (s) => melhor[s] !== Infinity && (!limite || melhor[s] <= limite.maximo + 0.001);
  const n = itens.length;

  const melhor = new Float64Array(T + 1).fill(Infinity);
  melhor[0] = 0;
  const pegou = new Uint8Array(Math.max(1, n * (T + 1)));
  for (let i = 0; i < n; i++) {
    const { w, custo } = itens[i];
    for (let s = T; s >= w; s--) {
      const c = melhor[s - w] + custo;
      if (c < melhor[s]) {
        melhor[s] = c;
        pegou[i * (T + 1) + s] = 1;
      }
    }
  }
  const montar = (s) => {
    const r = [];
    for (let i = n - 1; i >= 0 && s > 0; i--) {
      if (pegou[i * (T + 1) + s]) {
        r.push(itens[i].c);
        s -= itens[i].w;
      }
    }
    return r;
  };
  let abaixo = null, acima = null;
  for (let s = alvo; s > 0 && !abaixo; s--) if (cabe(s)) abaixo = montar(s);
  for (let s = alvo; s <= T && !acima; s++) if (cabe(s)) acima = montar(s);
  return { unidade, candidatos: n, abaixo, acima };
}

export function criarFerramentas(dados) {
  const compacto = (p, hoje) => ({
    codigo: p.codigo,
    cliente: p.cliente || "(cliente sem cadastro)",
    cidade_uf: [p.municipio, p.uf].filter(Boolean).join("/") || null,
    rota: p.rota,
    primeira_entrega: p.primeira_entrega || null,
    dias_para_entrega: p.primeira_entrega ? diasEntre(hoje, p.primeira_entrega) : null,
    valor_total: centavos(p.valor_total),
    recebido: centavos(p.recebido),
    saldo_a_receber: centavos(p.saldo),
    vencido: centavos(p.vencido),
    ...(p.bobina_kg != null ? { bobina_kg: Math.round(p.bobina_kg * 10) / 10 } : {}),
    situacao_financeira: p.financeiro,
    proximo_vencimento: p.proximo_vencimento || null,
    entrada: p.entrada_valor == null ? null : { rotulo: p.entrada_rotulo || "1ª parcela", valor: centavos(p.entrada_valor), paga: !!p.entrada_paga },
    ...(p.dias_aguardando != null ? { aguardando_ha_dias: p.dias_aguardando } : {}),
    ...(p.baixa_situacao ? { encerrado: { situacao: p.baixa_situacao, origem: p.baixa_origem, em: p.baixa_em } } : {}),
  });

  function baseDe(grupo) {
    const r = grupo === "aguardando" ? dados.listaAguardando() : grupo === "encerrados" ? dados.listaEncerrados() : dados.listaPedidos();
    return { hoje: r.hoje, pedidos: r.pedidos };
  }

  // ------------------------------------------------------------------ resumo_carteira
  function resumoCarteira() {
    const lib = dados.listaPedidos();
    const agu = dados.listaAguardando();
    const enc = dados.listaEncerrados();
    const soma = (l, k) => centavos(l.reduce((t, p) => t + (p[k] || 0), 0));
    const porFin = {};
    for (const p of lib.pedidos) {
      const g = (porFin[p.financeiro] ??= { pedidos: 0, saldo: 0, vencido: 0 });
      g.pedidos++; g.saldo += p.saldo || 0; g.vencido += p.vencido || 0;
    }
    for (const g of Object.values(porFin)) { g.saldo = centavos(g.saldo); g.vencido = centavos(g.vencido); }
    return {
      hoje: lib.hoje,
      pedido_numero_minimo: config.pedidoMinimo,
      carteira_liberados: {
        pedidos: lib.pedidos.length,
        valor_total: soma(lib.pedidos, "valor_total"),
        recebido: soma(lib.pedidos, "recebido"),
        saldo_a_receber: soma(lib.pedidos, "saldo"),
        vencido: soma(lib.pedidos, "vencido"),
        com_entrega_atrasada: lib.pedidos.filter((p) => p.primeira_entrega && p.primeira_entrega < lib.hoje).length,
        por_situacao_financeira: porFin,
      },
      encerrados_com_baixa: { pedidos: enc.pedidos.length, saldo_a_receber: soma(enc.pedidos, "saldo"), vencido: soma(enc.pedidos, "vencido"), observacao: "pedidos já entregues/cancelados (baixados); saldo a receber deles NÃO está na carteira em aberto" },
      aguardando_liberacao: {
        pedidos: agu.pedidos.length,
        valor_total: soma(agu.pedidos, "valor_total"),
        recebido: soma(agu.pedidos, "recebido"),
        entradas_nao_pagas: agu.pedidos.filter((p) => p.entrada_valor != null && !p.entrada_paga).length,
      },
    };
  }

  // ------------------------------------------------------------------ buscar_pedidos
  function buscarPedidos(a = {}) {
    const grupo = ["aguardando", "encerrados"].includes(a.grupo) ? a.grupo : "liberados";
    const { hoje, pedidos } = baseDe(grupo);
    let l = pedidos.map((p) => ({ ...p, _dias: p.primeira_entrega ? diasEntre(hoje, p.primeira_entrega) : null }));
    if (a.situacao_financeira) l = l.filter((p) => p.financeiro === a.situacao_financeira);
    if (a.rota_numero != null) l = l.filter((p) => p.rota_numero === Number(a.rota_numero));
    if (a.sem_rota) l = l.filter((p) => p.rota_numero === null);
    if (a.entrega === "atrasada") l = l.filter((p) => p._dias !== null && p._dias < 0);
    if (a.atraso_minimo_dias != null) l = l.filter((p) => p._dias !== null && -p._dias >= Number(a.atraso_minimo_dias));
    if (a.entrega === "proximos_7_dias") l = l.filter((p) => p._dias !== null && p._dias >= 0 && p._dias <= 7);
    if (a.entrega === "proximos_30_dias") l = l.filter((p) => p._dias !== null && p._dias >= 0 && p._dias <= 30);
    if (a.texto) { const t = norm(a.texto); l = l.filter((p) => norm([p.codigo, p.cliente, p.municipio, p.rota].join(" ")).includes(t)); }
    if (a.saldo_minimo != null) l = l.filter((p) => (p.saldo || 0) >= Number(a.saldo_minimo));
    if (a.vencido_minimo != null) l = l.filter((p) => (p.vencido || 0) >= Number(a.vencido_minimo));
    if (a.valor_total_minimo != null) l = l.filter((p) => (p.valor_total || 0) >= Number(a.valor_total_minimo));

    const campo = { saldo: "saldo", vencido: "vencido", valor_total: "valor_total", entrega: "_dias", numero: "numero", recebido: "recebido" }[a.ordenar_por] ?? "numero";
    const dir = a.ordem === "decrescente" ? -1 : 1;
    l.sort((x, y) => {
      const u = x[campo], v = y[campo];
      if (u == null) return v == null ? 0 : 1;
      if (v == null) return -1;
      return (u < v ? -1 : u > v ? 1 : 0) * dir;
    });
    const soma = (k) => centavos(l.reduce((t, p) => t + (p[k] || 0), 0));
    const limite = Math.min(Math.max(Number(a.limite) || 20, 1), 50);
    return {
      grupo, hoje,
      total_encontrado: l.length,
      soma_valor_total: soma("valor_total"), soma_recebido: soma("recebido"), soma_saldo_a_receber: soma("saldo"), soma_vencido: soma("vencido"), soma_bobina_kg: soma("bobina_kg"),
      mostrando: Math.min(limite, l.length),
      pedidos: l.slice(0, limite).map((p) => compacto(p, hoje)),
    };
  }

  // ------------------------------------------------------------------ resumo_por_grupo
  const CHAVES = {
    rota: (p) => p.rota,
    cliente: (p) => p.cliente || "(cliente sem cadastro)",
    cidade: (p) => [p.municipio, p.uf].filter(Boolean).join("/") || "(sem cidade)",
    situacao_financeira: (p) => p.financeiro,
    mes_primeira_entrega: (p) => (p.primeira_entrega ? p.primeira_entrega.slice(0, 7) : "(sem data)"),
  };
  function resumoPorGrupo(a = {}) {
    const chave = CHAVES[a.agrupar_por];
    if (!chave) return { erro: `agrupar_por deve ser um de: ${Object.keys(CHAVES).join(", ")}` };
    const grupo = a.grupo === "aguardando" ? "aguardando" : "liberados";
    const { hoje, pedidos } = baseDe(grupo);
    let l = pedidos.map((p) => ({ ...p, _dias: p.primeira_entrega ? diasEntre(hoje, p.primeira_entrega) : null }));
    if (a.situacao_financeira) l = l.filter((p) => p.financeiro === a.situacao_financeira);
    if (a.entrega === "atrasada") l = l.filter((p) => p._dias !== null && p._dias < 0);
    if (a.atraso_minimo_dias != null) l = l.filter((p) => p._dias !== null && -p._dias >= Number(a.atraso_minimo_dias));
    const grupos = new Map();
    for (const p of l) {
      const k = chave(p);
      const g = grupos.get(k) ?? { grupo: k, pedidos: 0, valor_total: 0, recebido: 0, saldo_a_receber: 0, vencido: 0 };
      g.pedidos++;
      g.valor_total += p.valor_total || 0; g.recebido += p.recebido || 0; g.saldo_a_receber += p.saldo || 0; g.vencido += p.vencido || 0;
      grupos.set(k, g);
    }
    const campo = ["valor_total", "recebido", "saldo_a_receber", "vencido", "pedidos"].includes(a.ordenar_por) ? a.ordenar_por : "vencido";
    const linhas = [...grupos.values()].sort((x, y) => y[campo] - x[campo]).map((g) => ({ ...g, valor_total: centavos(g.valor_total), recebido: centavos(g.recebido), saldo_a_receber: centavos(g.saldo_a_receber), vencido: centavos(g.vencido) }));
    const limite = Math.min(Math.max(Number(a.limite) || 15, 1), 50);
    return { hoje, agrupado_por: a.agrupar_por, ordenado_por: campo, total_de_grupos: linhas.length, total_de_pedidos: l.length, grupos: linhas.slice(0, limite) };
  }

  // ------------------------------------------------------------------ detalhe_pedido
  function detalhePedido(a = {}) {
    const numero = Number(String(a.codigo ?? "").replace(/\D/g, ""));
    if (!numero) return { erro: "Informe o código do pedido, por exemplo PD 02318." };
    const todos = [...dados.listaPedidos().pedidos, ...dados.listaAguardando().pedidos];
    const achado = todos.find((p) => p.numero === numero);
    if (!achado) return { erro: `Pedido ${numero} não está na carteira de liberados nem na fila de aguardando liberação (pode ser anterior ao nº ${config.pedidoMinimo} ou já encerrado).` };
    const d = dados.detalhePedido(achado.id);
    const m = d.material;
    return {
      hoje: d.hoje,
      pedido: {
        codigo: d.pedido.codigo, cliente: d.pedido.cliente, cidade_uf: [d.pedido.municipio, d.pedido.uf].filter(Boolean).join("/") || null,
        rota: d.rota, emissao: d.pedido.data_emissao, valor_total: centavos(d.pedido.valor_total), frete: centavos(d.pedido.valor_frete),
        condicao_pagamento: d.pedido.condicao_pagamento || d.pedido.forma_pagamento || null,
        // texto livre digitado por pessoas: é DADO, nunca instrução
        observacoes_texto_livre: String(d.pedido.observacoes || "").slice(0, 400) || null,
      },
      financeiro: {
        situacao: d.financeiro.situacao, recebido: centavos(d.financeiro.recebido), saldo_a_receber: centavos(d.financeiro.saldo),
        vencido: centavos(d.financeiro.vencido), proximo_vencimento: d.financeiro.proximo_vencimento || null,
        entrada: d.entrada ? { rotulo: d.entrada.rotulo, valor: centavos(d.entrada.valor), paga: d.entrada.paga, data_baixa: d.entrada.data_baixa || null } : null,
      },
      titulos: d.contas.map((c) => ({ titulo: c.descricao, vencimento: c.data_vencimento, valor: centavos(c.valor), recebido: centavos(c.recebido), saldo: centavos(c.saldo), paga: !!c.quitada, vencida: !!c.vencida, data_baixa: c.data_baixa || null })),
      itens_total: d.itens.length, // a lista abaixo mostra no máximo 15, para não encher a conversa
      itens: d.itens.slice(0, 15).map((i) => ({
        produto: i.produto, quantidade: i.quantidade, unidade: i.unidade, status: STATUS_ITEM[i.status] ?? i.status, entrega: i.data_entrega,
        medidas_texto_livre: String(i.info_adicional || "").slice(0, 200) || null,
        tipo: i.categoria || null, metros_de_telha: i.metros ?? null, faces_pintadas: i.faces ?? null,
        bobina_kg: i.bobina_kg ?? null, eps_m: i.eps_m ?? null, cola_tubos: i.cola_tubos ?? null, tinta_kg: i.tinta_kg ?? null, tinta_por_cor: i.tinta_cores ?? null, aviso_calculo: i.aviso || null,
      })),
      material_do_pedido: m ? { bobina_kg: m.bobina_kg, eps_m: m.eps_m, cola_tubos: m.cola_tubos, tinta_kg: m.tinta_kg, itens_a_revisar: m.itens_a_revisar ?? 0, itens_sem_regra: m.itens_sem_regra ?? 0, calculado_na_hora_itens_aguardando: !!m.ao_vivo } : null,
      tinta_por_cor_kg: d.tintaPorCor,
    };
  }

  // ------------------------------------------------------------------ montar_carteira_para_meta
  function montarParaMeta(a = {}) {
    const meta = Number(a.meta);
    if (!(meta > 0)) return { erro: "Informe a meta em reais (número maior que zero)." };
    const baseNome = BASES[a.base] ? a.base : "saldo";
    const grupo = ["aguardando", "encerrados"].includes(a.grupo) ? a.grupo : "liberados";
    const { hoje, pedidos } = baseDe(grupo);
    const excluir = new Set((a.excluir_pedidos ?? []).map((c) => Number(String(c).replace(/\D/g, ""))));
    let l = pedidos.filter((p) => !excluir.has(p.numero));
    if (a.situacao_financeira) l = l.filter((p) => p.financeiro === a.situacao_financeira);
    if (a.rota_numero != null) l = l.filter((p) => p.rota_numero === Number(a.rota_numero));
    const candidatos = l.map((p) => ({ p, valor: BASES[baseNome](p) || 0, data_ref: p.proximo_vencimento || p.data_emissao || "9999" })).filter((c) => c.valor > 0.005);
    if (!candidatos.length) return { erro: "Nenhum pedido com valor para essa base e esses filtros.", base: baseNome };

    const preferencia = a.preferencia === "mais_antigos" ? "mais_antigos" : "menos_pedidos";
    const maximoBobina = Number(a.bobina_maxima_kg) > 0 ? Number(a.bobina_maxima_kg) : null;
    // Pedido sem bobina calculada (fila de aguardando, encerrados) não pode entrar numa conta limitada por bobina.
    if (maximoBobina && !candidatos.some((c) => c.p.bobina_kg != null)) return { erro: "O consumo de bobina só é calculado para os pedidos liberados (grupo=liberados)." };
    // Com limite de bobina a pergunta é "o que posso PRODUZIR": só entram pedidos que consomem bobina, a menos que se peça o contrário.
    const comBobina = maximoBobina ? candidatos.filter((c) => c.p.bobina_kg != null && (a.incluir_pedidos_sem_bobina === true || c.p.bobina_kg > 0)) : candidatos;
    if (!comBobina.length) return { erro: "Nenhum pedido que consuma bobina para essa base e esses filtros.", base: baseNome };
    const r = selecionarParaMeta(comBobina, meta, preferencia, maximoBobina ? { de: (c) => c.p.bobina_kg || 0, maximo: maximoBobina } : null);
    const descrever = (escolha) => {
      const soma = centavos(escolha.reduce((t, c) => t + c.valor, 0));
      return {
        quantidade_de_pedidos: escolha.length,
        soma_pela_base: soma,
        diferenca_para_a_meta: centavos(soma - meta),
        bobina_total_kg: Math.round(escolha.reduce((t, c) => t + (c.p.bobina_kg || 0), 0) * 10) / 10,
        ...(maximoBobina ? { bobina_sobra_kg: Math.round((maximoBobina - escolha.reduce((t, c) => t + (c.p.bobina_kg || 0), 0)) * 10) / 10 } : {}),
        pedidos: escolha
          .sort((x, y) => String(x.data_ref).localeCompare(String(y.data_ref)))
          .map((c) => ({ ...compacto(c.p, hoje), valor_considerado: centavos(c.valor), vencimento_parcial: c.p.vencido > 0.005 && c.p.vencido < c.p.saldo - 0.005 })),
      };
    };
    const opcoes = [];
    if (r.abaixo) opcoes.push({ rotulo: "mais próxima da meta sem passar dela", ...descrever(r.abaixo) });
    if (r.acima) {
      const d = descrever(r.acima);
      const igual = opcoes[0] && opcoes[0].pedidos.map((x) => x.codigo).join() === d.pedidos.map((x) => x.codigo).join();
      if (!igual) opcoes.push({ rotulo: "mais próxima da meta chegando ou passando dela", ...d });
    }
    return {
      hoje, meta, base: baseNome, grupo, preferencia, pedidos_candidatos: comBobina.length,
      soma_de_todos_os_candidatos: centavos(comBobina.reduce((t, c) => t + c.valor, 0)),
      arredondamento_do_calculo_em_reais: r.unidade,
      ...(maximoBobina ? { bobina_maxima_kg: maximoBobina, criterio_com_bobina: "entre as combinações de mesma soma, a que consome menos bobina; só entram combinações que cabem no máximo" } : {}),
      opcoes: opcoes.length ? opcoes : [],
      aviso: opcoes.length ? "A soma exata raramente fecha no centavo; veja diferenca_para_a_meta. Pedidos com vencimento_parcial têm só parte do saldo vencida." : "Nenhuma combinação chegou perto da meta com esses pedidos.",
    };
  }

  // ------------------------------------------------------------------ fila_fifo
  const CRITERIOS_FIFO = {
    data_emissao: { de: (p) => p.data_emissao, nome: "data de emissão do pedido" },
    data_entrada_paga: { de: (p) => (p.entrada_paga ? p.entrada_baixa : null), nome: "data em que a entrada foi paga" },
    primeira_entrega: { de: (p) => p.primeira_entrega, nome: "primeira data de entrega" },
    proximo_vencimento: { de: (p) => p.proximo_vencimento, nome: "vencimento em aberto mais antigo" },
  };
  function filaFifo(a = {}) {
    const criterio = CRITERIOS_FIFO[a.criterio] ? a.criterio : "data_emissao";
    const grupo = a.grupo === "aguardando" ? "aguardando" : "liberados";
    const baseNome = BASES[a.base] ? a.base : "saldo";
    const maximoBobina = Number(a.bobina_disponivel_kg) > 0 ? Number(a.bobina_disponivel_kg) : null;
    const meta = Number(a.meta_valor) > 0 ? Number(a.meta_valor) : null;
    const pular = a.quando_nao_couber === "pular";
    const { hoje, pedidos } = baseDe(grupo);
    if (maximoBobina && grupo !== "liberados") return { erro: "O consumo de bobina só é calculado para os pedidos liberados (grupo=liberados)." };
    const excluir = new Set((a.excluir_pedidos ?? []).map((c) => Number(String(c).replace(/\D/g, ""))));
    let l = pedidos.filter((p) => !excluir.has(p.numero));
    if (a.rota_numero != null) l = l.filter((p) => p.rota_numero === Number(a.rota_numero));
    if (a.situacao_financeira) l = l.filter((p) => p.financeiro === a.situacao_financeira);
    if (a.somente_com_entrada_paga) l = l.filter((p) => p.entrada_paga);
    // Com bobina limitada a fila é de produção: pedido sem consumo de bobina não entra.
    if (maximoBobina) l = l.filter((p) => (p.bobina_kg || 0) > 0);
    const semData = l.filter((p) => !CRITERIOS_FIFO[criterio].de(p)).length;
    const fila = l.filter((p) => CRITERIOS_FIFO[criterio].de(p))
      .sort((x, y) => String(CRITERIOS_FIFO[criterio].de(x)).localeCompare(String(CRITERIOS_FIFO[criterio].de(y))) || x.numero - y.numero);

    const limite = Math.min(Math.max(Number(a.limite) || 40, 1), 100);
    const atendidos = [];
    const pulados = [];
    let valor = 0, bobina = 0, parou = null;
    for (const [indice, p] of fila.entries()) {
      const kg = p.bobina_kg || 0;
      const v = BASES[baseNome](p) || 0;
      if (maximoBobina && bobina + kg > maximoBobina + 0.001) {
        const aviso = { posicao_na_fila: indice + 1, codigo: p.codigo, cliente: p.cliente, bobina_kg: Math.round(kg * 10) / 10, bobina_que_restava_kg: Math.round((maximoBobina - bobina) * 10) / 10 };
        if (pular) { pulados.push(aviso); continue; }
        parou = { motivo: "o próximo pedido da fila não cabe na bobina que resta (FIFO estrito: não passa na frente)", ...aviso };
        break;
      }
      valor += v; bobina += kg;
      atendidos.push({ posicao_na_fila: indice + 1, codigo: p.codigo, cliente: p.cliente, rota: p.rota, data_do_criterio: String(CRITERIOS_FIFO[criterio].de(p)).slice(0, 10), valor_considerado: centavos(v), bobina_kg: Math.round(kg * 10) / 10, valor_acumulado: centavos(valor), bobina_acumulada_kg: Math.round(bobina * 10) / 10 });
      if (meta && valor >= meta - 0.005) { parou = { motivo: "meta de valor atingida", codigo: p.codigo }; break; }
    }
    return {
      hoje, metodo: `FIFO: primeiro o mais antigo por ${CRITERIOS_FIFO[criterio].nome} (empate: número do pedido)`, grupo, base: baseNome,
      pedidos_na_fila: fila.length, fora_da_fila_por_nao_ter_a_data: semData,
      atendidos: atendidos.length, valor_total_atendido: centavos(valor), bobina_total_kg: Math.round(bobina * 10) / 10,
      ...(maximoBobina ? { bobina_disponivel_kg: maximoBobina, bobina_sobra_kg: Math.round((maximoBobina - bobina) * 10) / 10 } : {}),
      ...(meta ? { meta_valor: meta, meta_atingida: valor >= meta - 0.005, diferenca_para_a_meta: centavos(valor - meta) } : {}),
      parou_em: parou ?? { motivo: "a fila acabou" },
      ...(pulados.length ? { pulados_por_nao_caber: pulados.slice(0, 20), total_pulados: pulados.length } : {}),
      mostrando: Math.min(limite, atendidos.length),
      pedidos: atendidos.slice(0, limite),
    };
  }

  // ------------------------------------------------------------------ calcular
  function calcular(a = {}) {
    const lista = Array.isArray(a.expressoes) ? a.expressoes.slice(0, 50) : [];
    if (!lista.length) return { erro: "Informe expressoes: uma lista de contas, ex.: [\"1250.5 * 3.2\"]." };
    return {
      resultados: lista.map((expressao) => {
        try {
          return { expressao, resultado: calcularExpressao(expressao) };
        } catch (erro) {
          return { expressao, erro: erro.message };
        }
      }),
    };
  }

  // ------------------------------------------------------------------ material_da_carteira
  function materialDaCarteira(a = {}) {
    const m = dados.materiaisDaCarteira();
    const nota = "Metragem = metros de telha × chapas por metro (sanduíche e forro contam 2), e bobina = metragem × 3,2 kg. EPS e cola arredondados para cima por pedido. Só pedidos liberados; acessórios (cumeeira, calha etc.) não entram.";
    const por = a.agrupar_por;
    if (por === "mes") return { nota, por_mes_da_primeira_entrega: m.porMes };
    if (por === "rota") return { nota, por_rota: m.porRota.map((r) => ({ ...r, valor_total: centavos(r.valor_total) })) };
    if (por === "tipo") return { nota, por_tipo_de_produto: m.porTipo };
    return { nota, total: m.total, tinta_por_cor: m.tintaPorCor.slice(0, 15) };
  }

  const definicoes = [
    {
      nome: "resumo_carteira",
      descricao: "Totais atuais: pedidos liberados (quantidade, valor total, recebido, saldo a receber, vencido, entregas atrasadas, por situação financeira) e a fila de pedidos aguardando liberação. Use para visão geral ou antes de responder perguntas amplas.",
      parametros: { type: "object", properties: {}, additionalProperties: false },
      executar: () => resumoCarteira(),
    },
    {
      nome: "buscar_pedidos",
      descricao: "Lista pedidos com filtros e ordenação, devolvendo também as somas do conjunto encontrado (valor total, recebido, saldo, vencido). Para saber 'quais pedidos', 'quantos' ou 'quanto somam'. Não devolve telefone nem endereço.",
      parametros: {
        type: "object",
        properties: {
          grupo: { type: "string", enum: ["liberados", "aguardando", "encerrados"], description: "liberados = carteira em aberto (padrão); aguardando = fila aguardando liberação; encerrados = pedidos já baixados (entregues/cancelados) que podem ainda ter saldo a receber" },
          situacao_financeira: { type: "string", enum: ["vencido", "a_vencer", "quitado", "sem_titulo"] },
          rota_numero: { type: "integer", description: "número da rota de entrega (1 a 23)" },
          sem_rota: { type: "boolean" },
          entrega: { type: "string", enum: ["atrasada", "proximos_7_dias", "proximos_30_dias"], description: "pela primeira data de entrega dos itens" },
          atraso_minimo_dias: { type: "integer", description: "só pedidos com a primeira entrega atrasada há pelo menos N dias (ex.: 30)" },
          texto: { type: "string", description: "parte do código, nome do cliente, cidade ou rota" },
          saldo_minimo: { type: "number" }, vencido_minimo: { type: "number" }, valor_total_minimo: { type: "number" },
          ordenar_por: { type: "string", enum: ["numero", "saldo", "vencido", "valor_total", "recebido", "entrega"] },
          ordem: { type: "string", enum: ["crescente", "decrescente"] },
          limite: { type: "integer", description: "máximo de pedidos listados (padrão 20, máximo 50)" },
        },
        additionalProperties: false,
      },
      executar: buscarPedidos,
    },
    {
      nome: "resumo_por_grupo",
      descricao: "Totais agrupados (pedidos, valor total, recebido, saldo a receber, vencido) por rota, cliente, cidade, situação financeira ou mês da primeira entrega, já ordenados. USE para perguntas de ranking ou agregação ('qual rota tem mais vencido?', 'quais clientes mais devem?'): é uma chamada só e evita varrer grupo por grupo. Aceita os filtros situacao_financeira, entrega=atrasada e atraso_minimo_dias.",
      parametros: {
        type: "object",
        properties: {
          agrupar_por: { type: "string", enum: ["rota", "cliente", "cidade", "situacao_financeira", "mes_primeira_entrega"] },
          grupo: { type: "string", enum: ["liberados", "aguardando", "encerrados"] },
          situacao_financeira: { type: "string", enum: ["vencido", "a_vencer", "quitado", "sem_titulo"] },
          entrega: { type: "string", enum: ["atrasada"] },
          atraso_minimo_dias: { type: "integer" },
          ordenar_por: { type: "string", enum: ["vencido", "saldo_a_receber", "valor_total", "recebido", "pedidos"], description: "padrão: vencido" },
          limite: { type: "integer", description: "máximo de grupos (padrão 15)" },
        },
        required: ["agrupar_por"],
        additionalProperties: false,
      },
      executar: resumoPorGrupo,
    },
    {
      nome: "detalhe_pedido",
      descricao: "Detalhe de um pedido: financeiro e títulos a receber, entrada, itens com o consumo de bobina/EPS/cola/tinta, material total e observações. Para explicar um pedido ou o cálculo de material dele.",
      parametros: { type: "object", properties: { codigo: { type: "string", description: "código ou número do pedido, ex.: PD 02318 ou 2318" } }, required: ["codigo"], additionalProperties: false },
      executar: detalhePedido,
    },
    {
      nome: "montar_carteira_para_meta",
      descricao: "Escolhe, com cálculo exato feito pelo sistema, um conjunto de pedidos cuja soma chegue o mais perto possível de uma meta em reais (ex.: 'separe pedidos que somem R$ 100 mil'). SEMPRE use esta ferramenta para metas de valor; nunca some pedidos de cabeça. A base da soma pode ser o saldo a receber, o valor total do pedido ou só a parte vencida. Quando houver limite de bobina (ex.: 'tenho 40 toneladas e preciso faturar 180 mil'), use bobina_maxima_kg: resolve numa chamada só.",
      parametros: {
        type: "object",
        properties: {
          meta: { type: "number", description: "valor alvo em reais" },
          base: { type: "string", enum: ["saldo", "valor_total", "vencido"], description: "o que somar em cada pedido (padrão saldo = ainda a receber)" },
          grupo: { type: "string", enum: ["liberados", "aguardando", "encerrados"] },
          situacao_financeira: { type: "string", enum: ["vencido", "a_vencer", "quitado", "sem_titulo"] },
          rota_numero: { type: "integer" },
          preferencia: { type: "string", enum: ["menos_pedidos", "mais_antigos"], description: "menos_pedidos (padrão) ou priorizar os de vencimento mais antigo" },
          excluir_pedidos: { type: "array", items: { type: "string" }, description: "códigos de pedidos que não podem entrar" },
          bobina_maxima_kg: { type: "number", description: "limite de bobina em kg (ex.: 40 toneladas = 40000): só escolhe combinações cujo consumo total de bobina caiba no limite, entre os pedidos que consomem bobina (a produzir). Só para pedidos liberados." },
          incluir_pedidos_sem_bobina: { type: "boolean", description: "com limite de bobina, incluir também pedidos sem consumo de bobina (revenda). Padrão: false." },
        },
        required: ["meta"],
        additionalProperties: false,
      },
      executar: montarParaMeta,
    },
    {
      nome: "material_da_carteira",
      descricao: "Necessidade de material (metragem, bobina, EPS, cola, tinta) dos pedidos liberados: total, por mês da primeira entrega, por rota ou por tipo de produto.",
      parametros: { type: "object", properties: { agrupar_por: { type: "string", enum: ["total", "mes", "rota", "tipo"] } }, additionalProperties: false },
      executar: materialDaCarteira,
    },
  ];

  definicoes.push(
    {
      nome: "fila_fifo",
      descricao: "Fila FIFO de pedidos (primeiro que entra, primeiro que sai), calculada pelo sistema: ordena do mais antigo para o mais novo e, se informado, consome a bobina disponível e/ou para na meta de valor. SEMPRE use para perguntas de FIFO, ordem de produção, 'o que produzir primeiro' ou 'quais atendo com X kg de bobina na ordem de chegada'.",
      parametros: {
        type: "object",
        properties: {
          criterio: { type: "string", enum: ["data_emissao", "data_entrada_paga", "primeira_entrega", "proximo_vencimento"], description: "o que define quem 'entrou primeiro' (padrão data_emissao)" },
          bobina_disponivel_kg: { type: "number", description: "bobina disponível em kg (40 toneladas = 40000)" },
          meta_valor: { type: "number", description: "parar quando a soma pela base atingir este valor em reais" },
          base: { type: "string", enum: ["saldo", "valor_total", "vencido"] },
          grupo: { type: "string", enum: ["liberados", "aguardando"] },
          quando_nao_couber: { type: "string", enum: ["parar", "pular"], description: "parar = FIFO estrito (padrão); pular = segue para o próximo que cabe" },
          somente_com_entrada_paga: { type: "boolean" },
          situacao_financeira: { type: "string", enum: ["vencido", "a_vencer", "quitado", "sem_titulo"] },
          rota_numero: { type: "integer" },
          excluir_pedidos: { type: "array", items: { type: "string" } },
          limite: { type: "integer", description: "máximo de pedidos listados (padrão 40, máximo 100); os totais consideram todos" },
        },
        additionalProperties: false,
      },
      executar: filaFifo,
    },
    {
      nome: "fifo_estoque",
      descricao: "Custo de estoque pelo FIFO / PEPS com lotes informados pelo usuário (o banco não tem estoque): custo de cada saída, lotes consumidos e estoque que sobra, com cálculo exato.",
      parametros: {
        type: "object",
        properties: {
          entradas: { type: "array", items: { type: "object", properties: { lote: { type: "string" }, data: { type: "string", description: "aaaa-mm-dd" }, quantidade: { type: "number" }, custo_unitario: { type: "number" } }, required: ["quantidade", "custo_unitario"] } },
          saidas: { type: "array", items: { type: "object", properties: { descricao: { type: "string" }, data: { type: "string", description: "aaaa-mm-dd" }, quantidade: { type: "number" } }, required: ["quantidade"] } },
        },
        required: ["entradas", "saidas"],
        additionalProperties: false,
      },
      executar: (a) => fifoDeEstoque(a.entradas, a.saidas),
    },
    {
      nome: "calcular",
      descricao: "Calculadora exata. Use para TODA conta que não venha pronta de outra ferramenta (percentual, regra de três, margem, rateio, médias, conversões, material). Operadores + - * / ^, parênteses, % (15% = 0.15) e soma, media, min, max, abs, raiz, arred(x; casas), teto, piso. Decimais com PONTO, sem separador de milhar. Pode mandar várias contas de uma vez.",
      parametros: { type: "object", properties: { expressoes: { type: "array", items: { type: "string" } } }, required: ["expressoes"], additionalProperties: false },
      executar: calcular,
    },
  );

  // Consulta livre ao banco local, para o que as ferramentas prontas não respondem.
  if (dados.consultarBanco) {
    definicoes.push({
      nome: "consultar_banco",
      descricao: `Consulta livre (um SELECT em SQLite) ao banco local da GFERRO, para QUALQUER pergunta que as outras ferramentas não resolvam: produtos e itens vendidos, metragem por produto ou cor, clientes, cidades, títulos, parcelas, datas, rankings, cruzamentos. Use SUM/COUNT/GROUP BY para totais (no máximo 200 linhas por consulta). Se a consulta der erro, corrija e tente de novo.\n${ESQUEMA_CONSULTA}`,
      parametros: { type: "object", properties: { sql: { type: "string", description: "um único SELECT (ou WITH ... SELECT)" } }, required: ["sql"], additionalProperties: false },
      executar: (a) => dados.consultarBanco(a.sql),
    });
  }

  return {
    definicoes,
    /** Definições no formato de "function calling" (compatível com OpenAI/xAI). */
    paraApi: () => definicoes.map((d) => ({ type: "function", function: { name: d.nome, description: d.descricao, parameters: d.parametros } })),
    executar(nome, argumentos) {
      const f = definicoes.find((d) => d.nome === nome);
      if (!f) return { erro: `Ferramenta desconhecida: ${nome}` };
      const falha = (erro) => ({ erro: `Falha na ferramenta ${nome}: ${erro?.message ?? erro}` });
      try {
        const resultado = f.executar(argumentos ?? {});
        return typeof resultado?.then === "function" ? resultado.catch(falha) : resultado; // consultar_banco é assíncrona
      } catch (erro) {
        return falha(erro);
      }
    },
  };
}
