# nomus-local

Espelho local (SQLite) dos **pedidos liberados** do Nomus. Só lê o Nomus (GET); nunca escreve nele.
É independente do Gferro-PCP: banco próprio, nada do `pcp.sqlite` de produção é lido nem alterado.

Requer Node 22.13+ (usa `node:sqlite`; sem dependências).

## Configurar

A credencial pode vir de um `.env` local (copie `.env.example`) **ou** de um `.env` que já exista, sem copiar o token:

```powershell
$env:NOMUS_ENV_FILE = "C:/Users/Admin/Documents/Gferro-PCP/.env"
```

## Usar

```powershell
node --no-warnings src/sync.mjs                          # sincroniza tudo (10 a 15 min por causa do limite do Nomus)
node --no-warnings src/sync.mjs --etapas contas          # só uma etapa
node --no-warnings src/sync.mjs --limite-paginas 1       # teste rápido
node --no-warnings src/resumo.mjs                        # contagens e verificações de consistência
```

Etapas, nesta ordem: `pedidos`, `formas`, `clientes`, `produtos`, `ordens`, `contas`.
A sincronização padrão **não inclui `ordens`** (adiada em 24/11/2026): o endpoint `/ordens` do Nomus responde 429 o tempo todo
e 400 esporádico, e consultar ~990 itens levaria horas. As tabelas `ordem` e `ordem_item` existem, mas ficam vazias.
Para tentar mesmo assim: `node --no-warnings src/sync.mjs --etapas ordens`.
Pode rodar de novo a qualquer hora: tudo é *upsert*. Pedido que não aparece mais como Liberado numa varredura
completa passa a `liberado = 0` (continua gravado).

## O que tem no banco (`data/nomus-local.sqlite`)

| Tabela | Conteúdo |
|---|---|
| `pedido`, `pedido_item`, `pedido_parcela` | Pedidos com item Liberado (status 2), todos os itens deles e as parcelas de pagamento previstas |
| `cliente`, `produto`, `forma_pagamento` | Cadastros usados pelos pedidos |
| `ordem`, `ordem_item` | OPs ligadas aos itens liberados |
| `conta_receber` | Parcelas a receber ligadas ao pedido pela descrição "Pedido PD nnnnn…" (só a empresa 3) |
| `sync_run` | Histórico das sincronizações |

Visões: `v_pedido_aberto` (carteira com cliente) e `v_financeiro_pedido` (recebido, saldo, vencido por pedido).
Toda tabela guarda o JSON bruto da API em `raw_json`.

## Observações do Nomus que valem aqui

- A instância é compartilhada com a Constelha: contas a receber são filtradas por `idEmpresa` (padrão 3).
- Números e datas vêm em formato BR e são convertidos (reais em `REAL`, datas `aaaa-mm-dd`).
- O texto de medidas/cor fica em `pedido_item.info_adicional` e `item`; o cálculo de materiais vem na próxima etapa.

## Cálculo de material

```powershell
node --no-warnings src/calcular.mjs                 # recalcula tudo a partir do banco (não chama o Nomus)
node --no-warnings --test test/calculo.test.mjs     # testes, incluindo os exemplos dos áudios do PCP
```

Regras (PCP, áudios de 08/11/2026; bobina 3,2 confirmada em 24/11/2026). "Metros" = `quantidade` do item em M2.

| | Simples | Sanduíche | Forro | Semi-sanduíche |
|---|---|---|---|---|
| Bobina (kg) | m × 3,2 | m × 2 × 3,2 | m × 2 × 3,2 | m × 3,2 |
| EPS (m) | 0 | m | m | m |
| Cola (tubos) | 0 | m × 2 ÷ 50 | m × 2 ÷ 50 | m ÷ 50 |
| Tinta (kg) | m × faces ÷ 5 | idem | idem | idem |

- **Arredondamento: por pedido** (decisão de 24/11/2026). Os itens são somados e só o total do pedido de EPS e de cola sobe para o inteiro
  (0,5 tubo + 0,5 tubo = 1 tubo). `pedido_material` guarda o valor exato (`*_exato`) e o arredondado.
- Os coeficientes ficam em `parametro_calculo` (editáveis); `item_calculo` tem o resultado exato por item e `item_tinta`, a tinta por cor.
- Faces pintadas e categoria vêm da descrição do produto no Nomus; a cor, do texto do item. Cor não reconhecida = `A DEFINIR`.
- Sem regra (não entram nos totais): cumeeira, acabamento, transpasse, cortes de calha/rufo, forro PVC e painel.
  Marcados para revisão: produtos com PIR e serviço de pintura (tinta assumida como 1 face).
- Revenda (parafuso, metalon, viga U, tela, telha translúcida): sem consumo de bobina, EPS, cola ou tinta.

