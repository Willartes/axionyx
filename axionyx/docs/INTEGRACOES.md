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


## 7. Cobrança das assinaturas AXIONYX — Mercado Pago (versão 1.6)

Usada **só pela administração da plataforma** para cobrar os clientes do AXIONYX (não é a maquininha/PDV das lojas).

**Fluxo**
1. *Proposta* (Minha Carteira › Clientes e Contratos › Nova proposta, ou "Criar proposta" a partir de um contato do site) → fica **em análise** com avaliação automática de risco: CNPJ duplicado, recusado antes, situação na Receita (BrasilAPI), razão social divergente, e-mail descartável ou ligado a contrato recusado/cancelado.
2. *Auditoria antes do pagamento*: o superadministrador aprova ou recusa. A aprovação cria a empresa, o administrador do cliente (senha temporária exibida uma única vez) e a primeira cobrança com link de pagamento.
3. *Pagamento libera o acesso*: até o pagamento ser confirmado o cliente só vê "Minha assinatura" (HTTP 402 nas demais rotas). A confirmação vem pelo webhook (ou por baixa manual com justificativa).
4. *Renovação*: 7 dias antes do vencimento a rotina horária gera a mensalidade (link mensal Pix/cartão) ou aguarda a cobrança automática (assinatura no cartão). Vencido → **inadimplente** (acesso mantido na tolerância) → **suspenso** (somente consulta). Pagamento regulariza sozinho.
5. *Fila de auditoria = exceções*: inadimplência, suspensão, chargeback, estorno feito fora do sistema, troca de titular (documento do pagador diferente do último), pagamento a menor/duplicado/de contrato cancelado e assinatura no cartão cancelada/pausada.

Nada é apagado: suspensão e cancelamento deixam os dados disponíveis para consulta e exportação.

**Formas de cobrança por contrato**
- `link_mensal`: Checkout Pro (Pix ou cartão), `external_reference = AXC:<id da cobrança>`.
- `assinatura_cartao`: assinatura recorrente (`/preapproval`), `external_reference = AXK:<id do contrato>`. O Mercado Pago cobra todo mês e tenta de novo quando o cartão recusa.
- `manual`: sem gateway; baixa manual com comprovante.

**Variáveis (Railway › Variables)**
| Variável | O que colocar |
|---|---|
| `MP_ACCESS_TOKEN` | Access Token da aplicação (teste: começa com `TEST-`; depois o de produção) |
| `MP_WEBHOOK_SECRET` | Assinatura secreta exibida em Webhooks › Configurar notificações |
| `APP_PUBLIC_URL` | Ex.: `https://seu-app.up.railway.app` (sem barra no final) |

**Webhook**: URL `APP_PUBLIC_URL/api/public/billing/mercadopago`, eventos *Pagamentos*, *Planos e assinaturas* (vínculo e pagamento recorrente) e *Contestações*. Cada notificação é validada pelo cabeçalho `x-signature` (HMAC-SHA256 do manifesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`) e o recurso é **sempre consultado na API** antes de qualquer liberação. Notificações inválidas são registradas e recusadas (401). Se alguma se perder, a rotina horária busca os pagamentos dos links pendentes (`/v1/payments/search?external_reference=...`) e reprocessa as que falharam.

**Segurança**: dados de cartão nunca passam pelo AXIONYX (checkout hospedado do Mercado Pago). Credenciais só em variáveis de ambiente. Toda ação (aprovação, recusa, baixa manual, estorno, suspensão, reativação, cancelamento) fica na auditoria com usuário e motivo.

**Clientes que já usam o sistema** continuam sem bloqueio até serem vinculados (Clientes e Contratos › Vincular cliente existente), informando até quando já estão pagos.

## 8. E-mail de convites — link de ativação (versão 1.10)

Novos usuários (empresas clientes, equipe da plataforma e administrador do cliente na aprovação da proposta) recebem um **link de ativação** por e-mail e criam a própria senha. Nenhuma senha é exibida na tela nem enviada por e-mail. O mesmo mecanismo envia **links de redefinição de senha** (Usuários › Senha/Convite).

**Segurança**: token aleatório de 256 bits, guardado só como hash SHA-256; uso único; validade `ACTIVATION_HOURS` (padrão 48 h); gerar um novo link invalida os anteriores; ao usar, todas as sessões da conta são encerradas; tentativas limitadas por IP; o link é montado com `APP_PUBLIC_URL` (nunca com o endereço que veio na requisição). Enquanto a conta não é ativada, ela tem uma senha aleatória que ninguém conhece. Se o envio falhar, o sistema registra o erro e oferece uma senha temporária (troca obrigatória no primeiro acesso).

**Opção A — serviço transacional (recomendado; funciona no plano Hobby do Railway)**
1. Crie a conta no Resend (resend.com) ou no Brevo (brevo.com).
2. Adicione o domínio `axionyxerp.com.br` e copie os registros DNS indicados (SPF, DKIM e, se pedidos, DMARC/MX de retorno) para o Cloudflare › DNS, em **DNS only**. Aguarde a verificação.
3. Gere a chave de API e salve no Railway como `RESEND_API_KEY` ou `BREVO_API_KEY`.
4. Defina `EMAIL_FROM` (ex.: `nao-responda@axionyxerp.com.br`), opcionalmente `EMAIL_FROM_NAME`, e `APP_PUBLIC_URL` (ex.: `https://www.axionyxerp.com.br`). Faça o redeploy.

**Opção B — SMTP do seu e-mail (exige Railway Pro, que libera as portas 465/587)**
`SMTP_HOST`, `SMTP_PORT` (587 com STARTTLS ou 465 com TLS), `SMTP_USER`, `SMTP_PASS` (use **senha de aplicativo**), `EMAIL_FROM` igual à conta (ou alias autorizado). Conexões sem criptografia são recusadas.

Com as duas configuradas, `EMAIL_PROVIDER` escolhe (`resend`, `brevo` ou `smtp`); sem ela, a ordem é Resend → Brevo → SMTP.

**Conferir**: Minha Carteira › **E-mail de convites** mostra a situação, envia um e-mail de teste e lista os últimos envios (sem o conteúdo e sem o link).

