-- AXIONYX · 002 · Cadastros, produtos com grade, estoque, compras

CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  code          bigint NOT NULL,
  type          text NOT NULL DEFAULT 'PF' CHECK (type IN ('PF','PJ')),
  name          text NOT NULL,
  trade_name    text,
  cpf_cnpj      text,
  ie            text,
  email         text,
  phone         text,
  whatsapp      text,
  birth_date    date,
  gender        text,
  address       jsonb NOT NULL DEFAULT '{}'::jsonb,
  credit_limit  numeric(14,2) NOT NULL DEFAULT 0,
  preferences   jsonb NOT NULL DEFAULT '{}'::jsonb,
  tags          text[] NOT NULL DEFAULT ARRAY[]::text[],
  notes         text,
  is_partner    boolean NOT NULL DEFAULT false, -- revendedora/consignatária
  active        boolean NOT NULL DEFAULT true,
  anonymized_at timestamptz,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE UNIQUE INDEX customers_doc_uq ON customers(company_id, cpf_cnpj) WHERE cpf_cnpj IS NOT NULL AND anonymized_at IS NULL;
CREATE INDEX ON customers(company_id, lower(name));

-- Registro de consentimento (LGPD) — append-only, o vigente é o mais recente por canal
CREATE TABLE customer_consents (
  id           bigserial PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id),
  customer_id  uuid NOT NULL REFERENCES customers(id),
  channel      text NOT NULL CHECK (channel IN ('whatsapp','email','sms','marketing','preferencias')),
  granted      boolean NOT NULL,
  source       text NOT NULL DEFAULT 'loja',
  ip           text,
  user_id      uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON customer_consents(customer_id, channel, created_at DESC);

CREATE TABLE suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL,
  trade_name  text,
  cnpj        text,
  ie          text,
  email       text,
  phone       text,
  address     jsonb NOT NULL DEFAULT '{}'::jsonb,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suppliers_cnpj_uq ON suppliers(company_id, cnpj) WHERE cnpj IS NOT NULL;

CREATE TABLE brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
CREATE TABLE collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL, season text, year int, starts_on date, ends_on date,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL, parent_id uuid REFERENCES categories(id), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (company_id, name)
);
CREATE TABLE sizes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  grid text NOT NULL DEFAULT 'Padrão', code text NOT NULL, sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true, UNIQUE (company_id, grid, code)
);
CREATE TABLE colors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL, code text, hex text, active boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, name)
);

CREATE TABLE products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  code           text NOT NULL,
  name           text NOT NULL,
  short_name     text,
  description    text,
  brand_id       uuid REFERENCES brands(id),
  collection_id  uuid REFERENCES collections(id),
  category_id    uuid REFERENCES categories(id),
  supplier_id    uuid REFERENCES suppliers(id),
  supplier_ref   text,
  gender         text,
  unit           text NOT NULL DEFAULT 'UN',
  ncm            text,
  cest           text,
  origin         int NOT NULL DEFAULT 0,
  cfop           text NOT NULL DEFAULT '5102',
  cst_csosn      text NOT NULL DEFAULT '102',
  cost_price     numeric(14,2) NOT NULL DEFAULT 0,
  sale_price     numeric(14,2) NOT NULL DEFAULT 0,
  min_stock      int NOT NULL DEFAULT 0,
  track_stock    boolean NOT NULL DEFAULT true,
  weight_kg      numeric(10,3),
  images         jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags           text[] NOT NULL DEFAULT ARRAY[]::text[],
  active         boolean NOT NULL DEFAULT true,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE INDEX ON products(company_id, lower(name));

CREATE TABLE product_variants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  product_id   uuid NOT NULL REFERENCES products(id),
  size_id      uuid REFERENCES sizes(id),
  color_id     uuid REFERENCES colors(id),
  sku          text NOT NULL,
  barcode      text,
  cost_price   numeric(14,2),
  sale_price   numeric(14,2),
  min_stock    int,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, sku),
  UNIQUE (product_id, size_id, color_id)
);
CREATE UNIQUE INDEX variants_barcode_uq ON product_variants(company_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX ON product_variants(product_id);

-- Saldo por filial e variação. qty = disponível fisicamente na loja.
CREATE TABLE stock_balances (
  company_id  uuid NOT NULL REFERENCES companies(id),
  branch_id   uuid NOT NULL REFERENCES branches(id),
  variant_id  uuid NOT NULL REFERENCES product_variants(id),
  qty         int NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, variant_id)
);
CREATE INDEX ON stock_balances(company_id);