## Tela "Pedidos em aberto"

```powershell
node --no-warnings src/servidor.mjs        # http://127.0.0.1:3300
```

Somente leitura sobre o banco local (não chama o Nomus) e só escuta em `127.0.0.1`: a tela mostra nome e telefone de clientes e valores.
Para atualizar os dados, rode a sincronização e o cálculo (acima) e recarregue a página.

- **Pedidos:** uma linha por pedido liberado, com entrega, valor, situação financeira (vencido, a vencer, quitado, sem título) e o material
  (bobina, EPS, cola, tinta). Filtros por busca, financeiro, prazo de entrega e tipo de produto; ordenação por qualquer coluna;
  exportação do que está filtrado em CSV. Os totais do topo acompanham os filtros.
- **Detalhe do pedido** (clique na linha): dados e pagamento previsto, títulos a receber um a um, itens com o consumo de cada material,
  tinta por cor e observações.
- **Materiais da carteira:** totais por mês da primeira entrega, por tipo de produto e tinta por cor.
- Vencido = parcela não paga com vencimento anterior a hoje. Entrega = menor data de entrega entre os itens liberados.

### Relação de materiais e corte de pedidos antigos

- **Pedidos abaixo do nº 1280 não aparecem** em nenhuma visão da tela (lista, totais, materiais). Continuam no banco; o corte é a variável
  `NOMUS_PEDIDO_MINIMO` (padrão 1280). Reinicie o servidor depois de mudar.
- **Materiais da carteira → Por pedido:** todos os pedidos em aberto com valor total, bobina, EPS, cola, tinta (e tinta por cor), com linha de total.
- **Materiais da carteira → Por item:** um item por linha (metros, faces, consumo e cor). Itens de revenda ficam de fora.
- As duas visões têm busca, ordenação por coluna e exportação em CSV; clicar numa linha abre o detalhe do pedido.

### Endereço e entrada na aba Pedidos

- **Endereço do cliente:** vem do cadastro do cliente no Nomus (rua, número, complemento, bairro, cidade/UF e CEP, em `cliente.endereco_completo`).
  O pedido não traz endereço de entrega próprio; no detalhe do pedido aparecem também os endereços alternativos ativos do cliente (ex.: "Entrega").
- **Entrada** = primeira parcela do pedido (rótulos como ENTRADA ou 100% PAGO). A coluna "Entrada recebida" mostra o valor pago e a data; se ainda
  não foi paga, mostra o valor em aberto e o vencimento. "Total recebido" é tudo que já entrou nas parcelas do pedido.
- Depois de mudar a forma de montar endereços, rode `node --no-warnings src/reprocessar.mjs` (refaz a partir do JSON bruto, sem chamar o Nomus).

### Atualização automática

O servidor da tela atualiza os dados sozinho: a cada `ATUALIZACAO_INTERVALO_MIN` minutos (padrão 60; 0 desliga), das 6h às 20h
(`ATUALIZACAO_JANELA`), roda a sincronização com o Nomus e, se deu certo, o cálculo de materiais. O botão "Atualizar agora" faz o mesmo na hora.
A primeira rodada de cada dia confere as contas de todos os pedidos; as demais pulam os pedidos já quitados. Nunca roda duas ao mesmo tempo.
O que acontece fica em `data/atualizacao.log`. A tela mostra a idade dos dados (alerta depois de 3 h), o andamento e se a última tentativa falhou,
e recarrega sozinha quando chegam dados novos. O `.env` desta pasta só aponta para o `.env` do Gferro-PCP (a credencial não é copiada).

### Rota de entrega

A rota vem da cidade do cliente: `config/rotas-cidades.csv` (cidade;número da rota, extraída da aba "Rotas" da planilha de programação) e
`config/rotas.csv` (nomes das rotas, do Gferro-PCP). Aparece como coluna e filtro na lista de pedidos, no detalhe do pedido e na aba
Materiais (colunas nas visões por pedido e por item, e a visão "Por rota" com os totais de cada rota). Cidade fora da tabela, ou cliente sem
cidade no cadastro, fica em "Sem rota". Para acrescentar ou corrigir uma cidade, edite o CSV e reinicie o servidor.

- **Metragem (m)** na aba Materiais: soma dos metros das telhas (simples, sanduíche, semi-sanduíche e forro) de cada pedido; também por rota
  e no total. Acessórios (cumeeira, cortes, acabamento, transpasse) não entram. Na visão por item, o total inclui também o serviço de pintura.

### Aba "Aguardando liberação"

