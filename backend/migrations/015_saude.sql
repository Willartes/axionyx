-- =====================================================================
-- 015 — Clínicas e consultórios de saúde (todas as especialidades; profissional autônomo ou clínica).
-- Conselho profissional, perfil de saúde do paciente, convênios (tabela de preços, guias, lotes, glosas),
-- recepção (chegada/chamada), documentos clínicos (receita, atestado, declaração, exames, encaminhamento...),
-- sigilo por registro no prontuário (ex.: psicologia), sinais vitais e CID.
-- Apenas ACRESCENTA tabelas/colunas; nenhum dado existente é alterado (exceto conceder as novas permissões
-- aos perfis padrão, como nas versões anteriores).
-- =====================================================================

-- ---------- Profissional: conselho de classe estruturado ----------
ALTER TABLE professionals ADD COLUMN IF NOT EXISTS council          text;    -- CRM, CRP, CREFITO, CRN, CRFa, COREN, CRO...
ALTER TABLE professionals ADD COLUMN IF NOT EXISTS council_number   text;
ALTER TABLE professionals ADD COLUMN IF NOT EXISTS council_uf       text;
ALTER TABLE professionals ADD COLUMN IF NOT EXISTS rqe              text;    -- registro de qualificação de especialista (médicos)
ALTER TABLE professionals ADD COLUMN IF NOT EXISTS restrict_records boolean NOT NULL DEFAULT false; -- registros do prontuário sigilosos por padrão

-- ---------- Paciente ----------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS social_name text;            -- nome social
ALTER TABLE customers ADD COLUMN IF NOT EXISTS cns         text;            -- Cartão Nacional de Saúde (SUS)

-- ---------- Convênios / planos de saúde ----------
CREATE TABLE IF NOT EXISTS insurers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  name          text NOT NULL,
  ans_code      text,                 -- registro da operadora na ANS
  cnpj          text,
  phone         text,
  email         text,
  portal_url    text,
  payment_days  int NOT NULL DEFAULT 30 CHECK (payment_days BETWEEN 0 AND 365),
  requires_authorization boolean NOT NULL DEFAULT false,
  notes         text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS insurers_name_uq ON insurers(company_id, lower(name));

-- Tabela de preços por convênio (TUSS opcional); sem linha = usa o preço particular do serviço
CREATE TABLE IF NOT EXISTS insurer_prices (
  insurer_id   uuid NOT NULL REFERENCES insurers(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id),
  tuss_code    text,
  price        numeric(14,2) NOT NULL CHECK (price >= 0),
  PRIMARY KEY (insurer_id, product_id)
);

-- Perfil de saúde do paciente (1:1). Campos clínicos só aparecem para quem pode ver o prontuário.
CREATE TABLE IF NOT EXISTS patient_profiles (
  customer_id           uuid PRIMARY KEY REFERENCES customers(id),
  company_id            uuid NOT NULL REFERENCES companies(id),
  insurer_id            uuid REFERENCES insurers(id),
  insurance_plan        text,
  insurance_card        text,
  insurance_valid_until date,
  guardian_name         text,          -- responsável legal (menores e tutelados)
  guardian_doc          text,
  guardian_relation     text,
  emergency_name        text,
  emergency_phone       text,
  blood_type            text,
  allergies             text,
  chronic_conditions    text,
  medications           text,
  updated_by            uuid REFERENCES users(id),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------- Agenda: pagador, convênio, tipo de atendimento, teleconsulta e recepção ----------
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payer              text NOT NULL DEFAULT 'particular';
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_payer_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_payer_check CHECK (payer IN ('particular','convenio','cortesia'));
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS insurer_id         uuid REFERENCES insurers(id);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS insurance_card     text;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS guide_number       text;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS authorization_code text;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS visit_type         text;
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_visit_type_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_visit_type_check CHECK (visit_type IS NULL OR visit_type IN ('primeira','retorno','sessao','procedimento','exame','teleconsulta'));
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS telehealth_url     text;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS called_at          timestamptz;

-- ---------- Faturamento de convênio: guias (uma por serviço realizado) e lotes ----------
CREATE TABLE IF NOT EXISTS insurance_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  insurer_id    uuid NOT NULL REFERENCES insurers(id),
  number        int NOT NULL,
  reference     text,                 -- competência (ex.: 2026-10)
  status        text NOT NULL DEFAULT 'enviado' CHECK (status IN ('enviado','pago_parcial','pago','cancelado')),
  sent_at       timestamptz NOT NULL DEFAULT now(),
  expected_at   date,
  total         numeric(14,2) NOT NULL DEFAULT 0,
  paid_total    numeric(14,2) NOT NULL DEFAULT 0,
  gloss_total   numeric(14,2) NOT NULL DEFAULT 0,
  protocol      text,                 -- protocolo de envio no portal da operadora
  notes         text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);

