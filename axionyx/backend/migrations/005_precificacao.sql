-- =====================================================================
-- 005 — Precificação: custos fixos, custos/despesas variáveis, parâmetros,
-- histórico de simulações/aplicações de preço e metas de precificação.
-- Aplicada automaticamente ao iniciar a API (ou com `npm run migrate`).
-- Percentuais são gravados em pontos percentuais (ex.: 2.99 = 2,99%).
-- =====================================================================

-- Parâmetros de precificação por empresa
CREATE TABLE pricing_settings (
  company_id            uuid PRIMARY KEY REFERENCES companies(id),
  desired_margin_pct    numeric(7,3) NOT NULL DEFAULT 15,    -- lucro líquido desejado sobre o preço
  include_fixed_costs   boolean NOT NULL DEFAULT true,       -- ratear custos fixos no preço (markup divisor)
  revenue_base_mode     text NOT NULL DEFAULT 'media_3m' CHECK (revenue_base_mode IN ('media_3m', 'manual')),
  revenue_base_manual   numeric(14,2),                       -- faturamento mensal de referência quando 'manual'
  min_margin_pct        numeric(7,3) NOT NULL DEFAULT 0,     -- alerta: margem líquida mínima aceitável
  rounding              text NOT NULL DEFAULT 'centavos_90' CHECK (rounding IN ('nenhum', 'centavos_90', 'centavos_99', 'inteiro')),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES users(id)
);

-- Custos fixos mensais (aluguel, folha, sistemas, contador...)
CREATE TABLE fixed_costs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  branch_id       uuid REFERENCES branches(id),                -- NULL = empresa toda
  category        text NOT NULL CHECK (category IN ('ocupacao', 'pessoal', 'administrativo', 'comercial', 'financeiro', 'depreciacao', 'pro_labore', 'outros')),
  description     text NOT NULL,
  monthly_amount  numeric(14,2) NOT NULL CHECK (monthly_amount >= 0),
  active          boolean NOT NULL DEFAULT true,
  notes           text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fixed_costs_company_idx ON fixed_costs(company_id) WHERE active;

-- Custos e despesas variáveis: percentuais sobre o preço (impostos, cartão, comissão,
-- marketplace, royalties...) ou valores por unidade vendida (embalagem, etiqueta, frete médio...)
CREATE TABLE variable_costs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  category        text NOT NULL CHECK (category IN ('impostos', 'cartao', 'comissao', 'marketplace', 'frete', 'embalagem', 'perdas', 'royalties', 'outros')),
  description     text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('percentual', 'valor_unitario')),
  value           numeric(14,4) NOT NULL CHECK (value >= 0),
  channel         text NOT NULL DEFAULT 'todos' CHECK (channel IN ('todos', 'loja', 'ecommerce', 'marketplace')),
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT variable_costs_pct_limit CHECK (kind <> 'percentual' OR value < 100)
);
CREATE INDEX variable_costs_company_idx ON variable_costs(company_id) WHERE active;

-- Histórico: toda simulação e toda aplicação de preço (rastreabilidade completa)
CREATE TABLE pricing_history (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  branch_id            uuid REFERENCES branches(id),
  product_id           uuid REFERENCES products(id),
  variant_id           uuid REFERENCES product_variants(id),
  kind                 text NOT NULL CHECK (kind IN ('simulacao', 'aplicacao')),
  scenario_name        text,
  unit_cost            numeric(14,4) NOT NULL,
  previous_price       numeric(14,2),
  suggested_price      numeric(14,2) NOT NULL,
  applied_price        numeric(14,2),
  desired_margin_pct   numeric(7,3),
  contribution_pct     numeric(9,4),
  net_margin_pct       numeric(9,4),
  markup               numeric(10,4),
  input                jsonb NOT NULL DEFAULT '{}',
  result               jsonb NOT NULL DEFAULT '{}',
  user_id              uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_history_applied CHECK (kind <> 'aplicacao' OR applied_price IS NOT NULL)
);
CREATE INDEX pricing_history_company_idx ON pricing_history(company_id, created_at DESC);
CREATE INDEX pricing_history_product_idx ON pricing_history(product_id, created_at DESC);

