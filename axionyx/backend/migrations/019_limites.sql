-- =====================================================================
-- 019 — Limites de usuários e filiais por contrato.
-- O limite vem do plano (saas_plans.max_users / max_branches); o contrato pode substituí-lo para uma empresa específica.
-- Apenas ACRESCENTA colunas (vazias = segue o plano). Nada existente é alterado nem bloqueado retroativamente.
-- =====================================================================
ALTER TABLE saas_contracts ADD COLUMN IF NOT EXISTS max_users_override    int CHECK (max_users_override IS NULL OR max_users_override BETWEEN 1 AND 100000);
ALTER TABLE saas_contracts ADD COLUMN IF NOT EXISTS max_branches_override int CHECK (max_branches_override IS NULL OR max_branches_override BETWEEN 1 AND 10000);