Pedidos com algum item em **Aguardando liberação** (status 1 do Nomus), ainda fora da carteira de liberados. A sincronização faz uma segunda
varredura por esse status; cada pedido guarda `liberado` (tem item no status 2) e `aguardando` (tem item no status 1), calculados pelos próprios
itens. A aba mostra cliente, endereço, rota, desde quando aguarda, valor, entrada (paga ou em aberto), total recebido e situação financeira, com
busca e exportação em CSV. No detalhe do pedido, o material dos itens aguardando é calculado na hora (não entra nos totais da carteira).
O corte de número mínimo (`NOMUS_PEDIDO_MINIMO`) vale também aqui.

Códigos de status de item no Nomus: 1 aguardando liberação, 2 liberado, 3 atendido parcialmente, 4 atendido totalmente; 5 (provavelmente encerrado)
e 6 (provavelmente cancelado) foram deduzidos de dados, não confirmados.

### Como ligar a tela

Dê dois cliques em **`iniciar-tela.cmd`** (abre http://127.0.0.1:3300). Deixe a janela aberta: a tela só existe enquanto o servidor roda, e a
atualização automática dos dados também. Pelo terminal: `node --no-warnings src/servidor.mjs`. A porta é 3300 (mude com `PEDIDOS_PORTA`);
ela **não** usa o `PORT` do `.env` emprestado do Gferro-PCP, que é 3100.
Se o servidor for fechado no meio de uma atualização, a rodada interrompida é reconhecida (pelo número do processo) e liberada na próxima.

- **Metragem (m) conta a 2ª chapa** (alteração de 24/11/2026): metragem = metros de telha × chapas por metro (sanduíche e forro 2; simples e semi 1, parâmetros
  `chapas_*`). Assim **bobina = metragem × 3,2 kg** em qualquer linha. Os metros da própria telha continuam na coluna "Telha (m)" da visão por item e do Resumo.

### Assistente de IA (xAI / Grok)

Botão "✦ Assistente" na tela: conversa em português sobre a carteira, saldos, entregas e material. A IA **só consulta** por ferramentas de leitura
(`src/assistente-ferramentas.mjs`): resumo da carteira, busca de pedidos, detalhe de pedido, material da carteira e **seleção de pedidos por meta em
R$** ("separe pedidos que somem R$ 100 mil"). Todo número vem dessas ferramentas (a seleção é uma soma de subconjuntos calculada pelo sistema, não pela
IA). Ela não altera pedidos, não emite nota e não envia mensagens; escreve rascunhos quando pedido. As ferramentas **não devolvem telefone, endereço nem
CPF/CNPJ**; nome do cliente, cidade/UF e rota são enviados à xAI quando a pergunta precisa deles.

Para ligar, no `.env` desta pasta (não versionado; nunca cole chave em chat ou arquivo de exemplo):

```
GROK_API_KEY="xai-..."      # criada em console.x.ai
GROK_MODELO="..."           # nome do modelo que a conta permite (aparece no console)
```

e reinicie o servidor. Limite diário de perguntas: `ASSISTENTE_LIMITE_DIARIO` (padrão 200). Toda pergunta e resposta fica em `assistente_log`
(com as ferramentas consultadas e os tokens). `GET /api/assistente/estado` diz se está pronto. Testes: `node --no-warnings --test test/*.test.mjs`.

**Modelo e nível de raciocínio.** `GROK_MODELO="grok-4.7"` (o mais novo da conta; US$ 2 por milhão de tokens de entrada e US$ 6 de saída, segundo a API da xAI) e
`GROK_ESFORCO="xhigh"` (`low`, `medium`, `high` ou `xhigh`; vazio usa o padrão do modelo, `high`). Em 3 perguntas de teste, `high` e `xhigh` custaram o mesmo
(cerca de US$ 0,02 a 0,05 por pergunta) e levaram o mesmo tempo (10 a 35 s); o que mais mudou o custo e a velocidade foram as ferramentas
(`resumo_por_grupo`, filtro `atraso_minimo_dias`): a pergunta mais difícil caiu de 172 mil para 19 mil tokens. Para listar os modelos da conta:
`GET https://api.x.ai/v1/language-models` com a chave.

### Dentro da intranet (Dashboard → Pedidos → "Pedidos em aberto (PCP)")

A tela também aparece no menu da intranet (projeto `GFERRO INTRANET`), com o visual dela (fundo branco, destaques amarelos). A intranet embute a tela
num quadro (iframe) e o servidor dela repassa as chamadas (`pedidosPcpProxy.ts`, rota `/api/pcp-pedidos/*`) para este serviço. O acesso segue o login e a
permissão do módulo "Dashboard de Pedidos"; o cookie de sessão **não** é enviado para cá.

- Este serviço precisa estar rodando (`iniciar-tela.cmd`). Endereço: `PEDIDOS_PCP_URL` no `.env` da intranet (padrão `http://127.0.0.1:3300`).
- A página usa caminhos relativos (`api/...`) e o modo `?embed=1` (ou estar dentro de um iframe) esconde o título e reduz margens.
- A tela continua abrindo sozinha em http://127.0.0.1:3300 (sem login, só neste computador).
- **Produção:** veja a próxima seção.

### Publicar no servidor (Docker / EasyPanel)

A intranet em servidor não enxerga o `127.0.0.1` deste computador, então este serviço sobe como um segundo container (há `Dockerfile` pronto, Node 22,
sem dependências). Testado localmente: build, subida, token, host e healthcheck.

1. **Serviço novo** (no mesmo projeto/rede da intranet), a partir desta pasta (`nomus-local`, com o `Dockerfile`). **Não publique porta para a internet**:
   só a intranet deve alcançá-lo, pelo nome interno do serviço (ex.: `http://pedidos-pcp:3300`).
2. **Volume persistente em `/data`** (banco e log). Sem volume os dados e as baixas somem a cada deploy.
3. **Variáveis do serviço:**

   | Variável | Valor |
   |---|---|
   | `PEDIDOS_TOKEN` | senha longa (≥ 24 caracteres): `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `PEDIDOS_HOSTS_PERMITIDOS` | nome interno do serviço, ex.: `pedidos-pcp` |
   | `NOMUS_BASE_URL`, `NOMUS_TOKEN` | os mesmos da integração Nomus que já funciona |
   | `GROK_API_KEY`, `GROK_MODELO`, `GROK_ESFORCO` | para o assistente (opcional; use uma chave nova, não a que foi colada em chat) |

   Os padrões do container já são `PEDIDOS_HOST=0.0.0.0`, `NOMUS_LOCAL_DB=/data/nomus-local.sqlite`, fuso `America/Sao_Paulo`. Sem `PEDIDOS_TOKEN` o serviço
   **se recusa a subir** fora do `127.0.0.1`; com ele, toda requisição sem o cabeçalho `X-Pedidos-Token` correto leva 401.
4. **Variáveis da intranet:** `PEDIDOS_PCP_URL=http://pedidos-pcp:3300` e `PEDIDOS_PCP_TOKEN=` (o mesmo valor de `PEDIDOS_TOKEN`). A intranet manda o token; o
   navegador nunca o vê.
5. **Dados iniciais.** Banco vazio faz a primeira atualização carregar tudo do Nomus (demora e usa a cota da API). Para começar do que já existe aqui, inclusive as
   baixas, gere uma cópia consistente e coloque no volume como `/data/nomus-local.sqlite` antes da primeira subida:
   ```powershell
   node --no-warnings scripts/exportar-banco.mjs
   ```
   (a cópia sai em `data/nomus-local-export.sqlite`; o arquivo do volume precisa ser gravável pelo usuário `node`, uid 1000).
6. **Uma instância só.** O banco é SQLite com um único processo de atualização: não escale para mais de uma réplica.

Se este computador também continuar ligado com `iniciar-tela.cmd`, os dois bancos andam separados: baixas feitas num não aparecem no outro.

### Baixa de pedidos entregues (planilha de programação)

O Nomus não diz se um pedido já foi entregue; a planilha de programação diz (coluna SITUAÇÃO da aba Base). Para tirar os entregues da lista "em aberto":

```powershell
python -I scripts/extrair-situacao-planilha.py "C:/caminho/Programação de Produção 2026 <mês>.xlsx" data/situacao-planilha.csv
node --no-warnings src/baixas-planilha.mjs data/situacao-planilha.csv            # simulação: compara e mostra o que seria baixado
node --no-warnings src/baixas-planilha.mjs data/situacao-planilha.csv --aplicar  # grava as baixas
node --no-warnings src/baixas-planilha.mjs --desfazer                            # reabre tudo que foi baixado por planilha
```

- **Regra:** baixa quando todas as linhas do pedido na planilha são "entregue" (ou entregue + cancelado), ou todas "cancelado". Pedido com parte aberta,
  "entregue parcial" ou "devolução" não é baixado (aparece no relatório para decisão manual).
- **A baixa é local.** O Nomus continua com o pedido liberado. O pedido sai da lista em aberto, dos totais de material e da fila de aguardando, e vai para a
  visão **Encerrados** (filtro "Em aberto / Encerrados" na aba Pedidos). Dá para dar baixa ou reabrir um pedido à mão no detalhe dele.
- **Entregue não é pago:** pedidos encerrados podem ter saldo a receber (o relatório avisa); o assistente os encontra com `grupo=encerrados`.
- Em 24/11/2026 (planilha de novembro): 20 pedidos baixados (19 da carteira, 1 da fila de aguardando), 11 deles com R$ 160.989 ainda a receber.
