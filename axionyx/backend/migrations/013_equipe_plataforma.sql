-- =====================================================================
-- 013 — Equipe da plataforma: superadministradores com permissões.
-- Apenas ACRESCENTA colunas. Quem já é superadministrador vira "proprietário"
-- (acesso total, exatamente como antes). Nenhum cadastro é alterado ou apagado.
-- =====================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_owner        boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_permissions  text[]  NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_title        text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password  boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by            uuid REFERENCES users(id);

UPDATE users SET platform_owner = true WHERE is_superadmin AND NOT platform_owner;

CREATE INDEX IF NOT EXISTS users_superadmin_idx ON users(is_superadmin) WHERE is_superadmin;
