-- AXIONYX · 003 · Financeiro, PDV/vendas, trocas, comissões, condicional, consignação, crediário, fidelidade

CREATE TABLE financial_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  branch_id       uuid REFERENCES branches(id),
  name            text NOT NULL,
  type            text NOT NULL CHECK (type IN ('caixa','banco','carteira_digital','adquirente')),
  bank            jsonb NOT NULL DEFAULT '{}'::jsonb,
  opening_balance numeric(14,2) NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE financial_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  code        text NOT NULL,
  name        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('receita','despesa')),
  dre_group   text NOT NULL CHECK (dre_group IN ('receita_bruta','deducoes','cmv','despesas_operacionais','despesas_pessoal','despesas_administrativas','despesas_comerciais','receitas_financeiras','despesas_financeiras','outras')),
  system_key  text,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, code)
);
CREATE UNIQUE INDEX fincat_syskey_uq ON financial_categories(company_id, system_key) WHERE system_key IS NOT NULL;

CREATE TABLE payment_methods (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id),
  name              text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('dinheiro','pix','debito','credito','crediario','vale_troca','cashback','boleto','outro')),
  fee_pct           numeric(6,3) NOT NULL DEFAULT 0,
  settlement_days   int NOT NULL DEFAULT 0,
  max_installments  int NOT NULL DEFAULT 1,
  account_id        uuid REFERENCES financial_accounts(id),
  active            boolean NOT NULL DEFAULT true,
  sort              int NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

CREATE TABLE cash_registers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  name text NOT NULL,
  account_id uuid REFERENCES financial_accounts(id),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, name)
);

CREATE TABLE cash_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id),
  branch_id          uuid NOT NULL REFERENCES branches(id),
  register_id        uuid NOT NULL REFERENCES cash_registers(id),
  status             text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','fechado')),
  opened_by          uuid NOT NULL,
  opened_at          timestamptz NOT NULL DEFAULT now(),
  opening_amount     numeric(14,2) NOT NULL DEFAULT 0,
  closed_by          uuid,
  closed_at          timestamptz,
  declared_amount    numeric(14,2),
  expected_amount    numeric(14,2),
  difference         numeric(14,2),
  notes              text
);
CREATE UNIQUE INDEX cash_session_open_uq ON cash_sessions(register_id) WHERE status = 'aberto';

CREATE TABLE cash_movements (
  id          bigserial PRIMARY KEY,
  company_id  uuid NOT NULL,
  session_id  uuid NOT NULL REFERENCES cash_sessions(id),
  type        text NOT NULL CHECK (type IN ('abertura','venda','troco','sangria','suprimento','estorno','recebimento','devolucao')),
  amount      numeric(14,2) NOT NULL,
  ref_type    text,
  ref_id      uuid,
  notes       text,
  user_id     uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cash_movements(session_id);

CREATE TABLE sales (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id),
  branch_id              uuid NOT NULL REFERENCES branches(id),
  number                 bigint NOT NULL,
  type                   text NOT NULL DEFAULT 'venda' CHECK (type IN ('venda','orcamento')),
  status                 text NOT NULL CHECK (status IN ('orcamento','concluida','cancelada','devolvida_parcial','devolvida','orcamento_convertido','orcamento_expirado')),
  channel                text NOT NULL DEFAULT 'loja' CHECK (channel IN ('loja','ecommerce','condicional','bag_delivery','consignacao','whatsapp')),
  customer_id            uuid REFERENCES customers(id),
  seller_id              uuid REFERENCES users(id),
  cash_session_id        uuid REFERENCES cash_sessions(id),
  subtotal               numeric(14,2) NOT NULL DEFAULT 0,
  discount_total         numeric(14,2) NOT NULL DEFAULT 0,
  surcharge              numeric(14,2) NOT NULL DEFAULT 0,
  total                  numeric(14,2) NOT NULL DEFAULT 0,
  cost_total             numeric(14,2) NOT NULL DEFAULT 0,
  items_count            int NOT NULL DEFAULT 0,
  notes                  text,
  valid_until            date,
  origin_type            text,
  origin_id              uuid,
  external_id            text,
  discount_authorized_by uuid,
  created_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  cancelled_at           timestamptz,
  cancelled_by           uuid,
  cancel_reason          text,
  UNIQUE (company_id, number)
);
CREATE INDEX ON sales(company_id, branch_id, created_at DESC);
CREATE INDEX ON sales(customer_id);
CREATE INDEX ON sales(seller_id, created_at);

