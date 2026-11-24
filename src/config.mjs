import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A porta da tela NÃO pode vir do PORT do .env emprestado (o do Gferro-PCP define PORT=3100 e colidiria com ele): só vale o PORT que o
// ambiente já tinha antes de carregar os .env (é assim que a prévia do app escolhe a porta), ou PEDIDOS_PORTA.
const portaDoAmbiente = process.env.PORT;

// 1) .env local; 2) o arquivo apontado por NOMUS_ENV_FILE (não sobrescreve o que já foi definido).
const local = path.join(raiz, ".env");
if (existsSync(local)) process.loadEnvFile(local);
const externo = process.env.NOMUS_ENV_FILE;
if (externo) {
  if (!existsSync(externo)) throw new Error(`NOMUS_ENV_FILE não existe: ${externo}`);
  process.loadEnvFile(externo);
}

const env = (nome, padrao = "") => (process.env[nome] ?? padrao).trim();

export const config = {
  raiz,
  porta: Number(process.env.PEDIDOS_PORTA ?? portaDoAmbiente ?? 3300),
  // Onde o servidor escuta. Padrão: só este computador. Em container use PEDIDOS_HOST=0.0.0.0 — e então PEDIDOS_TOKEN é obrigatório (ver servidor.mjs).
  host: env("PEDIDOS_HOST", "127.0.0.1"),
  // Senha compartilhada com a intranet (cabeçalho X-Pedidos-Token). Com ela definida, toda requisição sem o token é recusada.
  acessoToken: env("PEDIDOS_TOKEN"),
  // Nomes de host aceitos além de localhost/127.0.0.1 (ex.: o nome interno do serviço na rede do Docker), separados por vírgula.
  hostsPermitidos: env("PEDIDOS_HOSTS_PERMITIDOS").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  baseUrl: env("NOMUS_BASE_URL").replace(/\/+$/, ""),
  token: env("NOMUS_TOKEN"),
  statusLiberado: Number(env("NOMUS_STATUS_LIBERADO", "2")),
  idEmpresa: Number(env("NOMUS_ID_EMPRESA", "3")),
  // A tela não mostra pedidos com número abaixo deste (pedidos antigos que seguem "Liberados" no Nomus). Os dados continuam no banco.
  pedidoMinimo: Number(env("NOMUS_PEDIDO_MINIMO", "1280")),
  // Atualização automática feita pelo servidor da tela: de quantos em quantos minutos (0 desliga) e em que horas do dia (início-fim, hora local).
  // Assistente de IA (xAI / Grok, API compatível com a da OpenAI). A chave fica só no .env.
  grokChave: env("GROK_API_KEY"),
  grokBase: env("GROK_BASE_URL", "https://api.x.ai/v1").replace(/\/+$/, ""),
  grokModelo: env("GROK_MODELO"),
  // Nível de raciocínio do modelo (low | medium | high | xhigh). Vazio = padrão do modelo (high no grok-4.7). Mais alto = mais inteligente, mais lento e mais caro.
  grokEsforco: env("GROK_ESFORCO"),
  assistenteLimiteDiario: Number(env("ASSISTENTE_LIMITE_DIARIO", "200")), // mensagens por dia (controle de custo)
  atualizacaoIntervaloMin: Number(env("ATUALIZACAO_INTERVALO_MIN", "60")),
  atualizacaoJanela: env("ATUALIZACAO_JANELA", "6-20"),
  // Nome próprio (não DATABASE_FILE): o .env emprestado do Gferro-PCP também define DATABASE_FILE e apontaria para outro banco.
  arquivoBanco: path.resolve(raiz, env("NOMUS_LOCAL_DB", "data/nomus-local.sqlite")),
};

export function exigirCredencial() {
  if (!config.baseUrl || !config.token) {
    throw new Error("Defina NOMUS_BASE_URL e NOMUS_TOKEN (ou NOMUS_ENV_FILE) no .env.");
  }
}
