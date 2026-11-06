-- =====================================================================
-- 020 — Backup (sistema e por empresa, manual e agendado) e Central de Migração de dados de outros ERPs.
-- Apenas CRIA tabelas novas. Acesso exclusivo da equipe da plataforma.
-- =====================================================================

-- Tarefas em segundo plano (backup, restauração e importação), com progresso para a tela acompanhar
CREATE TABLE IF NOT EXISTS platform_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL,
  status       text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','executando','ok','erro')),
  company_id   uuid REFERENCES companies(id),
  progress     jsonb NOT NULL DEFAULT '{}'::jsonb,
  result       jsonb,
  error        text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS platform_jobs_recent ON platform_jobs(created_at DESC);

-- Agendamentos de backup
CREATE TABLE IF NOT EXISTS backup_schedules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope              text NOT NULL CHECK (scope IN ('sistema','empresa')),
  company_id         uuid REFERENCES companies(id),
  frequency          text NOT NULL CHECK (frequency IN ('diario','semanal','mensal')),
  hour               int NOT NULL DEFAULT 2 CHECK (hour BETWEEN 0 AND 23),
  weekday            int CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  monthday           int CHECK (monthday IS NULL OR monthday BETWEEN 1 AND 28),
  keep               int NOT NULL DEFAULT 7 CHECK (keep BETWEEN 1 AND 365),
  include_documents  boolean NOT NULL DEFAULT true,
  active             boolean NOT NULL DEFAULT true,
  next_run_at        timestamptz NOT NULL,
  last_run_at        timestamptz,
  last_status        text,
  last_error         text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'empresa') = (company_id IS NOT NULL))
);

-- Arquivos de backup (cifrados). Conteúdo no armazenamento externo (R2/S3) ou, sem ele, no próprio banco.
CREATE TABLE IF NOT EXISTS backup_files (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope              text NOT NULL CHECK (scope IN ('sistema','empresa')),
  company_id         uuid REFERENCES companies(id),
  company_name       text,
  kind               text NOT NULL CHECK (kind IN ('manual','agendado','seguranca','enviado')),
  schedule_id        uuid REFERENCES backup_schedules(id) ON DELETE SET NULL,
  status             text NOT NULL DEFAULT 'gerando' CHECK (status IN ('gerando','ok','erro','excluido')),
  storage            text NOT NULL CHECK (storage IN ('r2','banco')),
  storage_key        text,
  size               bigint,
  sha256             text,
  tables             int,
  rows               bigint,
  counts             jsonb,
  migrations         text[],
  app_version        text,
  include_documents  boolean NOT NULL DEFAULT true,
  content            bytea,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  error              text
);
CREATE INDEX IF NOT EXISTS backup_files_recent ON backup_files(created_at DESC);
CREATE INDEX IF NOT EXISTS backup_files_company ON backup_files(company_id, created_at DESC);

-- Central de Migração: lotes de importação (com prévia e "desfazer") e o que cada lote criou
CREATE TABLE IF NOT EXISTS migration_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  branch_id    uuid REFERENCES branches(id),
  kind         text NOT NULL CHECK (kind IN ('clientes','fornecedores','produtos','estoque','receber','pagar','xml')),
  source_name  text,
  status       text NOT NULL DEFAULT 'previa' CHECK (status IN ('previa','importando','importado','desfeito','erro')),
  mapping      jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary      jsonb NOT NULL DEFAULT '{}'::jsonb,
  rows_data    jsonb,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  imported_at  timestamptz,
  undone_at    timestamptz,
  undone_by    uuid REFERENCES users(id),
  error        text
);
CREATE INDEX IF NOT EXISTS migration_batches_company ON migration_batches(company_id, created_at DESC);
CREATE TABLE IF NOT EXISTS migration_items (
  batch_id   uuid NOT NULL REFERENCES migration_batches(id) ON DELETE CASCADE,
  entity     text NOT NULL,
  entity_id  uuid NOT NULL,
  seq        int NOT NULL DEFAULT 0,
  PRIMARY KEY (batch_id, entity, entity_id)
);
-- Mapeamentos de colunas salvos (ex.: "Planilha de produtos do Bling")
CREATE TABLE IF NOT EXISTS migration_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL,
  mapping     jsonb NOT NULL,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, kind)
);