CREATE TABLE sale_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id       uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL,
  line          int NOT NULL,
  variant_id    uuid NOT NULL REFERENCES product_variants(id),
  qty           int NOT NULL CHECK (qty > 0),
  unit_price    numeric(14,2) NOT NULL,
  discount      numeric(14,2) NOT NULL DEFAULT 0,
  total         numeric(14,2) NOT NULL,
  unit_cost     numeric(14,2) NOT NULL DEFAULT 0,
  returned_qty  int NOT NULL DEFAULT 0
);
CREATE INDEX ON sale_items(sale_id);
CREATE INDEX ON sale_items(variant_id);

CREATE TABLE sale_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id       uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL,
  method_id     uuid REFERENCES payment_methods(id),
  kind          text NOT NULL,
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  installments  int NOT NULL DEFAULT 1,
  change_amount numeric(14,2) NOT NULL DEFAULT 0,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ON sale_payments(sale_id);

-- Crédito de loja / vale-troca
CREATE TABLE store_credits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  customer_id  uuid REFERENCES customers(id),
  code         text NOT NULL,
  origin_type  text NOT NULL,
  origin_id    uuid,
  amount       numeric(14,2) NOT NULL,
  balance      numeric(14,2) NOT NULL,
  status       text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','utilizado','expirado','cancelado')),
  expires_at   date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE TABLE store_credit_movements (
  id          bigserial PRIMARY KEY,
  credit_id   uuid NOT NULL REFERENCES store_credits(id),
  amount      numeric(14,2) NOT NULL,
  ref_type    text,
  ref_id      uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (credit_id, ref_type, ref_id)
);

CREATE TABLE returns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  number        bigint NOT NULL,
  sale_id       uuid NOT NULL REFERENCES sales(id),
  customer_id   uuid REFERENCES customers(id),
  type          text NOT NULL CHECK (type IN ('devolucao','troca')),
  refund_mode   text NOT NULL CHECK (refund_mode IN ('vale_troca','dinheiro','pix','estorno_cartao','abatimento_crediario')),
  total         numeric(14,2) NOT NULL,
  reason        text,
  store_credit_id uuid REFERENCES store_credits(id),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);
CREATE TABLE return_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id     uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  sale_item_id  uuid NOT NULL REFERENCES sale_items(id),
  variant_id    uuid NOT NULL REFERENCES product_variants(id),
  qty           int NOT NULL CHECK (qty > 0),
  unit_price    numeric(14,2) NOT NULL,
  total         numeric(14,2) NOT NULL,
  restock       boolean NOT NULL DEFAULT true
);

-- Comissões e metas
CREATE TABLE commission_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL,
  scope       text NOT NULL CHECK (scope IN ('padrao','vendedor','categoria','marca','colecao')),
  ref_id      uuid,
  pct         numeric(5,2) NOT NULL CHECK (pct >= 0 AND pct <= 100),
  priority    int NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commissions (
  id           bigserial PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id),
  branch_id    uuid NOT NULL REFERENCES branches(id),
  seller_id    uuid NOT NULL REFERENCES users(id),
  sale_id      uuid NOT NULL REFERENCES sales(id),
  ref_type     text NOT NULL DEFAULT 'venda' CHECK (ref_type IN ('venda','cancelamento','devolucao')),
  ref_id       uuid NOT NULL,
  base_amount  numeric(14,2) NOT NULL,
  amount       numeric(14,2) NOT NULL,
  competence   date NOT NULL,
  status       text NOT NULL DEFAULT 'prevista' CHECK (status IN ('prevista','liberada','paga')),
  details      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ref_type, ref_id, seller_id)
);
CREATE INDEX ON commissions(company_id, competence);

CREATE TABLE sales_goals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  branch_id      uuid REFERENCES branches(id),
  seller_id      uuid REFERENCES users(id),
  month          date NOT NULL,
  target_amount  numeric(14,2) NOT NULL,
  bonus_pct      numeric(5,2) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sales_goals_uq ON sales_goals(company_id, coalesce(branch_id,'00000000-0000-0000-0000-000000000000'::uuid), coalesce(seller_id,'00000000-0000-0000-0000-000000000000'::uuid), month);

