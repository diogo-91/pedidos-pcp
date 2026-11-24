// Atualização automática dos dados: roda a sincronização com o Nomus e, se deu certo, o cálculo de materiais.
// Cada passo é um processo filho (src/sync.mjs e src/calcular.mjs), então o servidor da tela segue só lendo o banco.
//
// - Automática: a cada ATUALIZACAO_INTERVALO_MIN minutos (padrão 60; 0 desliga), só dentro da janela ATUALIZACAO_JANELA (padrão 6-20, hora local).
// - Manual: o botão "Atualizar agora" da tela (POST /api/atualizar).
// - A primeira rodada de cada dia confere as contas a receber de TODOS os pedidos (--completa); as outras pulam os já quitados.
// - Nunca duas ao mesmo tempo (trava aqui e dentro do sync.mjs). O que acontece fica em data/atualizacao.log.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

const UM_MB = 1024 * 1024;

export function criarAtualizador({ db, config }) {
  const intervaloMin = Number.isFinite(config.atualizacaoIntervaloMin) ? config.atualizacaoIntervaloMin : 60;
  const [horaIni, horaFim] = String(config.atualizacaoJanela).split("-").map(Number);
  const janela = Number.isInteger(horaIni) && Number.isInteger(horaFim) ? [horaIni, horaFim] : [6, 20];
  const arquivoLog = path.join(path.dirname(config.arquivoBanco), "atualizacao.log");
  const estado = { rodando: false, etapa: null, origem: null, iniciadoEm: null, aviso: null };
  const um = (sql, ...p) => db.prepare(sql).get(...p);
  const hojeLocal = (d = new Date()) => d.toLocaleDateString("sv-SE");

  function log(mensagem) {
    try {
      mkdirSync(path.dirname(arquivoLog), { recursive: true });
      if (existsSync(arquivoLog) && statSync(arquivoLog).size > UM_MB) renameSync(arquivoLog, arquivoLog + ".antigo");
      appendFileSync(arquivoLog, `${new Date().toISOString()}  ${mensagem}\n`);
    } catch {
      // o log nunca pode derrubar a atualização
    }
  }

  const dentroDaJanela = (d) => d.getHours() >= janela[0] && d.getHours() < janela[1];

  function executar(argumentos) {
    return new Promise((resolve) => {
      const filho = spawn(process.execPath, ["--no-warnings", ...argumentos], { cwd: config.raiz, env: process.env, windowsHide: true });
      let resto = "";
      const linha = (l) => {
        if (!l) return;
        log(l);
        const m = /Etapa: (\w+)/.exec(l);
        if (m) estado.etapa = m[1];
      };
      const ler = (dados) => {
        resto += dados;
        let i;
        while ((i = resto.indexOf("\n")) >= 0) {
          linha(resto.slice(0, i).trim());
          resto = resto.slice(i + 1);
        }
      };
      filho.stdout.on("data", ler);
      filho.stderr.on("data", ler);
      filho.on("error", (e) => {
        log(`não foi possível iniciar ${argumentos[0]}: ${e.message}`);
        resolve(-1);
      });
      filho.on("close", (codigo) => {
        linha(resto.trim());
        resolve(codigo ?? -1);
      });
    });
  }

  function precisaCompleta() {
    const r = um("SELECT MAX(finalizado_em) AS em FROM sync_run WHERE status IN ('ok','parcial') AND resumo_json LIKE '%\"completa\":true%'");
    return !r?.em || hojeLocal(new Date(r.em)) !== hojeLocal();
  }

  /** Começa uma atualização e devolve na hora (true), ou false se já há uma rodando. O andamento está em estadoPublico(). */
  function iniciar(origem) {
    if (estado.rodando) return false;
    Object.assign(estado, { rodando: true, etapa: "iniciando", origem, iniciadoEm: new Date().toISOString(), aviso: null });
    (async () => {
      try {
        const completa = precisaCompleta();
        log(`==== atualização ${origem}${completa ? " (completa)" : ""}`);
        const sync = await executar(["src/sync.mjs", ...(completa ? ["--completa"] : [])]);
        if (sync === 2) estado.aviso = "Já havia uma sincronização em andamento.";
        else if (sync !== 0) estado.aviso = "A sincronização com o Nomus falhou; os dados continuam os da última vez que deu certo.";
        else {
          const rodada = um("SELECT status, erro FROM sync_run ORDER BY id DESC LIMIT 1");
          if (rodada?.status === "parcial") estado.aviso = `Sincronização parcial: ${rodada.erro}`;
          estado.etapa = "calculo";
          const calculo = await executar(["src/calcular.mjs"]);
          if (calculo !== 0) estado.aviso = "O cálculo de materiais falhou; os valores de material podem estar desatualizados.";
        }
      } catch (erro) {
        estado.aviso = `Falha inesperada: ${erro?.message ?? erro}`;
        log(estado.aviso);
      } finally {
        log(`==== fim da atualização${estado.aviso ? ` — ${estado.aviso}` : ""}`);
        estado.rodando = false;
        estado.etapa = null;
      }
    })();
    return true;
  }

  function proximaEm() {
    if (intervaloMin <= 0) return null;
    const ultima = um("SELECT iniciado_em FROM sync_run ORDER BY id DESC LIMIT 1");
    let t = new Date(Math.max(Date.now(), (ultima ? Date.parse(ultima.iniciado_em) : Date.now()) + intervaloMin * 60_000));
    for (let i = 0; i < 96 && !dentroDaJanela(t); i++) t = new Date(t.getTime() + 15 * 60_000); // fora da janela: espera abrir
    return t.toISOString();
  }

  function estadoPublico() {
    const boa = um("SELECT id, finalizado_em FROM sync_run WHERE status IN ('ok','parcial') AND etapas LIKE '%pedidos%' ORDER BY id DESC LIMIT 1");
    const ultima = um("SELECT id, iniciado_em, finalizado_em, status, erro FROM sync_run ORDER BY id DESC LIMIT 1");
    const calculo = um("SELECT MAX(calculado_em) AS em FROM pedido_material");
    return {
      automatica: intervaloMin > 0,
      intervaloMin,
      janela: `${janela[0]}h às ${janela[1]}h`,
      rodando: estado.rodando,
      etapa: estado.etapa,
      origem: estado.origem,
      iniciadoEm: estado.iniciadoEm,
      aviso: estado.aviso,
      ultimaBoa: boa ? { id: boa.id, finalizadoEm: boa.finalizado_em } : null,
      ultimaTentativa: ultima ?? null,
      calculadoEm: calculo?.em ?? null,
      proximaEm: estado.rodando ? null : proximaEm(),
    };
  }

  /** Liga a agenda: confere a cada minuto se já passou o intervalo desde a última tentativa (inclusive de antes de o servidor subir). */
  function agendar() {
    if (intervaloMin <= 0) {
      log("atualização automática desligada (ATUALIZACAO_INTERVALO_MIN=0)");
      return;
    }
    const conferir = () => {
      if (estado.rodando || !dentroDaJanela(new Date())) return;
      const ultima = um("SELECT iniciado_em FROM sync_run ORDER BY id DESC LIMIT 1");
      if (!ultima || Date.now() - Date.parse(ultima.iniciado_em) >= intervaloMin * 60_000) iniciar("automática");
    };
    setTimeout(conferir, 15_000).unref();
    setInterval(conferir, 60_000).unref();
  }

  return { iniciar, agendar, estado: estadoPublico };
}
