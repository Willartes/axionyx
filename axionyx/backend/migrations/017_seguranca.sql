-- =====================================================================
-- 017 — Endurecimento de segurança (auditoria 1.10.2).
-- Convite com aceite para contas que já existem em outra empresa; proteção contra reuso de código MFA.
-- Apenas ACRESCENTA colunas; nenhum vínculo ou usuário existente é alterado.
-- =====================================================================

-- vínculo criado por convite: só passa a valer depois que a própria pessoa aceita
ALTER TABLE user_companies ADD COLUMN IF NOT EXISTS invite_pending boolean NOT NULL DEFAULT false;
ALTER TABLE user_companies ADD COLUMN IF NOT EXISTS invited_by     uuid REFERENCES users(id);
ALTER TABLE user_companies ADD COLUMN IF NOT EXISTS invited_at     timestamptz;

-- último intervalo de 30 s em que um código MFA foi aceito (impede reutilizar o mesmo código)
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_step bigint;