-- Condicional / Bag Delivery
CREATE TABLE conditionals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  number          bigint NOT NULL,
  kind            text NOT NULL DEFAULT 'condicional' CHECK (kind IN ('condicional','bag_delivery')),
  customer_id     uuid NOT NULL REFERENCES customers(id),
  responsible_id  uuid NOT NULL REFERENCES users(id),
  seller_id       uuid REFERENCES users(id),
  status          text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','finalizado','cancelado')),
  due_date        date NOT NULL,
  delivery        jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes           text,
  sale_id         uuid REFERENCES sales(id),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  UNIQUE (company_id, number)
);
CREATE TABLE conditional_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conditional_id  uuid NOT NULL REFERENCES conditionals(id) ON DELETE CASCADE,
  variant_id      uuid NOT NULL REFERENCES product_variants(id),
  qty_sent        int NOT NULL CHECK (qty_sent > 0),
  qty_returned    int NOT NULL DEFAULT 0,
  qty_sold        int NOT NULL DEFAULT 0,
  unit_price      numeric(14,2) NOT NULL,
  UNIQUE (conditional_id, variant_id),
  CHECK (qty_returned + qty_sold <= qty_sent)
);
CREATE TABLE conditional_events (
  id              bigserial PRIMARY KEY,
  conditional_id  uuid NOT NULL REFERENCES conditionals(id),
  type            text NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  user_id         uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Consignação (revendedoras/parceiros)
CREATE TABLE consignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  number          bigint NOT NULL,
  partner_id      uuid NOT NULL REFERENCES customers(id),
  status          text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','encerrado','cancelado')),
  due_date        date,
  commission_pct  numeric(5,2) NOT NULL DEFAULT 0,
  notes           text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  UNIQUE (company_id, number)
);
CREATE TABLE consignment_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consignment_id  uuid NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  variant_id      uuid NOT NULL REFERENCES product_variants(id),
  qty_sent        int NOT NULL DEFAULT 0,
  qty_sold        int NOT NULL DEFAULT 0,
  qty_returned    int NOT NULL DEFAULT 0,
  unit_price      numeric(14,2) NOT NULL,
  UNIQUE (consignment_id, variant_id),
  CHECK (qty_sold + qty_returned <= qty_sent)
);
CREATE TABLE consignment_settlements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consignment_id     uuid NOT NULL REFERENCES consignments(id),
  number             int NOT NULL,
  gross_amount       numeric(14,2) NOT NULL,
  commission_amount  numeric(14,2) NOT NULL,
  net_amount         numeric(14,2) NOT NULL,
  items              jsonb NOT NULL,
  returned           jsonb NOT NULL DEFAULT '[]'::jsonb,
  sale_id            uuid REFERENCES sales(id),
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (consignment_id, number)
);
CREATE TABLE consignment_events (
  id              bigserial PRIMARY KEY,
  consignment_id  uuid NOT NULL REFERENCES consignments(id),
  type            text NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  user_id         uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Contas a receber / pagar
CREATE TABLE renegotiations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  number           bigint NOT NULL,
  original_ids     uuid[] NOT NULL,
  original_balance numeric(14,2) NOT NULL,
  interest         numeric(14,2) NOT NULL DEFAULT 0,
  discount         numeric(14,2) NOT NULL DEFAULT 0,
  new_total        numeric(14,2) NOT NULL,
  installments     int NOT NULL,
  first_due_date   date NOT NULL,
  notes            text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);

CREATE TABLE receivables (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id),
  branch_id           uuid REFERENCES branches(id),
  customer_id         uuid REFERENCES customers(id),
  sale_id             uuid REFERENCES sales(id),
  source_type         text NOT NULL,
  source_id           uuid,
  document            text NOT NULL,
  installment_no      int NOT NULL DEFAULT 1,
  installments_total  int NOT NULL DEFAULT 1,
  method_kind         text NOT NULL DEFAULT 'outro',
  payment_method_id   uuid REFERENCES payment_methods(id),
  category_id         uuid REFERENCES financial_categories(id),
  account_id          uuid REFERENCES financial_accounts(id),
  issue_date          date NOT NULL DEFAULT current_date,
  due_date            date NOT NULL,
  amount              numeric(14,2) NOT NULL CHECK (amount >= 0),
  fee_amount          numeric(14,2) NOT NULL DEFAULT 0,
  interest            numeric(14,2) NOT NULL DEFAULT 0,
  fine                numeric(14,2) NOT NULL DEFAULT 0,
  discount            numeric(14,2) NOT NULL DEFAULT 0,
  paid_amount         numeric(14,2) NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','parcial','pago','cancelado','renegociado')),
  renegotiation_id    uuid REFERENCES renegotiations(id),
  description         text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz
);
CREATE UNIQUE INDEX receivables_source_uq ON receivables(company_id, source_type, source_id, installment_no, method_kind) WHERE source_id IS NOT NULL;
CREATE INDEX ON receivables(company_id, status, due_date);
CREATE INDEX ON receivables(customer_id);