CREATE TABLE IF NOT EXISTS insurance_claims (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id),
  branch_id          uuid REFERENCES branches(id),
  insurer_id         uuid NOT NULL REFERENCES insurers(id),
  customer_id        uuid REFERENCES customers(id),
  professional_id    uuid REFERENCES professionals(id),
  appointment_id     uuid REFERENCES appointments(id),
  appointment_service_id uuid UNIQUE,
  product_id         uuid REFERENCES products(id),
  description        text NOT NULL,
  tuss_code          text,
  amount             numeric(14,2) NOT NULL CHECK (amount >= 0),
  service_date       date NOT NULL,
  insurance_card     text,
  guide_number       text,
  authorization_code text,
  status             text NOT NULL DEFAULT 'a_faturar' CHECK (status IN ('a_faturar','enviado','pago','glosado','cancelado')),
  batch_id           uuid REFERENCES insurance_batches(id),
  paid_amount        numeric(14,2),
  gloss_reason       text,
  paid_at            date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS insurance_claims_status_idx ON insurance_claims(company_id, status, insurer_id, service_date);
ALTER TABLE appointment_services ADD COLUMN IF NOT EXISTS claim_id uuid REFERENCES insurance_claims(id);

-- ---------- Prontuário: sigilo por registro, especialidade, CID, sinais vitais e integridade ----------
ALTER TABLE clinical_records ADD COLUMN IF NOT EXISTS visibility   text NOT NULL DEFAULT 'equipe';
ALTER TABLE clinical_records DROP CONSTRAINT IF EXISTS clinical_records_visibility_check;
ALTER TABLE clinical_records ADD CONSTRAINT clinical_records_visibility_check CHECK (visibility IN ('equipe','restrito'));
ALTER TABLE clinical_records ADD COLUMN IF NOT EXISTS specialty    text;
ALTER TABLE clinical_records ADD COLUMN IF NOT EXISTS cid_codes    text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE clinical_records ADD COLUMN IF NOT EXISTS vitals       jsonb;
ALTER TABLE clinical_records ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE clinical_records DROP CONSTRAINT IF EXISTS clinical_records_kind_check;
ALTER TABLE clinical_records ADD CONSTRAINT clinical_records_kind_check CHECK (kind IN ('anamnese','evolucao','ficha_tecnica','avaliacao','observacao','consulta','sessao','resultado_exame'));

-- ---------- Documentos clínicos (nunca apagados: cancelamento com motivo) ----------
CREATE TABLE IF NOT EXISTS clinical_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  number           int NOT NULL,
  customer_id      uuid NOT NULL REFERENCES customers(id),
  professional_id  uuid NOT NULL REFERENCES professionals(id),
  appointment_id   uuid REFERENCES appointments(id),
  kind             text NOT NULL CHECK (kind IN ('receita','atestado','declaracao','exames','encaminhamento','laudo','orientacoes','consentimento')),
  content          jsonb NOT NULL,
  visibility       text NOT NULL DEFAULT 'equipe' CHECK (visibility IN ('equipe','restrito')),
  content_hash     text NOT NULL,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id),
  cancelled_at     timestamptz,
  cancel_reason    text,
  UNIQUE (company_id, number)
);
CREATE INDEX IF NOT EXISTS clinical_documents_customer_idx ON clinical_documents(customer_id, issued_at DESC);

-- ---------- Permissões dos novos recursos para os perfis padrão existentes ----------
UPDATE roles SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['convenios.ver','convenios.editar','prontuario.documentos']) p)
 WHERE name = 'Administrador';
UPDATE roles SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['convenios.ver','convenios.editar']) p)
 WHERE name = 'Gerente de Loja';
UPDATE roles SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['prontuario.documentos','convenios.ver']) p)
 WHERE name = 'Profissional';

-- Comissão do profissional sobre o valor recebido do convênio (repasse)
ALTER TABLE professional_commissions DROP CONSTRAINT IF EXISTS professional_commissions_ref_type_check;
ALTER TABLE professional_commissions ADD CONSTRAINT professional_commissions_ref_type_check CHECK (ref_type IN ('venda','cancelamento','devolucao','sessao','estorno_sessao','convenio','estorno_convenio'));