CREATE TABLE stock_movements (
  id            bigserial PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES companies(id),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  variant_id    uuid NOT NULL REFERENCES product_variants(id),
  type          text NOT NULL CHECK (type IN ('entrada','saida','ajuste','transferencia_saida','transferencia_entrada',
                    'venda','cancelamento_venda','devolucao','condicional_saida','condicional_retorno',
                    'consignacao_saida','consignacao_retorno','inventario','compra','estorno_compra')),
  qty           int NOT NULL,
  balance_after int NOT NULL,
  unit_cost     numeric(14,2),
  ref_type      text,
  ref_id        uuid,
  notes         text,
  user_id       uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON stock_movements(company_id, branch_id, created_at DESC);
CREATE INDEX ON stock_movements(variant_id, created_at DESC);
CREATE INDEX ON stock_movements(ref_type, ref_id);

CREATE TABLE stock_transfers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  number          bigint NOT NULL,
  from_branch_id  uuid NOT NULL REFERENCES branches(id),
  to_branch_id    uuid NOT NULL REFERENCES branches(id),
  status          text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','enviada','recebida','cancelada')),
  notes           text,
  created_by      uuid,
  sent_by         uuid,
  received_by     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  received_at     timestamptz,
  UNIQUE (company_id, number),
  CHECK (from_branch_id <> to_branch_id)
);
CREATE TABLE stock_transfer_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id   uuid NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  variant_id    uuid NOT NULL REFERENCES product_variants(id),
  qty           int NOT NULL CHECK (qty > 0),
  qty_received  int,
  UNIQUE (transfer_id, variant_id)
);

CREATE TABLE inventories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  branch_id   uuid NOT NULL REFERENCES branches(id),
  number      bigint NOT NULL,
  description text,
  status      text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','fechado','cancelado')),
  scope       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid,
  closed_by   uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  UNIQUE (company_id, number)
);
CREATE TABLE inventory_items (
  inventory_id  uuid NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  variant_id    uuid NOT NULL REFERENCES product_variants(id),
  counted_qty   int NOT NULL DEFAULT 0,
  expected_qty  int,
  counted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (inventory_id, variant_id)
);

CREATE TABLE purchase_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  branch_id      uuid NOT NULL REFERENCES branches(id),
  number         bigint NOT NULL,
  supplier_id    uuid NOT NULL REFERENCES suppliers(id),
  status         text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','aprovado','enviado','parcial','recebido','cancelado')),
  expected_date  date,
  total          numeric(14,2) NOT NULL DEFAULT 0,
  notes          text,
  created_by     uuid,
  approved_by    uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);
CREATE TABLE purchase_order_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  variant_id    uuid NOT NULL REFERENCES product_variants(id),
  qty           int NOT NULL CHECK (qty > 0),
  unit_cost     numeric(14,2) NOT NULL,
  qty_received  int NOT NULL DEFAULT 0
);

-- Entradas de mercadoria (manual ou via XML de NF-e)
CREATE TABLE purchase_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  number           bigint NOT NULL,
  supplier_id      uuid REFERENCES suppliers(id),
  supplier_data    jsonb,
  purchase_order_id uuid REFERENCES purchase_orders(id),
  source           text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','xml')),
  nfe_key          text,
  nfe_number       text,
  nfe_series       text,
  issue_date       date,
  total_products   numeric(14,2) NOT NULL DEFAULT 0,
  total_freight    numeric(14,2) NOT NULL DEFAULT 0,
  total_discount   numeric(14,2) NOT NULL DEFAULT 0,
  total_other      numeric(14,2) NOT NULL DEFAULT 0,
  total            numeric(14,2) NOT NULL DEFAULT 0,
  installments     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status           text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','confirmada','cancelada')),
  xml              text,
  warnings         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by       uuid,
  confirmed_by     uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  confirmed_at     timestamptz,
  UNIQUE (company_id, number)
);
CREATE UNIQUE INDEX purchase_entries_key_uq ON purchase_entries(company_id, nfe_key) WHERE nfe_key IS NOT NULL AND status <> 'cancelada';

CREATE TABLE purchase_entry_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id       uuid NOT NULL REFERENCES purchase_entries(id) ON DELETE CASCADE,
  line           int NOT NULL,
  variant_id     uuid REFERENCES product_variants(id),
  supplier_code  text,
  ean            text,
  description    text NOT NULL,
  ncm            text,
  cfop           text,
  unit           text,
  qty            int NOT NULL CHECK (qty > 0),
  unit_cost      numeric(14,4) NOT NULL,
  total          numeric(14,2) NOT NULL,
  suggested_size text,
  suggested_color text,
  match_status   text NOT NULL DEFAULT 'pendente' CHECK (match_status IN ('pendente','vinculado','novo','ignorado'))
);
CREATE INDEX ON purchase_entry_items(entry_id);

-- Vínculo de código do fornecedor → variação (aprendizado para próximas importações)
CREATE TABLE supplier_product_codes (
  company_id     uuid NOT NULL REFERENCES companies(id),
  supplier_id    uuid NOT NULL REFERENCES suppliers(id),
  supplier_code  text NOT NULL,
  variant_id     uuid NOT NULL REFERENCES product_variants(id),
  PRIMARY KEY (supplier_id, supplier_code)
);
