# Integrações externas — contratos e configuração

Todas as integrações são **desacopladas** e ficam em `backend/src/integrations/`. Credenciais são lidas
**somente de variáveis de ambiente do servidor** (nunca do banco nem da interface). Sem credenciais:

- nada é enviado a terceiros;
- os eventos ficam na fila (`outbox`) com status `aguardando_configuracao` e são reprocessados quando a integração for ativada;
- a interface mostra "Pendente de configuração" — nenhum resultado é simulado.

A tela **Plataforma › Integrações** mostra o status de cada integração, a fila de eventos, erros e o botão de reprocessar.

---

## 1. Fiscal — NF-e (modelo 55) e NFC-e (modelo 65)

O AXIONYX **não** assina XML nem fala diretamente com a SEFAZ. Isso exige certificado digital (A1/A3), CSC da NFC-e,
credenciamento na SEFAZ da UF e manutenção constante dos leiautes — por isso é delegado a um **provedor fiscal homologado**
contratado pela empresa.

| Variável | Descrição |
|---|---|
| `FISCAL_PROVIDER` | `http` para o adaptador REST genérico abaixo |
| `FISCAL_PROVIDER_URL` | URL base da API do provedor (ou de um proxy que siga o contrato) |
| `FISCAL_PROVIDER_TOKEN` | Token de acesso (Bearer) |

O ambiente (`homologacao`/`producao`), séries e emissão automática da NFC-e são configurados em **Configurações › Fiscal**.
Passar para produção exige a permissão `fiscal.emitir`.

### Contrato do adaptador genérico (`GenericHttpAdapter`)

`POST {URL}/documentos`
```json
{ "modelo": "65", "ambiente": "homologacao", "serie": 1, "numero": 123, "referencia": "<uuid do documento no AXIONYX>",
  "dados": { "emitente": {...}, "destinatario": {...}, "itens": [{ "codigo": "...", "descricao": "...", "ncm": "61091000", "cfop": "5102",
             "cstCsosn": "102", "origem": 0, "unidade": "UN", "quantidade": 1, "valorUnitario": 99.9, "desconto": 0, "valorTotal": 99.9, "gtin": "..." }],
             "pagamentos": [{ "tPag": "17", "valor": 99.9, "parcelas": 1 }], "totais": {...}, "informacoesAdicionais": "Venda nº 10" } }
```
`POST {URL}/documentos/{id}/cancelamento` — `{ "justificativa": "...", "chave": "..." }`  
`GET {URL}/documentos/{id}` — consulta situação.

Resposta esperada (todas as rotas):
```json
{ "id": "ref-no-provedor", "status": "autorizado|rejeitado|denegado|processando|contingencia|erro|cancelado",
  "chave": "44 dígitos", "protocolo": "...", "xml": "<nfeProc>...</nfeProc>", "danfe_url": "https://...",
  "mensagens": [{ "codigo": "100", "texto": "Autorizado o uso da NF-e" }] }
```
Status, chave, protocolo e XML gravados no AXIONYX vêm **exclusivamente** dessa resposta. Para um provedor com API diferente,
implemente um novo adaptador em `fiscal-adapter.ts` (interface `FiscalAdapter`) ou exponha um proxy com este contrato.

Antes do envio o sistema valida emitente (CNPJ, IE, endereço, código IBGE), itens (NCM 8 dígitos, CFOP, CST/CSOSN) e totais;
pendências impedem a transmissão e aparecem no detalhe do documento.

---

## 2. WhatsApp — WhatsApp Business Platform (Cloud API oficial), um número por empresa

**Configuração pela tela** (recomendado): *Plataforma › Integrações › WhatsApp › Configurar* (ou *Configurações › WhatsApp*), com a empresa desejada selecionada no topo.

| Campo | Onde encontrar no painel da Meta |
|---|---|
| Número de WhatsApp da empresa | o número registrado na conta do WhatsApp Business |
| Phone Number ID | developers.facebook.com › seu app › WhatsApp › Configuração da API |
| WABA ID (ID da conta do WhatsApp Business) | mesma tela; necessário para sincronizar os modelos |
| Token permanente | business.facebook.com › Configurações do negócio › Usuários do sistema › Gerar token (validade "Nunca", permissões `whatsapp_business_messaging` e `whatsapp_business_management`) |
| App Secret | app › Configurações do app › Básico › Chave secreta do app (valida a assinatura do webhook) |

- Ao salvar, o sistema consulta a Meta (`GET /{phone-number-id}`); se as credenciais forem aceitas, o WhatsApp da empresa é **ativado automaticamente** e as mensagens que aguardavam configuração são liberadas.
- Token e App Secret são gravados **cifrados** (AES-256-GCM) na tabela `integrations`, nunca são devolvidos ao navegador e não aparecem em logs ou na auditoria. Chave: `SECRETS_KEY` (recomendado) ou, na falta dela, derivada do `JWT_SECRET` — se a chave mudar, informe o token de novo.
- **Webhook**: a tela mostra a *Callback URL* (`https://SEU-DOMINIO/api/webhooks/whatsapp/{id}`) e o *Verify token* para colar em *WhatsApp › Configuração › Webhook* na Meta; assine o campo `messages`. O sistema valida o cabeçalho `X-Hub-Signature-256` com o App Secret, atualiza os status (enviado → entregue → lido / erro) e registra as mensagens recebidas (vinculadas ao cliente pelo número), o que abre a **janela de 24 h**.
- **Modelos (templates)**: sincronizados da Meta (`GET /{waba-id}/message_templates`) ou cadastrados pelo nome. Para cada finalidade (cobrança, condicional, aniversário, pós-venda, campanha) escolha um modelo **aprovado** e o dado de cada variável `{{n}}`: primeiro nome, nome completo, loja, WhatsApp da loja, valor em aberto, vencimento, parcelas, número/peças do condicional, saldo de cashback ou texto livre.
- **Regra de envio**: dentro da janela de 24 h (cliente escreveu para a loja) vai o texto digitado; fora dela, o modelo aprovado da finalidade. Sem modelo e com a janela sabidamente fechada, a mensagem fica como erro explicando o motivo (nada é cobrado nem enviado à toa).
- Variáveis de ambiente `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN`, `WHATSAPP_API_VERSION` e `WHATSAPP_APP_SECRET` continuam aceitas como número **global** de reserva para empresas que não cadastraram o próprio.

