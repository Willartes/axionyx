-- =====================================================================
-- 016 — Convite por e-mail com link de ativação (e redefinição de senha por link).
-- O token nunca é guardado em texto: só o hash SHA-256. Uso único e com validade.
-- Apenas ACRESCENTA tabelas/colunas; nenhum usuário existente é alterado.
-- =====================================================================

-- usuário convidado que ainda não definiu a senha pelo link
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_activation boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS user_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  kind         text NOT NULL CHECK (kind IN ('ativacao','redefinicao')),
  token_hash   text NOT NULL UNIQUE,
  company_id   uuid REFERENCES companies(id),       -- empresa do convite (texto do e-mail)
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  revoked_at   timestamptz,
  used_ip      text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_tokens_user_idx ON user_tokens(user_id, created_at DESC);

-- registro dos e-mails enviados (sem conteúdo e sem o link)
CREATE TABLE IF NOT EXISTS email_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES users(id),
  company_id   uuid REFERENCES companies(id),
  to_email     text NOT NULL,
  kind         text NOT NULL,                        -- ativacao | redefinicao | teste
  provider     text,
  status       text NOT NULL CHECK (status IN ('enviado','erro')),
  provider_id  text,
  error        text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_log_user_idx ON email_log(user_id, created_at DESC);
