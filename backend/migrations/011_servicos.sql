-- =====================================================================
-- 011 — Prestadores de serviço: Odontologia, Estética e Salão de beleza.
-- Serviços e pacotes no catálogo, profissionais (que podem ser também usuários/gerentes),
-- agenda com bloqueios, comissão por profissional, pacotes de sessões, prontuário/fichas,
-- odontograma e planos de tratamento.
-- Somente adições: nenhuma tabela ou dado existente é removido ou alterado.
-- =====================================================================

-- ---------- Catálogo: tipo do item (produto, serviço ou pacote de sessões) ----------
ALTER TABLE products ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'produto';
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_kind_check;
ALTER TABLE products ADD CONSTRAINT products_kind_check CHECK (kind IN ('produto','servico','pacote'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS duration_min int;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_duration_check;
ALTER TABLE products ADD CONSTRAINT products_duration_check CHECK (duration_min IS NULL OR duration_min BETWEEN 5 AND 720);
ALTER TABLE products ADD COLUMN IF NOT EXISTS commission_pct numeric(5,2);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_commission_check;
ALTER TABLE products ADD CONSTRAINT products_commission_check CHECK (commission_pct IS NULL OR commission_pct BETWEEN 0 AND 100);
ALTER TABLE products ADD COLUMN IF NOT EXISTS return_days int;            -- retorno sugerido (ex.: corte a cada 30 dias)
ALTER TABLE products ADD COLUMN IF NOT EXISTS service_code text;          -- item da lista de serviços (LC 116) para NFS-e
ALTER TABLE products ADD COLUMN IF NOT EXISTS package_service_id uuid REFERENCES products(id);
ALTER TABLE products ADD COLUMN IF NOT EXISTS package_sessions int;
ALTER TABLE products ADD COLUMN IF NOT EXISTS package_validity_days int;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_package_check;
ALTER TABLE products ADD CONSTRAINT products_package_check CHECK (kind <> 'pacote' OR (package_service_id IS NOT NULL AND package_sessions BETWEEN 1 AND 500));
CREATE INDEX IF NOT EXISTS products_kind_idx ON products(company_id, kind);

-- ---------- Profissionais (podem estar vinculados a um usuário — ex.: o gerente que também atende) ----------
CREATE TABLE IF NOT EXISTS professionals (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id),
  branch_id                uuid REFERENCES branches(id),           -- NULL = atende em todas as filiais
  user_id                  uuid REFERENCES users(id),
  name                     text NOT NULL,
  specialty                text,
  council_id               text,                                   -- ex.: CRO-SP 12345
  phone                    text,
  email                    text,
  color                    text NOT NULL DEFAULT '#0875D1',
  commission_services_pct  numeric(5,2) NOT NULL DEFAULT 0 CHECK (commission_services_pct BETWEEN 0 AND 100),
  commission_products_pct  numeric(5,2) NOT NULL DEFAULT 0 CHECK (commission_products_pct BETWEEN 0 AND 100),
  work_hours               jsonb NOT NULL DEFAULT '{}'::jsonb,     -- {"1":[["08:00","12:00"],["13:00","18:00"]], ...} (0 = domingo)
  slot_min                 int NOT NULL DEFAULT 30 CHECK (slot_min BETWEEN 5 AND 240),
  active                   boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS professionals_user_uq ON professionals(company_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS professionals_company_idx ON professionals(company_id, active);

-- Serviços que cada profissional executa (sem linhas = executa todos), com comissão/duração próprias opcionais
CREATE TABLE IF NOT EXISTS professional_services (
  professional_id  uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  company_id       uuid NOT NULL REFERENCES companies(id),
  commission_pct   numeric(5,2) CHECK (commission_pct IS NULL OR commission_pct BETWEEN 0 AND 100),
  duration_min     int CHECK (duration_min IS NULL OR duration_min BETWEEN 5 AND 720),
  PRIMARY KEY (professional_id, product_id)
);

-- ---------- Agenda ----------
CREATE TABLE IF NOT EXISTS appointments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  number           bigint NOT NULL,
  professional_id  uuid NOT NULL REFERENCES professionals(id),
  customer_id      uuid REFERENCES customers(id),
  guest_name       text,                                   -- cliente sem cadastro (encaixe rápido)
  guest_phone      text,
  start_at         timestamptz NOT NULL,
  end_at           timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'agendado' CHECK (status IN ('agendado','confirmado','em_atendimento','concluido','cancelado','faltou')),
  source           text NOT NULL DEFAULT 'balcao' CHECK (source IN ('balcao','telefone','whatsapp','online','retorno','plano')),
  room             text,
  notes            text,
  sale_id          uuid REFERENCES sales(id),
  treatment_plan_id uuid,
  confirmed_at     timestamptz,
  arrived_at       timestamptz,
  completed_at     timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  UNIQUE (company_id, number)
);
CREATE INDEX IF NOT EXISTS appointments_prof_idx ON appointments(professional_id, start_at);
CREATE INDEX IF NOT EXISTS appointments_company_idx ON appointments(company_id, start_at);
CREATE INDEX IF NOT EXISTS appointments_customer_idx ON appointments(customer_id, start_at DESC);

CREATE TABLE IF NOT EXISTS appointment_services (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id       uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  company_id           uuid NOT NULL REFERENCES companies(id),
  product_id           uuid NOT NULL REFERENCES products(id),
  variant_id           uuid NOT NULL REFERENCES product_variants(id),
  professional_id      uuid NOT NULL REFERENCES professionals(id),
  duration_min         int NOT NULL CHECK (duration_min BETWEEN 5 AND 720),
  price                numeric(14,2) NOT NULL CHECK (price >= 0),
  customer_package_id  uuid,
  plan_item_id         uuid,
  status               text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','realizado','cancelado')),
  sale_item_id         uuid REFERENCES sale_items(id),
  sort                 int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS appointment_services_appt_idx ON appointment_services(appointment_id);

-- Bloqueios de agenda (folga, almoço extra, curso...)
CREATE TABLE IF NOT EXISTS schedule_blocks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  professional_id  uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  start_at         timestamptz NOT NULL,
  end_at           timestamptz NOT NULL,
  reason           text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS schedule_blocks_prof_idx ON schedule_blocks(professional_id, start_at);

-- ---------- Pacotes de sessões vendidos ao cliente ----------
CREATE TABLE IF NOT EXISTS customer_packages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id),
  customer_id         uuid NOT NULL REFERENCES customers(id),
  package_product_id  uuid NOT NULL REFERENCES products(id),
  service_product_id  uuid NOT NULL REFERENCES products(id),
  sessions_total      int NOT NULL CHECK (sessions_total > 0),
  sessions_used       int NOT NULL DEFAULT 0 CHECK (sessions_used >= 0),
  price               numeric(14,2) NOT NULL DEFAULT 0,
  unit_value          numeric(14,4) NOT NULL DEFAULT 0,          -- valor por sessão (base da comissão na execução)
  sale_id             uuid REFERENCES sales(id),
  sale_item_id        uuid REFERENCES sale_items(id),
  status              text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','concluido','cancelado')),
  expires_at          date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (sessions_used <= sessions_total)
);
CREATE INDEX IF NOT EXISTS customer_packages_customer_idx ON customer_packages(customer_id, status);

CREATE TABLE IF NOT EXISTS package_usages (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL REFERENCES companies(id),
  customer_package_id     uuid NOT NULL REFERENCES customer_packages(id),
  appointment_id          uuid REFERENCES appointments(id),
  appointment_service_id  uuid UNIQUE REFERENCES appointment_services(id),
  professional_id         uuid REFERENCES professionals(id),
  user_id                 uuid REFERENCES users(id),
  used_at                 timestamptz NOT NULL DEFAULT now(),
  reversed_at             timestamptz
);

-- ---------- Comissão por profissional (serviços, produtos e sessões de pacote) ----------
CREATE TABLE IF NOT EXISTS professional_commissions (
  id               bigserial PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES companies(id),
  branch_id        uuid REFERENCES branches(id),
  professional_id  uuid NOT NULL REFERENCES professionals(id),
  kind             text NOT NULL CHECK (kind IN ('servico','produto','sessao_pacote')),
  ref_type         text NOT NULL CHECK (ref_type IN ('venda','cancelamento','devolucao','sessao','estorno_sessao')),
  ref_key          text NOT NULL,                                 -- idempotência: ex. "sale_item:<id>"
  sale_id          uuid REFERENCES sales(id),
  sale_item_id     uuid REFERENCES sale_items(id),
  appointment_id   uuid REFERENCES appointments(id),
  description      text,
  base_amount      numeric(14,2) NOT NULL,
  pct              numeric(5,2) NOT NULL,
  amount           numeric(14,2) NOT NULL,
  competence       date NOT NULL,
  status           text NOT NULL DEFAULT 'prevista' CHECK (status IN ('prevista','paga')),
  paid_at          timestamptz,
  paid_by          uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ref_type, ref_key)
);
CREATE INDEX IF NOT EXISTS professional_commissions_idx ON professional_commissions(company_id, professional_id, competence);