Regras aplicadas pelo servidor:
- finalidades `pos_venda`, `aniversario`, `cobranca`, `condicional`, `campanha` exigem **consentimento de WhatsApp registrado** no cadastro do cliente (LGPD); sem ele a mensagem fica como `bloqueado_sem_consentimento`;
- `atendimento` (resposta a contato iniciado pelo cliente) não exige opt-in de marketing;
- mensagens de cobrança exigem permissão de financeiro; configurar o WhatsApp exige `integracoes.editar`;
- deduplicação por cliente + finalidade + referência (ex.: o mesmo lembrete de condicional não é enviado duas vezes).

Não há automação por WhatsApp Web, bibliotecas não oficiais ou envio em massa sem consentimento.

---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | ID do número no Meta Business |
| `WHATSAPP_TOKEN` | Token permanente do usuário de sistema |
| `WHATSAPP_API_VERSION` | Versão da Graph API (padrão `v21.0`) |

Regras aplicadas pelo servidor:
- finalidades `pos_venda`, `aniversario`, `cobranca`, `condicional`, `campanha` exigem **consentimento de WhatsApp registrado** no cadastro do cliente (LGPD); sem ele a mensagem fica como `bloqueado_sem_consentimento`;
- `atendimento` (resposta a contato iniciado pelo cliente) não exige opt-in de marketing;
- mensagens de cobrança exigem permissão de financeiro;
- deduplicação por cliente + finalidade + referência (ex.: o mesmo lembrete de condicional não é enviado duas vezes);
- fora da janela de 24h a Meta exige **template aprovado** — cadastre os templates no Business Manager.

Não há automação por WhatsApp Web, bibliotecas não oficiais ou envio em massa sem consentimento.

---

## 3. E-commerce (adaptador REST genérico)

| Variável | Descrição |
|---|---|
| `ECOMMERCE_API_URL` / `ECOMMERCE_API_TOKEN` | API da loja virtual (ou de um middleware) |
| `ECOMMERCE_WEBHOOK_SECRET` | Segredo para validar o webhook de pedidos |

**Saída (ERP → loja)**, via fila com reprocessamento automático (backoff exponencial):
- `PUT /inventory/{sku}` — `{ "sku": "...", "quantity": 10 }` a cada movimento de estoque;
- `POST /products` / `PUT /products/{externalId}` — produto com variações (`reference`, `name`, `description`, `price`, `active`, `variants[] {sku, barcode, size, color, price, stock}`); só reenvia se o conteúdo mudou (hash).

**Entrada (loja → ERP)**: `POST /api/webhooks/ecommerce/{integrationId}`
- cabeçalho `X-Signature`: HMAC-SHA256 hexadecimal do corpo bruto com `ECOMMERCE_WEBHOOK_SECRET`;
- corpo:
```json
{ "id": "PED-1001", "customer": { "name": "Fulana", "email": "f@ex.com", "document": "52998224725", "phone": "11999999999" },
  "items": [{ "sku": "BLU-001-PRE-M", "qty": 1, "price": 129.9 }], "payment": { "kind": "pix", "installments": 1 }, "shippingFee": 0 }
```
- idempotente pelo `id` do pedido (repetições retornam `{ "duplicate": true }`); SKU inexistente ou forma de pagamento não cadastrada geram conflito registrado no log da integração.

---

## 4. Logística

| Variável | Descrição |
|---|---|
| `LOGISTICS_API_URL` / `LOGISTICS_API_TOKEN` | API do agregador de fretes contratado |

`POST /quotes` (cotação) e `POST /labels` (etiqueta). Sem configuração, o envio é registrado manualmente
(transportadora, valor e código de rastreio) na Bag Delivery.

---

## 5. Banco / conciliação
Importação de extrato **OFX** ou **CSV** (`data;descrição;valor`) em **Financeiro › Conciliação**, com conciliação automática
por valor/data (±3 dias) e manual. Open Finance / APIs bancárias não estão implementados.

## 6. Assistente (AXIA)
Responde por regras a partir de consultas reais ao banco, respeitando as permissões do usuário. A conexão com um modelo de
linguagem externo não está implementada.


## Serviços (versão 1.5)

- **WhatsApp**: novas finalidades `agendamento` (lembrete de horário — variáveis `data`, `hora`, `profissional`, `servico`) e `retorno` (convite de retorno — variável `servico` com o último serviço). Para enviar fora da janela de 24 h, cadastre em Integrações › WhatsApp um modelo **aprovado pela Meta** e associe a finalidade. Lembretes e convites só são enviados a clientes com consentimento registrado.
- **NFS-e (serviços)**: ainda **não** há integração. Serviços e pacotes não entram na NFC-e/NF-e (a nota de mercadorias inclui só os produtos, com os pagamentos rateados). A NFS-e é municipal e depende de um provedor/prefeitura; o código do serviço (LC 116) já pode ser informado no cadastro do serviço para uma futura integração.
