-- =====================================================================
-- 008 — Recursos de Hortifrúti (venda por peso, balança, validade, perdas)
-- e de Adega (embalagens unidade/caixa, safra/lote, maioridade, combos).
-- Somente ADIÇÕES e ampliações de tipo: as quantidades inteiras passam a
-- aceitar 3 casas decimais (kg) sem alterar nenhum valor já gravado.
-- =====================================================================

-- Quantidades fracionadas (venda por kg). int -> numeric preserva todos os valores existentes.
ALTER TABLE stock_balances        ALTER COLUMN qty TYPE numeric(14,3);
ALTER TABLE stock_movements       ALTER COLUMN qty TYPE numeric(14,3), ALTER COLUMN balance_after TYPE numeric(14,3);
ALTER TABLE stock_transfer_items  ALTER COLUMN qty TYPE numeric(14,3), ALTER COLUMN qty_received TYPE numeric(14,3);
ALTER TABLE inventory_items       ALTER COLUMN counted_qty TYPE numeric(14,3), ALTER COLUMN expected_qty TYPE numeric(14,3);
ALTER TABLE purchase_order_items  ALTER COLUMN qty TYPE numeric(14,3), ALTER COLUMN qty_received TYPE numeric(14,3);
ALTER TABLE purchase_entry_items  ALTER COLUMN qty TYPE numeric(14,3);
ALTER TABLE sale_items            ALTER COLUMN qty TYPE numeric(14,3), ALTER COLUMN returned_qty TYPE numeric(14,3);
ALTER TABLE return_items          ALTER COLUMN qty TYPE numeric(14,3);

-- Produto: peso, código de balança (PLU), validade padrão, maioridade e atributos livres (teor, volume, uva, país...)
ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_by_weight  boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS plu_code        text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shelf_life_days int CHECK (shelf_life_days IS NULL OR shelf_life_days BETWEEN 0 AND 3650);
ALTER TABLE products ADD COLUMN IF NOT EXISTS age_restricted  boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS track_lots      boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS attributes      jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS products_plu_uq ON products(company_id, plu_code) WHERE plu_code IS NOT NULL;

-- Novo tipo de movimento: perda (vencido, avariado, quebra...)
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_type_check CHECK (type IN ('entrada','saida','ajuste','transferencia_saida','transferencia_entrada',
  'venda','cancelamento_venda','devolucao','condicional_saida','condicional_retorno','consignacao_saida','consignacao_retorno','inventario','compra','estorno_compra','perda'));

-- Lotes com validade (e safra, para vinhos). Consumo FEFO nas vendas.
CREATE TABLE IF NOT EXISTS stock_lots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  branch_id      uuid NOT NULL REFERENCES branches(id),
  variant_id     uuid NOT NULL REFERENCES product_variants(id),
  lot_code       text,
  vintage        int CHECK (vintage IS NULL OR vintage BETWEEN 1900 AND 2100),
  expiry_date    date,
  qty_initial    numeric(14,3) NOT NULL CHECK (qty_initial > 0),
  qty_remaining  numeric(14,3) NOT NULL CHECK (qty_remaining >= 0),
  unit_cost      numeric(14,4),
  source         text NOT NULL DEFAULT 'manual',
  notes          text,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_lots_fefo_idx ON stock_lots(branch_id, variant_id, expiry_date NULLS LAST) WHERE qty_remaining > 0;
CREATE INDEX IF NOT EXISTS stock_lots_expiry_idx ON stock_lots(company_id, expiry_date) WHERE qty_remaining > 0;

-- Perdas (com custo, motivo e lote) para relatório e indicadores
CREATE TABLE IF NOT EXISTS stock_losses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  branch_id    uuid NOT NULL REFERENCES branches(id),
  variant_id   uuid NOT NULL REFERENCES product_variants(id),
  lot_id       uuid REFERENCES stock_lots(id),
  qty          numeric(14,3) NOT NULL CHECK (qty > 0),
  unit_cost    numeric(14,4) NOT NULL DEFAULT 0,
  total_cost   numeric(14,2) NOT NULL DEFAULT 0,
  reason       text NOT NULL CHECK (reason IN ('vencido','avariado','quebra','furto','consumo_interno','degustacao','outros')),
  notes        text,
  user_id      uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_losses_company_idx ON stock_losses(company_id, created_at DESC);

-- Embalagens: a mesma garrafa vendida avulsa ou em caixa com código de barras próprio
CREATE TABLE IF NOT EXISTS product_packagings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  product_id  uuid NOT NULL REFERENCES products(id),
  variant_id  uuid NOT NULL REFERENCES product_variants(id),
  name        text NOT NULL,
  units       int NOT NULL CHECK (units >= 2 AND units <= 1000),
  barcode     text,
  sale_price  numeric(14,2) CHECK (sale_price IS NULL OR sale_price > 0),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS product_packagings_barcode_uq ON product_packagings(company_id, barcode) WHERE barcode IS NOT NULL;

-- Combos e kits (preço fechado; cada componente baixa o próprio estoque)
CREATE TABLE IF NOT EXISTS combos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  code        text NOT NULL,
  name        text NOT NULL,
  barcode     text,
  price       numeric(14,2) NOT NULL CHECK (price > 0),
  active      boolean NOT NULL DEFAULT true,
  valid_until date,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE UNIQUE INDEX IF NOT EXISTS combos_barcode_uq ON combos(company_id, barcode) WHERE barcode IS NOT NULL;
CREATE TABLE IF NOT EXISTS combo_items (
  combo_id    uuid NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  variant_id  uuid NOT NULL REFERENCES product_variants(id),
  qty         numeric(14,3) NOT NULL CHECK (qty > 0),
  PRIMARY KEY (combo_id, variant_id)
);

-- Rastreabilidade na venda: combo/embalagem de origem e confirmação de maioridade
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS combo_id     uuid REFERENCES combos(id);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS packaging_id uuid REFERENCES product_packagings(id);
ALTER TABLE sales      ADD COLUMN IF NOT EXISTS age_verified_by uuid REFERENCES users(id);
ALTER TABLE sales      ADD COLUMN IF NOT EXISTS age_verified_at timestamptz;

-- Permissões dos novos recursos para os perfis padrão existentes
UPDATE roles SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['estoque.perdas','estoque.lotes','combos.editar']) p)
 WHERE name IN ('Administrador', 'Gerente de Loja');
UPDATE roles SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['estoque.perdas']) p)
 WHERE name = 'Estoquista';
UPDATE roles SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['estoque.lotes']) p)
 WHERE name = 'Estoquista';
