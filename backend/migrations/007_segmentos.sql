-- =====================================================================
-- 007 — Segmentos de negócio (Moda, Hortifrúti, Adega, ...).
-- Cada empresa passa a ter um segmento; o pacote do segmento define os
-- módulos/menu, o vocabulário, as categorias e as unidades iniciais.
-- As empresas existentes são convertidas para "moda" mantendo TODOS os
-- módulos que já tinham (nada é desligado nem apagado).
-- Aplicada automaticamente ao iniciar a API (ou com `npm run migrate`).
-- =====================================================================
ALTER TABLE companies ADD COLUMN IF NOT EXISTS segment text NOT NULL DEFAULT 'moda';

-- Moda: os recursos de grade cor × tamanho e coleções viram módulos explícitos (já usados por todas as empresas atuais)
UPDATE companies SET modules = (SELECT array_agg(DISTINCT m) FROM unnest(modules || ARRAY['grade','colecoes']) m)
 WHERE segment = 'moda' AND NOT (modules @> ARRAY['grade','colecoes']);
