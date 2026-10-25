-- AXIONYX · 004 · Fiscal, integrações, mensagens, logística, CRM, RH, jurídico, contabilidade, documentos

CREATE TABLE fiscal_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  model           text NOT NULL CHECK (model IN ('55','65')),
  environment     text NOT NULL CHECK (environment IN ('homologacao','producao')),
  series          int NOT NULL,
  number          bigint,
  operation       text NOT NULL DEFAULT 'venda' CHECK (operation IN ('venda','devolucao','transferencia','remessa_condicional','remessa_consignacao')),
  sale_id         uuid REFERENCES sales(id),
  ref_type        text,
  ref_id          uuid,
  recipient       jsonb NOT NULL DEFAULT '{}'::jsonb,
  totals          jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','invalido','pendente_configuracao','fila','processando','autorizado','rejeitado','denegado','cancelado','contingencia','erro')),
  is_test         boolean NOT NULL DEFAULT true,
  access_key      text,
  protocol        text,
  provider        text,
  provider_ref    text,
  xml             text,
  danfe_url       text,
  validation      jsonb NOT NULL DEFAULT '[]'::jsonb,
  messages        jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts        int NOT NULL DEFAULT 0,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  authorized_at   timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text
);
CREATE UNIQUE INDEX fiscal_number_uq ON fiscal_documents(company_id, branch_id, model, series, environment, number) WHERE number IS NOT NULL;
CREATE UNIQUE INDEX fiscal_sale_uq ON fiscal_documents(sale_id, model) WHERE sale_id IS NOT NULL AND status NOT IN ('cancelado','invalido','rejeitado','erro');
CREATE INDEX ON fiscal_documents(company_id, created_at DESC);

CREATE TABLE fiscal_events (
  id           bigserial PRIMARY KEY,
  document_id  uuid NOT NULL REFERENCES fiscal_documents(id),
  type         text NOT NULL,
  status       text NOT NULL,
  message      text,
  request      jsonb,
  response     jsonb,
  user_id      uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  kind          text NOT NULL CHECK (kind IN ('ecommerce','logistica','whatsapp','fiscal','assistente_ia','banco')),
  provider      text NOT NULL,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'pendente_configuracao' CHECK (status IN ('pendente_configuracao','ativo','erro','desativado')),
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_env    text,
  last_sync_at  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, kind, provider)
);

CREATE TABLE external_ids (
  company_id      uuid NOT NULL REFERENCES companies(id),
  integration_id  uuid NOT NULL REFERENCES integrations(id),
  entity          text NOT NULL,
  local_id        uuid NOT NULL,
  external_id     text NOT NULL,
  payload_hash    text,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, entity, local_id),
  UNIQUE (integration_id, entity, external_id)
);

CREATE TABLE outbox (
  id               bigserial PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES companies(id),
  integration_id   uuid REFERENCES integrations(id),
  topic            text NOT NULL,
  payload          jsonb NOT NULL,
  dedupe_key       text NOT NULL,
  status           text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','processando','enviado','erro','aguardando_configuracao','descartado')),
  attempts         int NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  UNIQUE (company_id, dedupe_key)
);
CREATE INDEX ON outbox(status, next_attempt_at);

CREATE TABLE integration_logs (
  id              bigserial PRIMARY KEY,
  company_id      uuid NOT NULL,
  integration_id  uuid,
  direction       text NOT NULL CHECK (direction IN ('saida','entrada')),
  topic           text NOT NULL,
  status          text NOT NULL,
  message         text,
  request         jsonb,
  response        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON integration_logs(company_id, created_at DESC);

CREATE TABLE messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  customer_id          uuid REFERENCES customers(id),
  channel              text NOT NULL DEFAULT 'whatsapp',
  purpose              text NOT NULL CHECK (purpose IN ('atendimento','pos_venda','aniversario','cobranca','condicional','campanha')),
  template             text,
  to_address           text,
  body                 text,
  ref_type             text,
  ref_id               text,
  status               text NOT NULL CHECK (status IN ('pendente_configuracao','bloqueado_sem_consentimento','fila','enviado','entregue','lido','erro')),
  provider_message_id  text,
  error                text,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz
);
CREATE UNIQUE INDEX messages_dedupe_uq ON messages(company_id, purpose, customer_id, ref_type, ref_id) WHERE ref_id IS NOT NULL AND status NOT IN ('erro');

CREATE TABLE shipments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  ref_type      text NOT NULL,
  ref_id        uuid NOT NULL,
  provider      text,
  service       text,
  quote         jsonb,
  price         numeric(14,2),
  tracking_code text,
  label_url     text,
  status        text NOT NULL DEFAULT 'cotacao' CHECK (status IN ('cotacao','pendente_configuracao','etiqueta_gerada','postado','entregue','cancelado','manual')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- CRM
CREATE TABLE opportunities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  title        text NOT NULL,
  customer_id  uuid REFERENCES customers(id),
  contact      text,
  value        numeric(14,2) NOT NULL DEFAULT 0,
  probability  int NOT NULL DEFAULT 10 CHECK (probability BETWEEN 0 AND 100),
  stage        text NOT NULL DEFAULT 'Prospecção' CHECK (stage IN ('Prospecção','Qualificação','Proposta','Negociação','Fechamento','Perdido')),
  owner_id     uuid REFERENCES users(id),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- RH
CREATE TABLE employees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  branch_id       uuid REFERENCES branches(id),
  user_id         uuid REFERENCES users(id),
  name            text NOT NULL,
  cpf             text,
  email           text,
  phone           text,
  job_title       text,
  department      text,
  admission_date  date,
  salary          numeric(14,2),
  status          text NOT NULL DEFAULT 'Ativo' CHECK (status IN ('Ativo','Férias','Afastado','Desligado')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Jurídico
CREATE TABLE legal_cases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  number         text NOT NULL,
  title          text NOT NULL,
  kind           text NOT NULL,
  court          text,
  counterpart    text,
  status         text NOT NULL DEFAULT 'Em andamento',
  risk           text NOT NULL DEFAULT 'Médio' CHECK (risk IN ('Baixo','Médio','Alto')),
  amount         numeric(14,2) NOT NULL DEFAULT 0,
  next_deadline  date,
  lawyer         text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Contabilidade: plano de contas
CREATE TABLE chart_of_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  code        text NOT NULL,
  name        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('Ativo','Passivo','Patrimônio Líquido','Receita','Despesa','Custo')),
  nature      text NOT NULL CHECK (nature IN ('Devedora','Credora')),
  analytic    boolean NOT NULL DEFAULT false,
  UNIQUE (company_id, code)
);

-- Documentos (GED simples)
CREATE TABLE documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  folder       text NOT NULL DEFAULT 'Geral',
  name         text NOT NULL,
  mime         text NOT NULL,
  size         int NOT NULL,
  content      bytea NOT NULL,
  entity       text,
  entity_id    uuid,
  uploaded_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON documents(company_id, folder);
