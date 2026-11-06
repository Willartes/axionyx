-- AXIONYX · 001 · Núcleo: empresas, filiais, usuários, perfis, sessões, auditoria, idempotência
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE companies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  trade_name    text,
  cnpj          text UNIQUE,
  ie            text,
  tax_regime    text NOT NULL DEFAULT 'simples' CHECK (tax_regime IN ('simples','presumido','real','mei')),
  crt           int  NOT NULL DEFAULT 1,
  address       jsonb NOT NULL DEFAULT '{}'::jsonb,
  phone         text,
  email         text,
  color         text NOT NULL DEFAULT '#0875D1',
  is_demo       boolean NOT NULL DEFAULT false,
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  modules       text[] NOT NULL DEFAULT ARRAY[]::text[],
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  code        text NOT NULL,
  name        text NOT NULL,
  cnpj        text,
  ie          text,
  address     jsonb NOT NULL DEFAULT '{}'::jsonb,
  phone       text,
  fiscal      jsonb NOT NULL DEFAULT '{}'::jsonb,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE INDEX ON branches(company_id);

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  email            text NOT NULL,
  password_hash    text NOT NULL,
  mfa_secret       text,
  mfa_enabled      boolean NOT NULL DEFAULT false,
  is_superadmin    boolean NOT NULL DEFAULT false,
  active           boolean NOT NULL DEFAULT true,
  failed_attempts  int NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE roles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id),
  name              text NOT NULL,
  description       text,
  permissions       text[] NOT NULL DEFAULT ARRAY[]::text[],
  max_discount_pct  numeric(5,2) NOT NULL DEFAULT 0,
  is_system         boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE user_companies (
  user_id         uuid NOT NULL REFERENCES users(id),
  company_id      uuid NOT NULL REFERENCES companies(id),
  role_id         uuid NOT NULL REFERENCES roles(id),
  all_branches    boolean NOT NULL DEFAULT false,
  is_seller       boolean NOT NULL DEFAULT false,
  commission_pct  numeric(5,2),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);

CREATE TABLE user_branches (
  user_id     uuid NOT NULL REFERENCES users(id),
  company_id  uuid NOT NULL REFERENCES companies(id),
  branch_id   uuid NOT NULL REFERENCES branches(id),
  PRIMARY KEY (user_id, branch_id)
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  stage       text NOT NULL DEFAULT 'full' CHECK (stage IN ('mfa','context','full')),
  company_id  uuid REFERENCES companies(id),
  branch_id   uuid REFERENCES branches(id),
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX ON sessions(user_id);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  company_id  uuid,
  branch_id   uuid,
  user_id     uuid,
  user_name   text,
  action      text NOT NULL,
  entity      text,
  entity_id   text,
  data        jsonb,
  ip          text,
  severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log(company_id, created_at DESC);
CREATE INDEX ON audit_log(entity, entity_id);

CREATE TABLE idempotency_keys (
  company_id     uuid NOT NULL,
  key            text NOT NULL,
  method         text NOT NULL,
  path           text NOT NULL,
  request_hash   text NOT NULL,
  status_code    int,
  response       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);

-- Numeração sequencial legível por empresa (vendas, condicionais, transferências...)
CREATE TABLE counters (
  company_id  uuid NOT NULL,
  name        text NOT NULL,
  value       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, name)
);

CREATE TABLE system_events (
  id          bigserial PRIMARY KEY,
  level       text NOT NULL,
  source      text NOT NULL,
  message     text NOT NULL,
  data        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