-- ---------- Rastreabilidade no item da venda ----------
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS professional_id uuid REFERENCES professionals(id);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS appointment_service_id uuid REFERENCES appointment_services(id);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS plan_item_id uuid;

-- ---------- Prontuário / fichas (registro clínico: somente acréscimo, correções viram adendo) ----------
CREATE TABLE IF NOT EXISTS clinical_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  professional_id  uuid REFERENCES professionals(id),
  appointment_id   uuid REFERENCES appointments(id),
  kind             text NOT NULL CHECK (kind IN ('anamnese','evolucao','ficha_tecnica','avaliacao','observacao')),
  title            text,
  content          text,
  data             jsonb NOT NULL DEFAULT '{}'::jsonb,
  amends_id        uuid REFERENCES clinical_records(id),
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clinical_records_customer_idx ON clinical_records(customer_id, created_at DESC);

-- ---------- Odontograma (histórico por dente; o estado atual é o registro mais recente) ----------
CREATE TABLE IF NOT EXISTS dental_chart_entries (
  id               bigserial PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES companies(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  tooth            smallint NOT NULL CHECK ((tooth BETWEEN 11 AND 18) OR (tooth BETWEEN 21 AND 28) OR (tooth BETWEEN 31 AND 38) OR (tooth BETWEEN 41 AND 48)
                                            OR (tooth BETWEEN 51 AND 55) OR (tooth BETWEEN 61 AND 65) OR (tooth BETWEEN 71 AND 75) OR (tooth BETWEEN 81 AND 85)),
  faces            text[] NOT NULL DEFAULT ARRAY[]::text[],
  condition        text NOT NULL CHECK (condition IN ('higido','carie','restaurado','ausente','extracao_indicada','canal','coroa','implante','protese','fratura','selante','mobilidade','outro')),
  status           text NOT NULL DEFAULT 'existente' CHECK (status IN ('existente','planejado','realizado')),
  notes            text,
  professional_id  uuid REFERENCES professionals(id),
  plan_item_id     uuid,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dental_chart_customer_idx ON dental_chart_entries(customer_id, tooth, created_at DESC);

-- ---------- Planos de tratamento / orçamentos clínicos ----------
CREATE TABLE IF NOT EXISTS treatment_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  number           bigint NOT NULL,
  customer_id      uuid NOT NULL REFERENCES customers(id),
  professional_id  uuid REFERENCES professionals(id),
  title            text,
  status           text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','apresentado','aprovado','em_andamento','concluido','recusado','cancelado')),
  subtotal         numeric(14,2) NOT NULL DEFAULT 0,
  discount         numeric(14,2) NOT NULL DEFAULT 0,
  total            numeric(14,2) NOT NULL DEFAULT 0,
  notes            text,
  valid_until      date,
  presented_at     timestamptz,
  approved_at      timestamptz,
  approved_by      uuid REFERENCES users(id),
  decline_reason   text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);
CREATE INDEX IF NOT EXISTS treatment_plans_customer_idx ON treatment_plans(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS treatment_plan_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id          uuid NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
  company_id       uuid NOT NULL REFERENCES companies(id),
  product_id       uuid NOT NULL REFERENCES products(id),
  variant_id       uuid NOT NULL REFERENCES product_variants(id),
  description      text,
  tooth            smallint,
  faces            text[] NOT NULL DEFAULT ARRAY[]::text[],
  qty              int NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 100),
  unit_price       numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  discount         numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total            numeric(14,2) NOT NULL,
  status           text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','realizado','cancelado')),
  performed_at     timestamptz,
  professional_id  uuid REFERENCES professionals(id),
  sale_id          uuid REFERENCES sales(id),
  sort             int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS treatment_plan_items_plan_idx ON treatment_plan_items(plan_id);

-- ---------- Mensagens: lembrete de agendamento e convite de retorno ----------
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_purpose_check;
ALTER TABLE messages ADD CONSTRAINT messages_purpose_check CHECK (purpose IN ('atendimento','pos_venda','aniversario','cobranca','condicional','campanha','agendamento','retorno'));
ALTER TABLE whatsapp_templates DROP CONSTRAINT IF EXISTS whatsapp_templates_purpose_check;
ALTER TABLE whatsapp_templates ADD CONSTRAINT whatsapp_templates_purpose_check CHECK (purpose IS NULL OR purpose IN ('pos_venda','aniversario','cobranca','condicional','campanha','atendimento','agendamento','retorno'));

-- ---------- Permissões dos novos recursos para os perfis padrão existentes ----------
UPDATE roles SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['agenda.ver','agenda.editar','agenda.todas','servicos.editar','profissionais.editar','prontuario.ver','prontuario.editar']) p)
 WHERE name IN ('Administrador', 'Gerente de Loja');
UPDATE roles SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['agenda.ver','agenda.editar','agenda.todas']) p)
 WHERE name = 'Vendedor';
