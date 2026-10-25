-- =====================================================================
-- 009 — Contatos recebidos pelo formulário do site institucional.
-- =====================================================================
CREATE TABLE IF NOT EXISTS site_leads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text,
  phone         text,
  company_name  text,
  segment       text,
  stores        text,
  message       text,
  consent       boolean NOT NULL DEFAULT false,
  ip            text,
  user_agent    text,
  status        text NOT NULL DEFAULT 'novo' CHECK (status IN ('novo','em_contato','convertido','descartado')),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_leads_created_idx ON site_leads(created_at DESC);
