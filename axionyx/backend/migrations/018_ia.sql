-- =====================================================================
-- 018 — IA generativa opcional (AXIA): provedores, liberação por empresa, leitura de documentos e consultas ao jurídico.
-- Apenas CRIA tabelas novas; nenhum dado existente é alterado.
-- =====================================================================

-- Configuração da plataforma (linha única): provedor oferecido às empresas, modelos e limites
CREATE TABLE IF NOT EXISTS platform_ai_settings (
  id                     int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider               text CHECK (provider IN ('anthropic','openai','gemini')),
  models                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  availability           text NOT NULL DEFAULT 'liberadas' CHECK (availability IN ('todas','liberadas')),
  default_monthly_limit  int NOT NULL DEFAULT 300 CHECK (default_monthly_limit BETWEEN 0 AND 100000),
  updated_by             uuid REFERENCES users(id),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_ai_settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Chaves dos provedores, CIFRADAS (AES-256-GCM). Nunca voltam para o navegador; só os 4 últimos caracteres.
CREATE TABLE IF NOT EXISTS platform_ai_keys (
  provider    text PRIMARY KEY CHECK (provider IN ('anthropic','openai','gemini')),
  key_enc     text NOT NULL,
  last4       text NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Liberação e preferências de IA de cada empresa (opt-in com aceite do administrador)
CREATE TABLE IF NOT EXISTS company_ai (
  company_id        uuid PRIMARY KEY REFERENCES companies(id),
  platform_allowed  boolean NOT NULL DEFAULT false,
  monthly_limit     int CHECK (monthly_limit IS NULL OR monthly_limit BETWEEN 0 AND 100000),
  enabled           boolean NOT NULL DEFAULT false,
  accepted_by       uuid REFERENCES users(id),
  accepted_at       timestamptz,
  documents_enabled boolean NOT NULL DEFAULT true,
  blocked_folders   text[] NOT NULL DEFAULT '{}',
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Registro de uso (auditoria e limite mensal). Guarda a pergunta (resumida), não a resposta.
CREATE TABLE IF NOT EXISTS ai_usage (
  id             bigserial PRIMARY KEY,
  company_id     uuid NOT NULL REFERENCES companies(id),
  user_id        uuid REFERENCES users(id),
  engine         text NOT NULL CHECK (engine IN ('regras','ia')),
  provider       text,
  model          text,
  mode           text NOT NULL DEFAULT 'geral' CHECK (mode IN ('geral','juridico')),
  question       text NOT NULL,
  tools_used     jsonb NOT NULL DEFAULT '[]'::jsonb,
  documents_used jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_tokens   int,
  output_tokens  int,
  status         text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','erro','limite','fallback')),
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_company_month ON ai_usage(company_id, created_at);

-- Texto extraído dos documentos, em trechos, para a busca em português (sem acentos, sem extensões extras)
CREATE TABLE IF NOT EXISTS document_texts (
  document_id  uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id),
  method       text NOT NULL,
  pages        int,
  chars        int NOT NULL DEFAULT 0,
  status       text NOT NULL CHECK (status IN ('lido','sem_texto','nao_suportado','bloqueado','erro')),
  error        text,
  extracted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS document_chunks (
  id           bigserial PRIMARY KEY,
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id),
  idx          int NOT NULL,
  page         int,
  content      text NOT NULL,
  tsv          tsvector NOT NULL
);
CREATE INDEX IF NOT EXISTS document_chunks_tsv ON document_chunks USING gin(tsv);
CREATE INDEX IF NOT EXISTS document_chunks_doc ON document_chunks(document_id, idx);
CREATE INDEX IF NOT EXISTS document_chunks_company ON document_chunks(company_id);

-- Consultas encaminhadas ao jurídico (pergunta + pré-análise da IA + documentos usados)
CREATE TABLE IF NOT EXISTS legal_consultations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  number        int NOT NULL,
  asked_by      uuid REFERENCES users(id),
  question      text NOT NULL,
  ai_answer     text,
  ai_provider   text,
  sources       jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes         text,
  status        text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','respondida','arquivada')),
  response      text,
  responded_by  uuid REFERENCES users(id),
  responded_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);
CREATE INDEX IF NOT EXISTS legal_consultations_company ON legal_consultations(company_id, status, created_at DESC);
