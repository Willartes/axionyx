-- =====================================================================
-- 006 — WhatsApp por empresa: cada empresa configura o próprio número
-- (WhatsApp Business Platform / Cloud API oficial) pela tela de Integrações,
-- modelos de mensagem (templates) aprovados por finalidade, webhook de
-- confirmações (entregue/lido/falhou) e mensagens recebidas (janela de 24 h).
-- Aplicada automaticamente ao iniciar a API (ou com `npm run migrate`).
-- =====================================================================

-- Credenciais por empresa: token e "app secret" ficam CIFRADOS (AES-256-GCM) — nunca em texto puro.
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS secret_enc text;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS webhook_verify_token text;

-- Janela de atendimento de 24 h: última mensagem recebida do cliente
ALTER TABLE customers ADD COLUMN IF NOT EXISTS whatsapp_last_inbound_at timestamptz;

-- Mensagens: direção (enviada/recebida), novo status "recebido" e parâmetros do modelo usado
ALTER TABLE messages ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'saida';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS template_params jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at timestamptz;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check CHECK (status IN ('pendente_configuracao','bloqueado_sem_consentimento','fila','enviado','entregue','lido','erro','recebido'));
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_direction_check;
ALTER TABLE messages ADD CONSTRAINT messages_direction_check CHECK (direction IN ('saida','entrada'));
CREATE INDEX IF NOT EXISTS messages_provider_idx ON messages(provider_message_id) WHERE provider_message_id IS NOT NULL;

-- Modelos de mensagem aprovados pela Meta (sincronizados ou cadastrados), com a finalidade e o
-- mapeamento das variáveis {{1}}, {{2}}... para os dados do sistema (nome, loja, valor, vencimento...)
CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  name         text NOT NULL,
  language     text NOT NULL DEFAULT 'pt_BR',
  category     text,
  status       text NOT NULL DEFAULT 'APPROVED',
  body         text,
  variables    text[] NOT NULL DEFAULT '{}',
  purpose      text CHECK (purpose IS NULL OR purpose IN ('pos_venda','aniversario','cobranca','condicional','campanha','atendimento')),
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','meta')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name, language)
);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_templates_purpose_uq ON whatsapp_templates(company_id, purpose) WHERE purpose IS NOT NULL;

-- Garante a linha da integração de WhatsApp para todas as empresas
INSERT INTO integrations(company_id, kind, provider, name)
SELECT c.id, 'whatsapp', 'meta_cloud_api', 'WhatsApp Business Platform' FROM companies c
 WHERE NOT EXISTS (SELECT 1 FROM integrations i WHERE i.company_id = c.id AND i.kind = 'whatsapp');
