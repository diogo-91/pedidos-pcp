-- Espelho local do Nomus (somente leitura). Valores em reais (REAL); datas em ISO (aaaa-mm-dd).
-- Toda tabela guarda o JSON bruto devolvido pela API em raw_json: se o Nomus mudar um campo ou se
-- precisarmos de um dado que ainda não foi extraído em coluna, reprocessa-se sem chamar a API de novo.

CREATE TABLE IF NOT EXISTS sync_run (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  iniciado_em    TEXT NOT NULL,
  finalizado_em  TEXT,
  status         TEXT NOT NULL DEFAULT 'rodando',   -- rodando | ok | parcial | erro
  etapas         TEXT NOT NULL DEFAULT '',
  resumo_json    TEXT,
  erro           TEXT
);

CREATE TABLE IF NOT EXISTS cliente (
  id             INTEGER PRIMARY KEY,               -- id da pessoa no Nomus
  nome           TEXT NOT NULL DEFAULT '',
  telefone       TEXT NOT NULL DEFAULT '',
  municipio      TEXT NOT NULL DEFAULT '',
  uf             TEXT NOT NULL DEFAULT '',
  endereco_completo TEXT NOT NULL DEFAULT '',   -- rua, número, complemento, bairro, cidade/UF e CEP em uma linha
  cep            TEXT NOT NULL DEFAULT '',
  raw_json       TEXT NOT NULL,
  atualizado_em  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS produto (
  id             INTEGER PRIMARY KEY,               -- id do produto no Nomus
  codigo         TEXT NOT NULL DEFAULT '',
  descricao      TEXT NOT NULL DEFAULT '',
  tipo           TEXT NOT NULL DEFAULT '',
  unidade        TEXT NOT NULL DEFAULT '',
  raw_json       TEXT NOT NULL,
  atualizado_em  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS forma_pagamento (
  id             INTEGER PRIMARY KEY,
  nome           TEXT NOT NULL DEFAULT '',
  raw_json       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pedido (
  id                    INTEGER PRIMARY KEY,        -- id do pedido no Nomus
  codigo                TEXT NOT NULL DEFAULT '',   -- "PD 01279"
  numero                INTEGER,                    -- 1279
  id_empresa            INTEGER,
  id_cliente            INTEGER,
  id_vendedor           INTEGER,
  data_emissao          TEXT,
  data_modificacao      TEXT,
  data_entrega_padrao   TEXT,
  valor_total           REAL,
  valor_frete           REAL,
  valor_outras_despesas REAL,
  id_forma_pagamento    INTEGER,
  condicao_pagamento    TEXT NOT NULL DEFAULT '',
  observacoes           TEXT NOT NULL DEFAULT '',
  observacoes_internas  TEXT NOT NULL DEFAULT '',
  liberado              INTEGER NOT NULL DEFAULT 1, -- 1 = tem item Liberado na última sincronização completa
  ultimo_sync_id        INTEGER,
  raw_json              TEXT NOT NULL,
  atualizado_em         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pedido_numero  ON pedido (numero);
CREATE INDEX IF NOT EXISTS idx_pedido_cliente ON pedido (id_cliente);

CREATE TABLE IF NOT EXISTS pedido_item (
  id                  INTEGER PRIMARY KEY,          -- id do item no Nomus
  pedido_id           INTEGER NOT NULL REFERENCES pedido (id) ON DELETE CASCADE,
  item                TEXT NOT NULL DEFAULT '',     -- texto do item (medidas/cor em texto livre)
  id_produto          INTEGER,
  status              INTEGER,                      -- 1 aguardando liberação, 2 liberado, 3 atend. parcial, 4 atend. total
  quantidade          REAL,
  id_unidade_medida   INTEGER,
  valor_unitario      REAL,
  valor_desconto      REAL,
  percentual_desconto REAL,
  valor_acrescimo     REAL,
  percentual_acrescimo REAL,
  data_entrega        TEXT,
  info_adicional      TEXT NOT NULL DEFAULT '',
  observacoes         TEXT NOT NULL DEFAULT '',
  raw_json            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_pedido  ON pedido_item (pedido_id);
CREATE INDEX IF NOT EXISTS idx_item_produto ON pedido_item (id_produto);
CREATE INDEX IF NOT EXISTS idx_item_status  ON pedido_item (status);

CREATE TABLE IF NOT EXISTS pedido_parcela (
  pedido_id          INTEGER NOT NULL REFERENCES pedido (id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  valor              REAL,
  id_forma_pagamento INTEGER,
  data_vencimento    TEXT,
  gera_adiantamento  INTEGER NOT NULL DEFAULT 0,   -- entrada/sinal (parcela que gera adiantamento)
  observacao         TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (pedido_id, seq)
);

CREATE TABLE IF NOT EXISTS ordem (
  id                 INTEGER PRIMARY KEY,           -- id da OP no Nomus
  nome               TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT '',
  inicio_planejado   TEXT,
  raw_json           TEXT NOT NULL,
  atualizado_em      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ordem_item (
  ordem_id           INTEGER NOT NULL REFERENCES ordem (id) ON DELETE CASCADE,
  item_pedido_id     INTEGER NOT NULL,
  PRIMARY KEY (ordem_id, item_pedido_id)
);
CREATE INDEX IF NOT EXISTS idx_ordem_item_item ON ordem_item (item_pedido_id);

-- Parcelas a receber ligadas ao pedido pela descrição "Pedido PD nnnnn - Parcela x de y".
CREATE TABLE IF NOT EXISTS conta_receber (
  id                 INTEGER PRIMARY KEY,
  pedido_numero      INTEGER,
  descricao          TEXT NOT NULL DEFAULT '',
  id_empresa         INTEGER,
  valor              REAL,
  recebido           REAL,
  saldo              REAL,
  data_vencimento    TEXT,
  data_baixa         TEXT,
  data_competencia   TEXT,
  quitada            INTEGER NOT NULL DEFAULT 0,
  forma_pagamento    TEXT NOT NULL DEFAULT '',
  raw_json           TEXT NOT NULL,
  atualizado_em      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conta_pedido ON conta_receber (pedido_numero);

-- ---------------------------------------------------------------- visões

-- Pedidos em aberto = com item Liberado na última sincronização.
CREATE VIEW IF NOT EXISTS v_pedido_aberto AS
SELECT p.id, p.codigo, p.numero, p.data_emissao, p.data_entrega_padrao, p.valor_total,
       c.nome AS cliente, c.telefone, c.municipio, c.uf,
       (SELECT COUNT(*) FROM pedido_item i WHERE i.pedido_id = p.id) AS itens,
       (SELECT COUNT(*) FROM pedido_item i WHERE i.pedido_id = p.id AND i.status = 2) AS itens_liberados,
       (SELECT MIN(i.data_entrega) FROM pedido_item i WHERE i.pedido_id = p.id AND i.status = 2) AS primeira_entrega
FROM pedido p LEFT JOIN cliente c ON c.id = p.id_cliente
WHERE p.liberado = 1;

-- Situação financeira por pedido (a partir das parcelas a receber).
CREATE VIEW IF NOT EXISTS v_financeiro_pedido AS
SELECT pedido_numero AS numero,
       COUNT(*)                                             AS parcelas,
       ROUND(SUM(valor), 2)                                 AS valor,
       ROUND(SUM(recebido), 2)                              AS recebido,
       ROUND(SUM(CASE WHEN quitada = 0 THEN saldo ELSE 0 END), 2) AS saldo_aberto,
       ROUND(SUM(CASE WHEN quitada = 0 AND data_vencimento < date('now') THEN saldo ELSE 0 END), 2) AS vencido,
       MIN(CASE WHEN quitada = 0 THEN data_vencimento END)  AS proximo_vencimento
FROM conta_receber
GROUP BY pedido_numero;

-- ---------------------------------------------------------------- cálculo de materiais

-- Coeficientes das regras de produção (editáveis). Fonte: áudios/texto do PCP de 08/11/2026; bobina 3,2 confirmada pelo Diogo em 24/11/2026.
CREATE TABLE IF NOT EXISTS parametro_calculo (
  chave      TEXT PRIMARY KEY,
  valor      REAL NOT NULL,
  descricao  TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO parametro_calculo (chave, valor, descricao) VALUES
  ('bobina_kg_por_metro',       3.2, 'kg de bobina por metro de chapa'),
  ('chapas_simples',            1,   'chapas por metro de telha simples'),
  ('chapas_semi',               1,   'chapas por metro de telha semi-sanduíche (igual à simples)'),
  ('chapas_sanduiche',          2,   'chapas por metro de telha sanduíche (duas chapas)'),
  ('chapas_forro',              2,   'chapas por metro de telha forro (igual à sanduíche)'),
  ('cola_m2_por_tubo',          50,  'rendimento de um tubo de cola, em m²'),
  ('cola_fator_sanduiche_forro', 2,  'sanduíche e forro: metros × 2 ÷ rendimento do tubo'),
  ('cola_fator_semi',           1,   'semi-sanduíche: metros ÷ rendimento do tubo'),
  ('tinta_m2_por_kg',           5,   '1 kg de tinta pinta 5 m² (por face)');

-- Resultado do cálculo por item liberado. Valores exatos (sem arredondar); o arredondamento é por pedido (pedido_material).
CREATE TABLE IF NOT EXISTS item_calculo (
  item_id        INTEGER PRIMARY KEY REFERENCES pedido_item (id) ON DELETE CASCADE,
  pedido_id      INTEGER NOT NULL,
  categoria      TEXT NOT NULL,      -- SIMPLES | SANDUICHE | SEMI | FORRO | FORRO_PVC | PAINEL | ACESSORIO | SERVICO_PINTURA | REVENDA | SEM_PRODUTO
  situacao       TEXT NOT NULL,      -- calculado | revisar | sem_regra | revenda
  metros         REAL,               -- quantidade do item em M2 (metros lineares de telha)
  faces          INTEGER,            -- faces pintadas (0, 1 ou 2)
  bobina_kg      REAL,
  eps_m          REAL,
  cola_tubos     REAL,
  tinta_kg       REAL,
  aviso          TEXT NOT NULL DEFAULT '',
  calculado_em   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_calculo_pedido ON item_calculo (pedido_id);

-- Tinta por cor (um item com duas faces e duas cores divide o total).
CREATE TABLE IF NOT EXISTS item_tinta (
  item_id   INTEGER NOT NULL REFERENCES pedido_item (id) ON DELETE CASCADE,
  cor       TEXT NOT NULL,           -- nome canônico ou 'A DEFINIR'
  kg        REAL NOT NULL,
  PRIMARY KEY (item_id, cor)
);

-- Total por pedido. EPS e cola são arredondados PARA CIMA no total do pedido (regra do PCP); *_exato guarda o valor sem arredondar.
CREATE TABLE IF NOT EXISTS pedido_material (
  pedido_id          INTEGER PRIMARY KEY REFERENCES pedido (id) ON DELETE CASCADE,
  bobina_kg          REAL NOT NULL DEFAULT 0,
  eps_m_exato        REAL NOT NULL DEFAULT 0,
  eps_m              INTEGER NOT NULL DEFAULT 0,
  cola_tubos_exato   REAL NOT NULL DEFAULT 0,
  cola_tubos         INTEGER NOT NULL DEFAULT 0,
  tinta_kg           REAL NOT NULL DEFAULT 0,
  itens_calculados   INTEGER NOT NULL DEFAULT 0,
  itens_a_revisar    INTEGER NOT NULL DEFAULT 0,
  itens_sem_regra    INTEGER NOT NULL DEFAULT 0,
  calculado_em       TEXT NOT NULL
);

-- Registro local das conversas com o assistente de IA (pergunta, resposta, ferramentas consultadas, tokens). Também serve de contador diário.
CREATE TABLE IF NOT EXISTS assistente_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  em                TEXT NOT NULL,
  pergunta          TEXT NOT NULL,
  resposta          TEXT,
  ferramentas_json  TEXT,
  uso_json          TEXT,
  modelo            TEXT,
  erro              TEXT
);

-- Pedidos "encerrados" localmente (entregues ou cancelados segundo a planilha de programação, ou baixados à mão na tela). O Nomus não é alterado:
-- o pedido continua liberado lá, mas sai da lista "em aberto" daqui (e aparece na visão "Encerrados"). Reabrir = apagar a linha.
CREATE TABLE IF NOT EXISTS baixa_pedido (
  numero       INTEGER PRIMARY KEY,   -- número do pedido (PD 01234 = 1234)
  situacao     TEXT NOT NULL,         -- entregue | cancelado | ...
  origem       TEXT NOT NULL,         -- 'planilha AAAA-MM-DD' ou 'manual'
  motivo       TEXT NOT NULL DEFAULT '',
  baixado_em   TEXT NOT NULL
);