CREATE TABLE payables (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id),
  branch_id           uuid REFERENCES branches(id),
  supplier_id         uuid REFERENCES suppliers(id),
  source_type         text NOT NULL DEFAULT 'manual',
  source_id           uuid,
  document            text NOT NULL,
  installment_no      int NOT NULL DEFAULT 1,
  installments_total  int NOT NULL DEFAULT 1,
  category_id         uuid REFERENCES financial_categories(id),
  account_id          uuid REFERENCES financial_accounts(id),
  issue_date          date NOT NULL DEFAULT current_date,
  due_date            date NOT NULL,
  amount              numeric(14,2) NOT NULL CHECK (amount >= 0),
  interest            numeric(14,2) NOT NULL DEFAULT 0,
  fine                numeric(14,2) NOT NULL DEFAULT 0,
  discount            numeric(14,2) NOT NULL DEFAULT 0,
  paid_amount         numeric(14,2) NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','parcial','pago','cancelado')),
  description         text,
  approved_by         uuid,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz
);
CREATE UNIQUE INDEX payables_source_uq ON payables(company_id, source_type, source_id, installment_no) WHERE source_id IS NOT NULL;
CREATE INDEX ON payables(company_id, status, due_date);

CREATE TABLE financial_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  branch_id       uuid REFERENCES branches(id),
  account_id      uuid NOT NULL REFERENCES financial_accounts(id),
  direction       text NOT NULL CHECK (direction IN ('entrada','saida')),
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  date            date NOT NULL DEFAULT current_date,
  description     text NOT NULL,
  category_id     uuid REFERENCES financial_categories(id),
  receivable_id   uuid REFERENCES receivables(id),
  payable_id      uuid REFERENCES payables(id),
  sale_id         uuid REFERENCES sales(id),
  source_type     text NOT NULL,
  source_id       uuid,
  source_seq      int NOT NULL DEFAULT 1,
  reconciled      boolean NOT NULL DEFAULT false,
  statement_line_id bigint,
  reversal_of     uuid REFERENCES financial_transactions(id),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fintx_source_uq ON financial_transactions(company_id, source_type, source_id, source_seq) WHERE source_id IS NOT NULL;
CREATE INDEX ON financial_transactions(company_id, date);
CREATE INDEX ON financial_transactions(account_id, date);

CREATE TABLE title_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  title_type      text NOT NULL CHECK (title_type IN ('receber','pagar')),
  title_id        uuid NOT NULL,
  date            date NOT NULL DEFAULT current_date,
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  interest        numeric(14,2) NOT NULL DEFAULT 0,
  fine            numeric(14,2) NOT NULL DEFAULT 0,
  discount        numeric(14,2) NOT NULL DEFAULT 0,
  account_id      uuid REFERENCES financial_accounts(id),
  method          text,
  transaction_id  uuid REFERENCES financial_transactions(id),
  idempotency_key text,
  reversed_at     timestamptz,
  notes           text,
  user_id         uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX title_payments_idem_uq ON title_payments(company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX ON title_payments(title_type, title_id);

CREATE TABLE bank_statement_lines (
  id                      bigserial PRIMARY KEY,
  company_id              uuid NOT NULL REFERENCES companies(id),
  account_id              uuid NOT NULL REFERENCES financial_accounts(id),
  date                    date NOT NULL,
  description             text NOT NULL,
  amount                  numeric(14,2) NOT NULL,
  fit_id                  text NOT NULL,
  matched_transaction_id  uuid REFERENCES financial_transactions(id),
  imported_by             uuid,
  imported_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, fit_id)
);

-- Fidelidade / cashback (razão com proteção contra duplicidade por origem)
CREATE TABLE loyalty_ledger (
  id           bigserial PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id),
  customer_id  uuid NOT NULL REFERENCES customers(id),
  kind         text NOT NULL CHECK (kind IN ('credito','resgate','expiracao','estorno_credito','estorno_resgate','ajuste')),
  amount       numeric(14,2) NOT NULL,
  remaining    numeric(14,2),
  expires_at   date,
  source_type  text NOT NULL,
  source_id    uuid,
  notes        text,
  user_id      uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX loyalty_source_uq ON loyalty_ledger(company_id, source_type, source_id, kind) WHERE source_id IS NOT NULL;
CREATE INDEX ON loyalty_ledger(customer_id, created_at);