-- Metas de precificação (venda mínima/alvo derivada de uma simulação) — versionadas, nunca sobrescritas
CREATE TABLE pricing_goals (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id),
  product_id             uuid REFERENCES products(id),
  history_id             uuid REFERENCES pricing_history(id),
  name                   text NOT NULL,
  start_date             date NOT NULL,
  end_date               date NOT NULL,
  target_units           numeric(14,2) NOT NULL DEFAULT 0,
  target_revenue         numeric(14,2) NOT NULL DEFAULT 0,
  breakeven_units        numeric(14,2),
  unit_price             numeric(14,2),
  unit_contribution      numeric(14,4),
  status                 text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'substituida', 'encerrada')),
  previous_goal_id       uuid REFERENCES pricing_goals(id),
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_goals_period CHECK (end_date >= start_date)
);
CREATE UNIQUE INDEX pricing_goals_one_active ON pricing_goals(company_id, product_id) WHERE status = 'ativa';

-- Parâmetros iniciais para as empresas existentes
INSERT INTO pricing_settings(company_id) SELECT id FROM companies ON CONFLICT DO NOTHING;

-- Despesas variáveis iniciais a partir do que já está configurado (taxas das formas de pagamento
-- e alíquota estimada da DRE) — o lojista revisa e ajusta na tela de Precificação.
INSERT INTO variable_costs(company_id, category, description, kind, value)
SELECT c.id, 'impostos', 'Impostos sobre vendas (alíquota estimada — revise com o contador)', 'percentual',
       COALESCE(NULLIF(c.settings->'fiscal'->>'aliquotaEstimadaPct','')::numeric, 6)
  FROM companies c;
INSERT INTO variable_costs(company_id, category, description, kind, value)
SELECT pm.company_id, 'cartao', 'Taxa média de cartão (maior taxa cadastrada nas formas de pagamento)', 'percentual', max(pm.fee_pct)
  FROM payment_methods pm WHERE pm.kind IN ('credito','debito') AND pm.active GROUP BY pm.company_id HAVING max(pm.fee_pct) > 0;
INSERT INTO variable_costs(company_id, category, description, kind, value)
SELECT c.id, 'comissao', 'Comissão de vendas (percentual padrão)', 'percentual',
       COALESCE(NULLIF(c.settings->'comissoes'->>'percentualPadrao','')::numeric, 3)
  FROM companies c;

-- Somente empresas de DEMONSTRAÇÃO (dados fictícios): custos fixos de exemplo em escala compatível com o faturamento fictício do seed
INSERT INTO fixed_costs(company_id, category, description, monthly_amount, notes)
SELECT c.id, v.category, v.description, v.amount, 'Exemplo (empresa de demonstração)'
  FROM companies c CROSS JOIN (VALUES
    ('ocupacao', 'Aluguel Loja Centro', 2200.00), ('ocupacao', 'Aluguel Shopping Norte', 2900.00),
    ('pessoal', 'Folha de pagamento e encargos', 4800.00), ('administrativo', 'Energia, água e internet', 420.00),
    ('comercial', 'Marketing e redes sociais', 350.00), ('administrativo', 'Sistemas e contabilidade', 290.00)
  ) AS v(category, description, amount)
 WHERE c.is_demo AND NOT EXISTS (SELECT 1 FROM fixed_costs f WHERE f.company_id = c.id);
INSERT INTO variable_costs(company_id, category, description, kind, value)
SELECT c.id, 'embalagem', 'Sacola, etiqueta e tag por peça (exemplo)', 'valor_unitario', 1.80 FROM companies c WHERE c.is_demo;

-- Permissões do novo módulo para os perfis padrão já existentes
UPDATE roles SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['precificacao.ver','precificacao.editar','precificacao.aplicar']) p)
 WHERE name IN ('Administrador', 'Gerente de Loja');
UPDATE roles SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['precificacao.ver','precificacao.editar']) p)
 WHERE name = 'Financeiro';

-- Módulo habilitado para as empresas existentes
UPDATE companies SET modules = array_append(modules, 'precificacao') WHERE NOT ('precificacao' = ANY(modules));
