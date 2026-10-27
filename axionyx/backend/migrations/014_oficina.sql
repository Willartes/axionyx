-- =====================================================================
-- 014 — Oficina mecânica (carro e moto): veículos, ordens de serviço, itens (serviço, mão de obra por hora,
-- peças e produtos), checklist de entrada, aprovação do orçamento, garantia e lembretes de revisão.
-- Apenas ACRESCENTA tabelas/colunas. Nenhum dado existente é alterado (exceto conceder as novas permissões
-- aos perfis padrão, como nas versões anteriores).
-- =====================================================================

-- Retorno sugerido por quilometragem (ex.: troca de óleo a cada 5.000 km), além do retorno em dias que já existe
ALTER TABLE products ADD COLUMN IF NOT EXISTS return_km int;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_return_km_check;
ALTER TABLE products ADD CONSTRAINT products_return_km_check CHECK (return_km IS NULL OR return_km BETWEEN 100 AND 200000);

CREATE TABLE IF NOT EXISTS vehicles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  customer_id   uuid REFERENCES customers(id),
  type          text NOT NULL DEFAULT 'carro' CHECK (type IN ('carro','moto','utilitario','caminhao','outro')),
  plate         text,
  brand         text,
  model         text NOT NULL,
  version       text,
  year_fab      int CHECK (year_fab IS NULL OR year_fab BETWEEN 1900 AND 2100),
  year_model    int CHECK (year_model IS NULL OR year_model BETWEEN 1900 AND 2100),
  color         text,
  fuel          text,
  engine        text,
  vin           text,
  km_current    int CHECK (km_current IS NULL OR km_current >= 0),
  notes         text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_plate_uq ON vehicles(company_id, upper(plate)) WHERE plate IS NOT NULL;
CREATE INDEX IF NOT EXISTS vehicles_customer_idx ON vehicles(company_id, customer_id);

CREATE TABLE IF NOT EXISTS work_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  number           int NOT NULL,
  customer_id      uuid NOT NULL REFERENCES customers(id),
  vehicle_id       uuid NOT NULL REFERENCES vehicles(id),
  status           text NOT NULL DEFAULT 'orcamento' CHECK (status IN ('orcamento','aguardando_aprovacao','aprovada','em_execucao','aguardando_peca','pronta','entregue','cancelada')),
  km_in            int CHECK (km_in IS NULL OR km_in >= 0),
  fuel_level       text,
  complaint        text,
  diagnosis        text,
  checklist        jsonb NOT NULL DEFAULT '[]'::jsonb,
  professional_id  uuid REFERENCES professionals(id),
  labor_rate       numeric(12,2) NOT NULL DEFAULT 0,
  promised_at      timestamptz,
  approved_at      timestamptz,
  approved_by_name text,
  approval_channel text,
  started_at       timestamptz,
  finished_at      timestamptz,
  delivered_at     timestamptz,
  warranty_days    int NOT NULL DEFAULT 90 CHECK (warranty_days BETWEEN 0 AND 3650),
  warranty_until   date,
  sale_id          uuid REFERENCES sales(id),
  notes_customer   text,
  notes_internal   text,
  cancel_reason    text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);
CREATE INDEX IF NOT EXISTS work_orders_status_idx ON work_orders(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS work_orders_vehicle_idx ON work_orders(vehicle_id, created_at DESC);

CREATE TABLE IF NOT EXISTS work_order_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  work_order_id    uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('servico','mao_de_obra','peca','produto')),
  product_id       uuid NOT NULL REFERENCES products(id),
  variant_id       uuid NOT NULL REFERENCES product_variants(id),
  description      text NOT NULL,
  qty              numeric(12,3) NOT NULL CHECK (qty > 0),
  unit_price       numeric(12,4) NOT NULL CHECK (unit_price >= 0),
  discount         numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total            numeric(12,2) NOT NULL,
  professional_id  uuid REFERENCES professionals(id),
  status           text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovado','recusado')),
  added_after_approval boolean NOT NULL DEFAULT false,
  sale_item_id     uuid,
  sort             int NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_order_items_wo_idx ON work_order_items(work_order_id, sort);

CREATE TABLE IF NOT EXISTS work_order_events (
  id             bigserial PRIMARY KEY,
  work_order_id  uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  from_status    text,
  to_status      text,
  note           text,
  user_id        uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_order_events_idx ON work_order_events(work_order_id, id);

-- Lembretes de revisão (troca de óleo, filtros, correia...) gerados na entrega da OS
CREATE TABLE IF NOT EXISTS vehicle_reminders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  vehicle_id     uuid NOT NULL REFERENCES vehicles(id),
  product_id     uuid NOT NULL REFERENCES products(id),
  work_order_id  uuid REFERENCES work_orders(id),
  description    text NOT NULL,
  due_km         int,
  due_date       date,
  status         text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','feito','descartado')),
  contacted_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_reminders_idx ON vehicle_reminders(company_id, status, due_date);

ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS work_order_item_id uuid REFERENCES work_order_items(id);

-- ---------- Permissões dos novos recursos para os perfis padrão existentes ----------
UPDATE roles SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['oficina.ver','oficina.editar','oficina.aprovar']) p)
 WHERE name IN ('Administrador', 'Gerente de Loja');
UPDATE roles SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['oficina.ver','oficina.editar']) p)
 WHERE name IN ('Vendedor', 'Profissional');
