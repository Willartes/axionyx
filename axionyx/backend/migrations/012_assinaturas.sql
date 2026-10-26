-- =====================================================================
-- 012 — Assinaturas do AXIONYX (carteira de clientes da plataforma).
-- Apenas ACRESCENTA tabelas. Empresas já existentes ficam sem contrato e continuam
-- funcionando exatamente como antes (sem cobrança nem bloqueio) até que o
-- superadministrador vincule um contrato a elas.
-- =====================================================================

-- Planos comerciais
CREATE TABLE IF NOT EXISTS saas_plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  description    text,
  price_monthly  numeric(12,2) NOT NULL CHECK (price_monthly >= 0),
  max_users      int,
  max_branches   int,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Contrato (um por cliente). Nasce como proposta "em_analise" (auditoria ANTES do pagamento).
CREATE TABLE IF NOT EXISTS saas_contracts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          int GENERATED ALWAYS AS IDENTITY,
  company_id      uuid UNIQUE REFERENCES companies(id),
  lead_id         uuid REFERENCES site_leads(id),
  plan_id         uuid REFERENCES saas_plans(id),
  status          text NOT NULL DEFAULT 'em_analise' CHECK (status IN ('em_analise','recusado','aguardando_pagamento','ativo','inadimplente','suspenso','cancelado')),
  -- dados do cliente (usados para criar a empresa na aprovação)
  company_name    text NOT NULL,
  trade_name      text,
  cnpj            text,
  segment         text NOT NULL DEFAULT 'geral',
  tax_regime      text NOT NULL DEFAULT 'simples',
  contact_name    text NOT NULL,
  contact_email   text NOT NULL,
  contact_phone   text,
  contact_doc     text,               -- CPF do responsável (opcional)
  address         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- condições comerciais
  price           numeric(12,2) NOT NULL CHECK (price >= 0),
  billing_mode    text NOT NULL DEFAULT 'link_mensal' CHECK (billing_mode IN ('assinatura_cartao','link_mensal','manual')),
  grace_days      int NOT NULL DEFAULT 5 CHECK (grace_days BETWEEN 0 AND 60),
  paid_until      date,
  started_at      date,
  -- auditoria/risco
  risk_level      text NOT NULL DEFAULT 'baixo' CHECK (risk_level IN ('baixo','medio','alto')),
  risk_flags      jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  review_note     text,
  -- gateway
  mp_preapproval_id   text,
  mp_preapproval_status text,
  mp_checkout_url     text,
  payer_doc       text,               -- documento do último pagador aprovado (troca de titular)
  notes           text,
  cancel_reason   text,
  cancelled_at    timestamptz,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saas_contracts_status_idx ON saas_contracts(status);
CREATE UNIQUE INDEX IF NOT EXISTS saas_contracts_preapproval_uq ON saas_contracts(mp_preapproval_id) WHERE mp_preapproval_id IS NOT NULL;

-- Histórico de status do contrato (base para MRR, churn e linha do tempo)
CREATE TABLE IF NOT EXISTS saas_contract_events (
  id           bigserial PRIMARY KEY,
  contract_id  uuid NOT NULL REFERENCES saas_contracts(id),
  from_status  text,
  to_status    text NOT NULL,
  price        numeric(12,2),
  reason       text,
  user_id      uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saas_contract_events_idx ON saas_contract_events(contract_id, created_at);

-- Cobranças (mensalidades). period_start..period_end = período que a cobrança libera.
CREATE TABLE IF NOT EXISTS saas_charges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     uuid NOT NULL REFERENCES saas_contracts(id),
  kind            text NOT NULL DEFAULT 'mensalidade' CHECK (kind IN ('primeira','mensalidade','avulsa')),
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  due_date        date NOT NULL,
  status          text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','paga','cancelada','estornada','contestada')),
  method          text,               -- pix, cartao, manual...
  mp_preference_id text,
  mp_payment_id   text,
  mp_authorized_payment_id text,
  checkout_url    text,
  paid_at         timestamptz,
  paid_amount     numeric(12,2),
  fee_amount      numeric(12,2),
  payer_email     text,
  payer_doc       text,
  payer_name      text,
  attempts        int NOT NULL DEFAULT 0,
  last_status_detail text,
  manual_note     text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saas_charges_contract_idx ON saas_charges(contract_id, period_start DESC);
CREATE INDEX IF NOT EXISTS saas_charges_status_idx ON saas_charges(status, due_date);
CREATE UNIQUE INDEX IF NOT EXISTS saas_charges_payment_uq ON saas_charges(mp_payment_id) WHERE mp_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS saas_charges_open_period_uq ON saas_charges(contract_id, period_start) WHERE status IN ('pendente','paga') AND kind <> 'avulsa';

-- Fila de auditoria: novos contratos e exceções das renovações
CREATE TABLE IF NOT EXISTS saas_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id   uuid NOT NULL REFERENCES saas_contracts(id),
  charge_id     uuid REFERENCES saas_charges(id),
  kind          text NOT NULL CHECK (kind IN ('novo_contrato','inadimplencia','suspensao','chargeback','estorno','troca_titular','pagamento_divergente','assinatura_cartao','pagamento_recusado')),
  severity      text NOT NULL DEFAULT 'media' CHECK (severity IN ('baixa','media','alta')),
  status        text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','resolvida')),
  title         text NOT NULL,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution    text,
  resolved_by   uuid REFERENCES users(id),
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saas_reviews_open_idx ON saas_reviews(status, created_at DESC);
-- no máximo uma exceção aberta do mesmo tipo por contrato/cobrança
CREATE UNIQUE INDEX IF NOT EXISTS saas_reviews_open_uq ON saas_reviews(contract_id, kind, COALESCE(charge_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'aberta';

-- Notificações recebidas do gateway (registro bruto para auditoria e reprocessamento)
CREATE TABLE IF NOT EXISTS saas_gateway_events (
  id              bigserial PRIMARY KEY,
  provider        text NOT NULL DEFAULT 'mercadopago',
  topic           text,
  action          text,
  resource_id     text,
  request_id      text,
  signature_ok    boolean NOT NULL DEFAULT false,
  live_mode       boolean,
  payload         jsonb,
  status          text NOT NULL DEFAULT 'recebido' CHECK (status IN ('recebido','processado','ignorado','erro')),
  error           text,
  processed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saas_gateway_events_idx ON saas_gateway_events(created_at DESC);
