-- =====================================================================
-- 010 — Segmentos Mercadinho/Conveniência e Cosméticos/Perfumaria.
-- Preço por quantidade (atacarejo) e novo motivo de perda "amostra/tester".
-- Somente adições: nenhum dado existente é alterado.
-- =====================================================================

-- Preço unitário por faixa de quantidade (ex.: a partir de 6 un. = R$ 4,50 cada)
CREATE TABLE IF NOT EXISTS product_price_tiers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  min_qty     numeric(14,3) NOT NULL CHECK (min_qty > 1),
  unit_price  numeric(14,2) NOT NULL CHECK (unit_price > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, min_qty)
);
CREATE INDEX IF NOT EXISTS product_price_tiers_product_idx ON product_price_tiers(product_id);

-- Testers e amostras grátis (cosméticos/perfumes) como motivo de baixa
ALTER TABLE stock_losses DROP CONSTRAINT IF EXISTS stock_losses_reason_check;
ALTER TABLE stock_losses ADD CONSTRAINT stock_losses_reason_check CHECK (reason IN ('vencido','avariado','quebra','furto','consumo_interno','degustacao','amostra','outros'));

-- Preço aplicado por faixa fica registrado no item da venda
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS price_tier_min_qty numeric(14,3);
