# AXIONYX ERP — Varejo e Serviços

ERP web para varejo (moda, hortifrúti, adega, mercadinho, cosméticos) e prestadores de serviço (odontologia, estética, salão de beleza): **Angular 22** (standalone, zoneless, signals) + **API Node.js/TypeScript** + **PostgreSQL**.
A interface preserva o layout, a identidade visual, a navegação e as telas do design AXIONYX original; as funcionalidades
de varejo de moda (grade, PDV, condicional, crediário, cashback…) foram implementadas como fluxos reais sobre o banco.

```
axionyx/
├── backend/            API REST (Node 22.22+ ou 24.15+, TypeScript, única dependência de runtime: pg)
│   ├── migrations/     001_core · 002_catalogo_estoque · 003_vendas_financeiro · 004_fiscal_integracoes_outros · 005_precificacao · 006_whatsapp_empresa · 007_segmentos · 008_hortifruti_adega · 009_site_contatos · 010_mercado_cosmeticos · 011_servicos
│   └── src/            core (http, auth, validação, RBAC) · services (regras de negócio) · modules (rotas) · integrations · test
├── frontend/           Angular 22 (angular.json, proxy para /api)
├── docs/               INTEGRACOES.md (contratos e variáveis) · OPERACAO.md (instalação, backup, atualização)
├── Dockerfile · docker-compose.yml
```

## Início rápido (desenvolvimento)

```bash
# 1) Banco
createdb axionyx            # ou: CREATE DATABASE axionyx OWNER axionyx;

# 2) API
cd backend
cp .env.example .env        # preencha DATABASE_URL e JWT_SECRET (instruções no arquivo)
npm install && npm run build
DEMO_PASSWORD='Escolha-Uma-Senha-1' npm run seed:demo   # empresa FICTÍCIA de demonstração
npm start                   # http://localhost:3000 (migrações aplicadas automaticamente)

# 3) Frontend
cd ../frontend
npm install
npm start                   # http://localhost:4200 (proxy de /api para :3000)
```
Login de demonstração: `admin@demo.axionyx.local` (também `gerente@`, `julia@`, `rafael@`, `bianca@`, `financeiro@demo.axionyx.local`), senha definida em `DEMO_PASSWORD`.
Para uma empresa real: `ADMIN_EMAIL=... COMPANY_NAME=... npm run seed` (a senha é gerada e exibida uma única vez). Produção e Docker: `docs/OPERACAO.md`.

---

## 1. Funcionalidades implementadas

**Plataforma e segurança**
- Login com sessão no servidor (JWT HS256 + tabela de sessões revogáveis), bloqueio após 5 tentativas, limite de taxa, MFA TOTP (ativação/desativação pelo usuário, redefinição pelo admin), troca de senha com política mínima, encerramento de sessões.
- Seleção de empresa e filial; **isolamento por empresa em todas as consultas** e escopo de filiais por usuário.
- RBAC com 54 permissões granulares, perfis editáveis (matriz de permissões), limite de desconto por perfil; validação de permissão **no servidor** em cada rota. Dados sensíveis mascarados por permissão (custo, salário, limite de crédito).
- Trilha de auditoria somente-inclusão (quem, quando, IP, dados), com filtros e exportação.
- Idempotência (`Idempotency-Key`) em vendas, baixas, estoque, condicional, confirmação de compras; transações e travas de linha contra concorrência (venda simultânea da última peça); paginação em todas as listas.
- Empresas, filiais (com caixa criado automaticamente), usuários, perfis, módulos ativáveis por empresa, configurações por seção, monitoramento real do servidor, exportação de dados (backup lógico).

**Catálogo e estoque (moda)**
- Produto com **grade cor × tamanho** (criação em lote, SKU e EAN-13 gerados/validados), marcas, coleções, categorias, fornecedores, tributação (NCM, CEST, CFOP, CST/CSOSN, origem), preço/custo por variação, estoque mínimo.
- Saldo por variação e filial com **histórico completo de movimentos**; entradas, saídas, ajustes, transferências entre filiais, inventário com contagem e ajuste, curva ABC, alertas de mínimo, giro e cobertura.
- **Importação de XML de NF-e de compra**: parser seguro (recusa DOCTYPE/XXE), validação (chave duplicada, CNPJ, destinatário, cStat, soma dos itens), vínculo automático por código do fornecedor aprendido ou EAN, criação de produto com grade a partir dos itens, rateio de frete/desconto no custo, duplicatas → contas a pagar. Nada entra no estoque antes da conferência.
- Etiquetas com código de barras (EAN-13/Code 128) por produto ou por entrada; pedidos de compra; mapa comparativo de custos por fornecedor.

**Vendas**
- **PDV**: bipagem/busca por nome, SKU ou código de barras, cliente, vendedor, múltiplas formas de pagamento com troco, parcelamento, crediário, vale-troca e cashback, desconto por item/total com autorização de supervisor acima do limite, comprovante, NFC-e opcional, atalhos de teclado.
- Caixa (abertura, sangria/suprimento, fechamento com conferência), pedidos, orçamentos (conversão em venda), cancelamento com estorno de estoque/financeiro/comissão/cashback, **trocas e devoluções** (vale-troca, estorno, abatimento no crediário), comissões por regra/vendedor, metas e bônus.
- **Condicional e Bag Delivery** (saída baixa estoque, prazo, prorrogação, retorno parcial, compra vira venda sem baixa dupla, romaneio, lembrete por WhatsApp com consentimento) e **Consignação** para parceiras (remessas, acertos com comissão, encerramento).
- CRM com funil de oportunidades (arrastar entre etapas).

**Financeiro e crediário**
- Contas a receber/pagar com parcelamento, recorrência, baixa parcial, juros/multa calculados pelas regras (dispensa/desconto exige permissão e é auditado), estorno de baixa, cancelamento; liquidação de recebíveis de cartão com taxa da adquirente; cobrança por WhatsApp.
- **Crediário**: limite de crédito, parcela mínima, inadimplência por cliente, **renegociação** (substitui títulos, trilha completa), **carnê** para impressão.
- Lançamentos manuais, transferências entre contas, **fluxo de caixa** realizado + previsto, **conciliação bancária** (OFX/CSV, automática e manual). Nenhum lançamento duplicado (índices únicos por origem).

**Precificação** (menu ERP › Precificação)
- **Custos fixos** mensais por categoria (ocupação, pessoal, pró-labore, administrativo, comercial, financeiro, depreciação), por empresa ou filial, com ativação/inativação e **importação assistida** das despesas recorrentes das contas a pagar (média de 90 dias, revisada antes de gravar).
- **Custos e despesas variáveis**: percentuais sobre o preço (impostos estimados, taxa de cartão, comissão, marketplace, royalties) e valores por unidade (embalagem, etiqueta, frete médio), por canal (loja, e-commerce, marketplace).
- **Parâmetros**: margem líquida desejada, margem mínima de alerta, rateio dos custos fixos, faturamento de referência (média real dos últimos 3 meses ou valor manual) e regra de arredondamento.
- **Precificar produto** pelo **markup divisor** — preço = custo unitário ÷ [1 − (despesas variáveis% + custos fixos% + margem%)] — ou por markup direto, ou analisando um preço informado. Custo unitário com frete, seguro, embalagem, armazenagem, perdas e outros. Resultado com **margem de contribuição** (R$ e %), rateio de fixos, lucro líquido, markup multiplicador e sobre o custo, margem bruta, **preço piso** (cobre variáveis), **preço mínimo** (lucro zero), **ponto de equilíbrio em unidades e faturamento**, análise do preço atual e alertas. Comparação lado a lado de até 4 cenários, simulações salvas no histórico, **aplicação do preço ao produto ou à variação** (recalculado no servidor, transação, idempotência, auditoria, histórico e fila do e-commerce) e **metas de vendas versionadas** por produto com realizado.
- **Painel gerencial**: faturamento, CMV, margem de contribuição e índice de MC, custos fixos, resultado operacional, **ponto de equilíbrio**, **margem de segurança**, **grau de alavancagem operacional** e faturamento necessário para a margem desejada; série de 6 meses faturamento × equilíbrio; estrutura do faturamento; fixos por categoria.
- **Análise de produtos**: margem de contribuição e lucro de cada produto no preço atual, preço mínimo e sugerido, vendas de 90 dias e situação (OK, abaixo da meta, abaixo do mínimo, prejuízo, não cobre variáveis, sem custo).
- Permissões novas: `precificacao.ver`, `precificacao.editar`, `precificacao.aplicar` (Administrador e Gerente de Loja com todas; Financeiro com ver/editar). São indicadores gerenciais: a alíquota de impostos é estimada e não substitui a apuração do contador.

**Clientes, fidelidade e marketing**
- Cadastro com validação de CPF/CNPJ, preferências (tamanhos, marcas, estilos), consentimentos LGPD por canal, exportação e anonimização de dados pessoais, segmentos automáticos (aniversariantes, inativos, pós-venda, inadimplentes…).
- **Cashback**: % configurável, compra mínima, validade, limite de resgate, extrato, ajuste auditado, expiração.

**Fiscal, contabilidade e demais módulos**
- NF-e/NFC-e a partir da venda com validação completa dos dados e camada de provedor desacoplada; monitor de pendências e vendas sem documento; DANFE/XML quando o provedor retornar.
- Contabilidade gerencial: lançamentos em partida dobrada derivados dos movimentos, DRE mensal comparativa, plano de contas, posição patrimonial.
- Relatórios com filtros (período, filial, marca, coleção, tamanho, cor, vendedor), conferência com os cabeçalhos das vendas e exportação CSV: vendas por dia/mês/vendedor/canal/filial/produto/marca/coleção/categoria/tamanho/cor, pagamentos, estoque por agrupamento, giro, vencimentos, inadimplência, compras, melhores clientes, fiscal.
- Dashboard executivo e Intelligence com dados reais: previsão semanal com **backtest de 5 métodos** (MAPE/RMSE/viés), reposição sugerida → pedido de compra, otimização do mix de compra por orçamento (programação linear), simulação de cenários sobre a base de 90 dias, insights por regras com evidência.
- RH (colaboradores, documentos, desempenho comercial), Jurídico (processos, prazos, provisão segundo CPC 25, documentos), Documentos (pastas, upload, pré-visualização), Mensagens.

## 2. Funcionalidades que dependem de credenciais ou provedores externos

| Recurso | Situação sem credenciais | Para ativar |
|---|---|---|
| Autorização de NF-e/NFC-e na SEFAZ | Documento validado e armazenado como **"Pendente de configuração"**, marcado **"Sem valor fiscal"**; nunca é exibido como autorizado | Contratar provedor fiscal homologado + certificado digital A1 e CSC; `FISCAL_PROVIDER`, `FISCAL_PROVIDER_URL`, `FISCAL_PROVIDER_TOKEN` |
| Envio de WhatsApp | Mensagens registradas como "pendente de configuração" ou "sem consentimento"; nada é enviado | Conta na WhatsApp Business Platform (Cloud API oficial). O administrador informa número, Phone Number ID, WABA ID, token permanente e App Secret em **Integrações › WhatsApp** (um número por empresa); modelos aprovados na Meta |
| Loja virtual (catálogo, estoque, pedidos) | Eventos na fila "aguardando configuração"; webhook recusado | `ECOMMERCE_API_URL`, `ECOMMERCE_API_TOKEN`, `ECOMMERCE_WEBHOOK_SECRET` |
| Cotação de frete e etiquetas | Envio registrado manualmente | `LOGISTICS_API_URL`, `LOGISTICS_API_TOKEN` |
| Modelo de linguagem para a AXIA | Assistente responde por regras com consultas reais | Não implementado |
| Open Finance / APIs bancárias | Conciliação por arquivo OFX/CSV | Não implementado |

Contratos de API, variáveis e regras (LGPD, deduplicação, reprocessamento): `docs/INTEGRACOES.md`.

## 3. Testes executados e resultados

- **Testes automatizados da API** (`backend/src/test`, `node --test`, banco dedicado `*_test` recriado a cada execução): **54 de 54 aprovados** (API e unitários) — autenticação e mensagens que não revelam usuários, rotas protegidas, CPF inválido, grade cor × tamanho com EAN válido e código duplicado, **isolamento entre empresas**, **permissões** (vendedor sem acesso a financeiro/admin/configurações), histórico de estoque, **idempotência de venda**, **concorrência na última peça** (só uma venda conclui), pagamento insuficiente, desconto acima do limite, crediário (parcelas, baixa parcial idempotente, estorno sem duplicidade, limite de crédito), troca com vale e bloqueio de devolução excedente, condicional sem baixa dupla, cancelamento com estorno e auditoria, **fiscal nunca autoriza sem provedor**, XML com DOCTYPE/XXE e nota duplicada recusados, WhatsApp sem consentimento bloqueado, integrações sem credenciais não ativam e segredos não são gravados, salário mascarado sem permissão, relatório conferindo com as vendas, **precificação** (custos e parâmetros validados no servidor e isolados por empresa, preço calculado no servidor, aplicação idempotente com histórico e auditoria, vendedor sem acesso, parâmetros inviáveis recusados, meta ativa única por produto), **WhatsApp por empresa** contra uma Graph API simulada (credenciais cifradas e isoladas por empresa, permissão, teste e ativação, sincronização de modelos, recusa de modelo não aprovado, envio do modelo da finalidade com variáveis preenchidas, webhook com verificação, assinatura falsa recusada, status "lido" e mensagem recebida abrindo a janela de 24 h), **serviços** (salão, estética e odontologia: gerente que também atende, profissional restrito aos próprios serviços e à própria agenda, conflito de horário, expediente, bloqueio, duas reservas simultâneas do mesmo horário com apenas uma aceita, cobrança do atendimento no PDV com preço do agendamento, comissão por profissional em serviço e produto, serviço sem movimentar estoque, NFC-e só com produtos, cobrança dupla recusada, cancelamento estornando comissões, pacote exigindo cliente e baixando uma sessão por atendimento com comissão por sessão, fechamento de comissões com conta a pagar, anamnese exigindo consentimento, acesso ao prontuário auditado, odontograma FDI, plano de tratamento aprovado cobrado no crediário, permissões e isolamento entre empresas, retorno de clientes na Inteligência de Serviços e lembrete sem consentimento bloqueado); mais testes unitários de CPF/CNPJ/GTIN, parcelamento sem perda de centavos, validação de entrada, parser XML, hash de senha, JWT (adulteração/expiração), TOTP e o motor de precificação (markup divisor com o caso de referência custo 100 / variáveis 10% / margem 20% → R$ 142,86, markup 1,4286, margem bruta 30%; custos fixos, perdas e ponto de equilíbrio; modos markup e preço; arredondamento; parâmetros inviáveis; MC, equilíbrio, margem de segurança e alavancagem).
  ```bash
  cd backend && TEST_DATABASE_URL=postgres://usuario:senha@localhost:5432/axionyx_test npm test
  ```
- **Compilação**: backend com `tsc` (strict) sem erros; frontend compilado com o compilador do Angular 22.2.3 (`ngc`, `strictTemplates`) sem erros.
- **Testes de interface no navegador (Chromium/Playwright)** sobre a empresa de demonstração: as **82 rotas** da aplicação abriram sem erro de JavaScript nem falha de API nas empresas de moda, salão, odontologia e estética; agenda → cobrança no PDV com produto, prontuário, odontograma e plano de tratamento cobrado no crediário executados pela interface; fluxos completos executados com sucesso — venda no PDV (bipagem, PIX + dinheiro com troco), importação de XML → criação de produto com grade → confirmação → estoque e contas a pagar, condicional com retorno parcial gerando venda, baixa de título com juros/multa, renegociação gerando carnê, importação de extrato na conciliação, precificação de produto com comparação de cenários e aplicação do preço; verificação de layout em largura de celular (390 px).
- Limitação do ambiente: o registro npm estava bloqueado nesta sessão, então `npm install`/`ng build` do Angular CLI e a imagem Docker **não puderam ser executados aqui**; a compilação foi feita com os mesmos pacotes Angular 22.2.3 por meio do `ngc`. Rode `npm install && npm run build` no frontend ao instalar.

## 4. Configuração e validação

1. Siga o *Início rápido* (ou `docker compose up -d --build` com `POSTGRES_PASSWORD` e `JWT_SECRET` definidos).
2. Gere a empresa de demonstração (`npm run seed:demo`) — toda a interface exibe a faixa **"Empresa de demonstração — dados fictícios"**; ou crie a empresa real com `npm run seed`.
3. Em **Administração › Empresas**, complete CNPJ, IE, endereço e código IBGE (exigidos pela validação fiscal); em **Configurações**, ajuste regras de vendas, crediário (juros/multa), trocas, condicional, fiscal e segmentos; em **Perfis e Permissões**, revise os perfis.
4. Roteiro sugerido de validação: abrir caixa → vender no PDV com cliente e crediário → imprimir carnê → trocar uma peça → importar um XML de compra → criar produto com grade e confirmar → liberar um condicional e registrar o retorno → baixar parcela com juros → conciliar extrato → conferir relatórios, DRE e auditoria.
5. Precificação: em **Precificação › Custos Fixos** cadastre (ou importe das contas a pagar) aluguel, folha, pró-labore, energia, sistemas etc.; em **Custos Variáveis e Parâmetros** revise a alíquota de impostos (estimativa inicial de 6% — confirme com o contador), a taxa de cartão (inicializada com a maior taxa das formas de pagamento), a comissão e a margem desejada; depois use **Precificar Produto** e confira o **Painel**.
6. Integrações: configure as variáveis do item 2 no servidor e ative em **Plataforma › Integrações**; eventos pendentes são reprocessados.

## 5. Limitações conhecidas e próximos passos

- **Fiscal**: depende de provedor homologado; carta de correção, inutilização de numeração, contingência offline da NFC-e, NFS-e, SPED/obrigações acessórias e apuração de impostos não estão implementados (a DRE usa alíquota estimada configurável). O sistema não deve ser apresentado como certificado fiscalmente.
- **Contabilidade** é gerencial (derivada dos movimentos financeiros); a escrituração oficial continua com o contador.
- RH não inclui ponto, férias e folha; Jurídico não consulta tribunais; a AXIA não usa modelo de linguagem.
- Precificação: os impostos são um percentual estimado (sem apuração por regime/NCM, substituição tributária ou DIFAL); o rateio de fixos é proporcional ao faturamento (não por tempo de prateleira ou m²); o custo do cadastro não inclui frete/seguro de compra — use a tela Precificar Produto para considerá-los.
- MFA mostra a chave para digitação no aplicativo autenticador (sem QR Code).
- Previsão de demanda usa 12 semanas (sem sazonalidade anual); a otimização considera uma restrição de orçamento.
- Não há envio de e-mail (recuperação de senha é feita pelo administrador com senha temporária), nem PWA/offline no PDV.
- Próximos passos sugeridos: escolher e plugar o provedor fiscal (adaptador específico), templates de WhatsApp aprovados, recuperação de senha por e-mail, QR Code do MFA, PDV offline, testes de interface automatizados em CI, NFS-e e SPED via provedor, conector da loja virtual escolhida.

## Atualização para a versão com Precificação

Quem já usa o sistema não precisa recriar o banco: a migração `backend/migrations/005_precificacao.sql` é aplicada **automaticamente** quando a API inicia (ou manualmente com `npm run migrate`). Ela cria as tabelas `pricing_settings`, `fixed_costs`, `variable_costs`, `pricing_history` e `pricing_goals`, cadastra parâmetros iniciais, inicializa as despesas variáveis a partir do que já está configurado (alíquota estimada, maior taxa de cartão, comissão padrão), concede as permissões aos perfis padrão e habilita o módulo. Somente na empresa de **demonstração** ela inclui custos fixos de exemplo.

```bash
cd backend && npm run build && npm start      # aplica a 005 e sobe a API
cd ../frontend && npm start                   # http://localhost:4200 → menu Precificação
```

## WhatsApp por empresa (versão 1.2)

Cada empresa cadastrada usa o **próprio número**. O administrador configura em **Plataforma › Integrações › WhatsApp › Configurar** (atalho em **Configurações › WhatsApp**):
1. número, Phone Number ID, WABA ID, token permanente e App Secret → **Salvar e ativar** (o sistema valida na Meta e já ativa);
2. copia a URL e o token do **webhook** para o painel da Meta (confirmações de entrega/leitura e respostas dos clientes);
3. **sincroniza os modelos** aprovados e escolhe qual usar em cobrança, condicional, aniversário etc., ligando cada variável `{{1}}`, `{{2}}`… a um dado do sistema;
4. envia uma **mensagem de teste**.

A migração `006_whatsapp_empresa.sql` é aplicada automaticamente ao iniciar a API. Recomenda-se definir `SECRETS_KEY` no servidor (chave que cifra os tokens). Detalhes: `docs/INTEGRACOES.md`.

### Recuperar o acesso de um usuário pelo servidor
```bash
RESET_EMAIL='usuario@empresa.com' RESET_PASSWORD='Nova-Senha-Forte-1' npm run reset-password
```
Redefine a senha, desbloqueia a conta e encerra as sessões (não cria usuários).

## Versão 1.3 — site institucional e segmentos de negócio

**Site (www.axionyxerp.com.br)**: a raiz `/` passou a ser a página de apresentação do AXIONYX (inteligência, recursos, segmentos, como funciona, perguntas frequentes e formulário de demonstração — sem teste grátis). O link **Axionyx** no canto superior direito leva ao sistema (`/app` → login). Os pedidos de demonstração ficam em **Administração › Empresas › Contatos do site** (somente superadministrador). As imagens do site são telas reais do sistema com dados fictícios.

**Segmentos**: ao criar a empresa escolhe-se o segmento — **Moda**, **Hortifrúti/Quitanda**, **Adega/Bebidas** ou **Varejo geral** (Mercadinho em preparação). O pacote ativa os módulos e o menu do ramo, o vocabulário, as unidades e as categorias iniciais. Em **Administração › Módulos** é possível aplicar outro segmento (só acrescenta; nada é apagado) e ligar/desligar cada recurso. As empresas existentes foram convertidas para **Moda** com todos os módulos que já tinham.

| Recurso (módulo) | O que faz |
|---|---|
| Grade cor × tamanho, Coleções | Moda (como antes) |
| Venda por peso e balança | Produto por kg com código de balança (PLU); o PDV pede o peso ou **lê a balança pelo navegador** (Chrome/Edge, protocolo ENQ); lê a **etiqueta de balança** (EAN-13 com preço ou peso embutido, formato configurável em Configurações › Balança); impressão de etiquetas de balança para produtos embalados na loja |
| Lotes, validade e perdas | Entrada com lote/validade (e safra), validade padrão por produto, alertas de vencimento no menu, baixa **FEFO** nas vendas, registro de **perdas** por motivo com custo e relatório (% do faturamento e do CMV) |
| Embalagens | Caixa/fardo com código de barras próprio e preço da caixa; o PDV lança a quantidade em unidades |
| Combos e kits | Preço fechado, validade, código de barras; cada item baixa o próprio estoque com o preço rateado |
| Controle de maioridade | Produto restrito exige confirmação do operador no PDV — **validado no servidor** e registrado na venda |

Quantidades passaram a aceitar 3 casas decimais (kg) apenas para produtos por peso/medida; produtos por unidade continuam inteiros (validado no servidor). A migração **amplia** os tipos das colunas de quantidade sem alterar nenhum valor existente — testado restaurando uma cópia do banco anterior: contagens e somas idênticas antes e depois.

### Domínio próprio no Railway
1. Railway › serviço axionyx › **Settings › Networking › Custom Domain** › `www.axionyxerp.com.br` (e, se quiser, `axionyxerp.com.br`).
2. No Registro.br, crie o registro **CNAME** `www` apontando para o endereço indicado pelo Railway (o certificado HTTPS é emitido automaticamente).
3. Atualize a variável `CORS_ORIGIN` para `https://www.axionyxerp.com.br,https://axionyx.up.railway.app`.
4. No webhook do WhatsApp (painel da Meta), troque a URL de retorno pelo novo domínio.

## Versão 1.4 — Mercadinho/Conveniência e Cosméticos/Perfumaria

**Mercadinho e conveniência** (`mercado`): código de barras do fabricante, venda por peso e etiqueta de balança, **preço por quantidade (atacarejo)** — ex.: a partir de 6 un. R$ 4,50 cada, a partir de 12 un. R$ 4,00 —, fardos/caixas com código próprio, lotes e validade (alerta de 7 dias), combos, controle de maioridade (bebidas alcoólicas e tabacaria) e fiado pelo crediário. Categorias iniciais de mercearia, bebidas, frios, limpeza, higiene, bomboniere, tabacaria etc.

**Cosméticos e perfumaria** (`cosmeticos`): variações por **tonalidade** e **volume** (grades 5–200 ml, peso em g, P/M/G), atributos de família olfativa, concentração (Parfum, EDP, EDT…), linha, indicação e registro/notificação ANVISA, lote e validade (alerta de 60 dias), baixa de **testers e amostras** como perda, kits presenteáveis (combos), venda por revendedoras (consignação), preço por quantidade, cashback e CRM.

O preço por quantidade é um módulo (`precos_quantidade`) que qualquer segmento pode ativar em Administração › Módulos; as faixas ficam na ficha do produto e o preço é **recalculado no servidor** em cada venda (o PDV só exibe).

## Versão 1.5 — Odontologia, Estética e Salão de beleza + nova marca

Três novos segmentos de **prestação de serviço**, que também vendem produtos no mesmo PDV:

| Segmento | Código | Módulos do pacote | Vocabulário |
|---|---|---|---|
| Odontologia | `odontologia` | agenda, prontuário, odontograma/planos de tratamento, pacotes | Paciente, Consulta, Prontuário, Consultório |
| Clínica de estética | `estetica` | agenda, ficha de avaliação, pacotes, combos, validade | Sessão, Ficha de avaliação, Sala |
| Salão de beleza e estética | `salao` | agenda, ficha técnica, pacotes, combos, validade | Ficha técnica, Cadeira/sala |

O salão já nasce com categorias de cabelo, unhas, sobrancelhas **e de estética facial/corporal**, e a ficha pode usar o modelo do salão ou o de estética.

**Profissionais** (Agenda › Profissionais e Comissões): podem ter ou não acesso ao sistema. O gerente ou dono que também atende clica em **“Eu também atendo”** e passa a aparecer na agenda com o próprio expediente e comissão (0% para quem não recebe comissão). O perfil **Profissional** (criado ao aplicar um segmento de serviço) vê e agenda só na própria agenda; com a permissão `agenda.todas` (gerente/recepção) vê todos.

**Serviços e pacotes**: serviço tem duração, comissão própria (opcional), intervalo de retorno sugerido e código LC 116; não movimenta estoque. Pacote = N sessões de um serviço com validade; o saldo fica na ficha do cliente e cada sessão realizada é baixada (com trava contra uso em dobro) e gera a comissão do profissional sobre o valor da sessão.

**Agenda**: colunas por profissional, expediente com intervalos, bloqueios (folga/curso), conflito de horário verificado no servidor com trava por profissional (duas reservas simultâneas do mesmo horário: só uma passa), horários livres sugeridos, encaixe sem cadastro, confirmação, início, falta, cancelamento com motivo, remarcação, lembrete pelo WhatsApp oficial (finalidade `agendamento`, só com consentimento) e **cobrança no PDV**: o PDV abre com os serviços do atendimento, o preço vem do agendamento (o caixa não altera) e é possível incluir produtos vendidos na hora.

**Comissão por profissional**: por item (serviço ou produto), na ordem: percentual do serviço no cadastro do profissional › percentual do serviço › padrão do profissional (serviços/produtos). Cancelamentos e devoluções estornam. Itens sem profissional seguem a comissão de vendedor já existente. “Fechar comissões” marca os lançamentos do período e gera a conta a pagar.

**Prontuário / fichas** (dados de saúde — LGPD art. 11): anamnese por modelo do ramo com **consentimento obrigatório**, alertas (alergias, hipertensão, anticoagulante, isotretinoína etc.) exibidos na ficha e ao agendar, evolução, ficha técnica (ex.: fórmula de coloração), avaliação. Registros **não são editados nem excluídos** (correção por adendo) e **cada acesso à ficha é auditado**. Permissões próprias: `prontuario.ver` e `prontuario.editar`.

**Odontologia**: odontograma FDI (permanentes e decíduos, faces M/D/O/I/V/L/P, condição e situação existente/planejado/realizado, com histórico) e **plano de tratamento** com itens por dente, desconto geral rateado, validade, impressão para assinatura, aprovação, procedimentos realizados pela agenda e **cobrança no PDV** (parcelamento no crediário; o desconto aprovado no plano não exige nova autorização).

**Inteligência de Serviços**: ocupação da agenda por profissional (passado e próximos 7 dias), mapa de ocupação por dia × hora, faltas, faturamento por hora, serviços que mais faturam, **“Hora de voltar”** (clientes que passaram do intervalo habitual de retorno — do cadastro do serviço ou calculado pelo histórico — e sem horário marcado, com convite pelo WhatsApp), pacotes parados e planos aguardando aprovação. As descobertas sobre horários só aparecem com histórico mínimo.

**Fiscal**: serviços (ISS) **não entram na NFC-e/NF-e**: a nota de mercadorias inclui só os produtos (com rateio dos pagamentos) e os serviços devem ser documentados por **NFS-e municipal**, que ainda não é emitida pelo sistema (depende de integração com o provedor/prefeitura).

**Nova marca**: o símbolo AXIONYX passa a ser uma rede de nós conectados em um hexágono (inteligência que conecta dados e decisões), aplicado no menu, login, abertura, assistente, site, favicon e ícone de atalho (`apple-touch-icon.png`).

Configurações › Agenda: duração padrão, permitir agendar fora do expediente, antecedência do lembrete, tolerância de falta e fuso horário da agenda.

### 1.5.1 — Suporte da plataforma oculto para o cliente
O superadministrador (suporte AXIONYX), que fica vinculado às empresas que cria, não aparece mais na lista de usuários, na contagem de usuários da empresa e dos perfis, nos seletores de vendedor/profissional nem na contagem de sessões ativas do cliente, e não pode ser alterado pelo administrador da empresa. Na auditoria, as ações dele continuam registradas e aparecem como "Suporte AXIONYX". Título da aba: "AXIONYX - ERP".

### 1.5.2 — Responsividade mobile e PC
- **Celular**: tabelas viram cartões legíveis (rótulo + valor), indicadores em 2 colunas, formulários em coluna única com campos de 16px (sem zoom automático no iPhone), janelas abrem como painel inferior com botões fixos, Configurações com abas horizontais e avisos em largura total.
- **Site de apresentação no celular**: página ~55% mais curta — seções em carrossel deslizante, textos enxutos, abas viram chips, etapas e FAQ compactos e barra fixa "Agendar demonstração / Entrar" durante a rolagem. Tablet também em carrossel.
- **PC**: grades de formulário com colunas automáticas; campos e caixas de seleção sempre alinhados pela base (ex.: Precificar Produto) em qualquer largura de tela.
- Sem alterações no banco de dados.

### 1.5.3 — Novo menu do site no celular
Cabeçalho do site com a marca em destaque à esquerda e o menu hambúrguer à direita. O menu abre em painel de tela cheia com ícones por seção, botão "Agendar demonstração", marca AXIONYX em destaque e o botão **Entrar** no rodapé (fecha com Esc, ao tocar em um item ou ao alargar a tela). No PC o botão de acesso passa a se chamar "Entrar". (1.5.3.1: limite de estilos por componente no `angular.json` ampliado para 40 kB, pois o site ultrapassava 16 kB e travava o build de produção.)

### 1.6.0 — Minha Carteira: assinaturas, cobrança automática e auditoria
Área exclusiva do superadministrador para gerir os clientes do próprio AXIONYX ("ERP dentro do ERP"):
- **Painel da Carteira**: MRR, ARR, clientes ativos, ticket médio, recebido no mês (bruto, líquido e taxas), a receber, em atraso, novos, churn, gráficos de 12 meses, MRR por plano e segmento, meios de pagamento e próximos vencimentos.
- **Clientes e Contratos**: proposta → auditoria (risco automático) → aprovação cria empresa e administrador → pagamento libera o acesso. Vincula clientes que já usam o sistema sem bloqueá-los. Cobranças avulsas, baixa manual, estorno, suspensão, reativação e cancelamento com motivo.
- **Fila de Auditoria**: novas propostas e só as exceções das renovações (inadimplência, suspensão, chargeback, estorno, troca de titular, pagamento divergente, assinatura no cartão cancelada).
- **Cobranças** (com exportação CSV), **Planos** e **Mercado Pago** (situação das credenciais, URL do webhook, teste de conexão e notificações recebidas).
- **Minha assinatura** para o cliente: situação, botão de pagamento (Pix ou cartão) e histórico; avisos de vencimento e modo somente consulta quando suspenso.
- Mercado Pago: Checkout Pro (link mensal Pix/cartão) e assinatura recorrente no cartão; webhook com assinatura HMAC verificada, consulta do pagamento na API, idempotência e conciliação horária.
- Migração `012_assinaturas.sql` só acrescenta tabelas: empresas existentes continuam funcionando sem cobrança até serem vinculadas.

### 1.7.0 — Equipe da plataforma (superadministradores com permissões)
- **Equipe da Plataforma** (Minha Carteira › Equipe): o proprietário cadastra agentes operacionais com permissões: acessar empresas clientes (somente consulta), alterar dados nas empresas, criar empresas, ver carteira, propostas, auditar, financeiro da carteira, planos/Mercado Pago e gerenciar a equipe. Modelos rápidos: Suporte (consulta), Suporte completo, Comercial, Financeiro e Auditor.
- Regras de segurança: ninguém concede permissão que não tem; só proprietário cria/altera proprietário; ninguém altera o próprio acesso; sempre resta um proprietário ativo; alteração de acesso derruba as sessões do membro; contas de superadministrador não podem ser alteradas pelas telas de usuários das empresas. Atividade de cada membro consultável.
- Agente sem "Acessar empresas clientes" só entra na empresa base; sem "Alterar dados", fica somente consulta dentro das empresas.
- **Senha temporária obrigatória de trocar** no primeiro acesso (membros da equipe, administrador criado na aprovação de proposta e usuários criados/redefinidos com senha gerada). A troca da própria senha fica no menu do nome › Minha senha e segurança.
- Superadministradores continuam fora da lista e da contagem de usuários das empresas (empresas, perfis, sessões e carteira).
- Migração `013_equipe_plataforma.sql` só acrescenta colunas; os superadministradores atuais viram proprietários (acesso total, como antes).

### 1.8.0 — Oficina mecânica (carro e moto)
Novo segmento **Oficina mecânica (carro e moto)** para oficinas, centros automotivos e oficinas de moto que prestam serviço e vendem produtos (óleos, peças, acessórios):
- **Ordens de Serviço**: abertura pela placa (padrão antigo ou Mercosul), veículo novo na hora, km de entrada (não aceita km menor que o último), nível de combustível, reclamação e **checklist de entrada** (OK, avaria, ausente) para carro e moto.
- **Orçamento** com quatro tipos de item: **serviço de preço fechado** (cadastro de serviços), **mão de obra por hora** (horas × valor-hora da OS, aceita 1,5 h), **peças** e **produtos** do estoque (com aviso de estoque insuficiente e quantidade fracionada, ex.: 3,5 L de óleo).
- **Aprovação do cliente item a item** (quem aprovou e por qual canal); itens não aprovados ficam recusados e não são executados nem cobrados. Item incluído durante a execução fica aguardando nova aprovação (configurável).
- Andamento: orçamento → aguardando aprovação → aprovada → em execução ⇄ aguardando peça → pronta → entregue. Prazo de entrega com alerta de atraso.
- **Cobrança no PDV** com os valores aprovados: serviços e mão de obra geram comissão para o mecânico; peças baixam do estoque na venda; NFC-e só das mercadorias (serviço = NFS-e municipal, não emitida pelo sistema). OS pronta e cobrada é entregue automaticamente, com **garantia** (padrão 90 dias).
- **Histórico por placa**, alerta de veículo em garantia, **lembrete de revisão** por km e/ou dias (ex.: troca de óleo a cada 5.000 km) e impressão do orçamento/OS com termo de autorização.
- **Painel da Oficina**: veículos no pátio, atrasadas, aprovação de orçamentos, faturado (mão de obra × peças), ticket médio, horas vendidas, permanência média, produtividade por mecânico, peças mais vendidas e revisões chegando.
- Novas permissões: Oficina — ver, editar e aprovar (alterar preço/valor-hora/garantia e cancelar OS). Configurações › Oficina: valor-hora, garantia e aprovação de adicionais.
- Site: segmentos em **carrossel** (setas e indicadores; deslizar no celular) com o novo segmento.
- Migração `014_oficina.sql` só acrescenta tabelas e colunas.

### 1.9.0 — Clínicas e consultórios de saúde (todas as especialidades)
Novo segmento **Clínicas e consultórios de saúde**, para o profissional que atende sozinho ou para clínicas multiprofissionais (medicina, psicologia, fisioterapia, nutrição, fonoaudiologia, enfermagem, terapia ocupacional e outras):
- **Perfis prontos**: Profissional (prontuário e documentos), **Recepcionista** (agenda, recepção, cadastro, caixa e convênios — sem acesso ao prontuário) e **Gerente da clínica** (gestão, financeiro e relatórios — sem acesso ao prontuário). O dono pode também atender (“Eu também atendo”).
- **Profissional com conselho estruturado** (CRM, CRP, CREFITO, CRN, CRFa, COREN, CRO, CREF, CRF, CRBM…, número, UF e RQE) e especialidade.
- **Recepção / sala de espera**: chegada do paciente, tempo de espera, chamar para o atendimento, concluir, cobrar particular ou gerar a guia do convênio; atualiza sozinha.
- **Agenda**: tipo de atendimento (primeira consulta, retorno, sessão, procedimento, exame, teleconsulta com link da sala), pagamento particular/convênio/cortesia, carteirinha, guia e autorização (preenchidos a partir do cadastro do paciente).
- **Prontuário**: consulta no roteiro SOAP, sessão, avaliação, resultado de exame, **sinais vitais** (com IMC), **CID-10**, **sigilo por registro** (padrão para profissionais como psicólogos: só o autor vê; os demais veem apenas que há registros restritos), retificação por adendo (o original é preservado e só o autor retifica registro sigiloso), código de integridade e acesso auditado.
- **Saúde e convênio do paciente**: nome social, CNS, convênio/plano/carteirinha, responsável legal, contato de emergência e — só para profissionais — tipo sanguíneo, alergias, condições e medicamentos (aparecem como alerta no prontuário e no agendamento).
- **Documentos clínicos**: receituário, atestado (CID só com autorização expressa do paciente), declaração de comparecimento, solicitação de exames, encaminhamento, relatório/laudo, orientações e termo de consentimento. Emitidos apenas pelo próprio profissional, com registro no conselho, numeração e código de verificação; impressão para assinatura manuscrita (ou assinatura digital externa ICP-Brasil — o sistema não assina digitalmente). Não são apagados: cancelamento com motivo.
- **Convênios e faturamento**: cadastro das operadoras (ANS, prazo, exigência de autorização), tabela de preços com código TUSS, guias geradas ao concluir atendimentos por convênio (não vão para o caixa), lotes com protocolo do portal, retorno com **pagamento e glosa** (motivo obrigatório), lançamento do recebido no financeiro, repasse do profissional sobre o valor recebido e exportação CSV. Não há transmissão TISS/XML: o envio é feito no portal da operadora.
- **Painel da Clínica**: agenda do dia, sala de espera, espera média, atendimentos, faltas, pacientes novos, particular × convênio, receita particular, a faturar/aguardando/recebido, índice de glosa, produção por profissional e por especialidade.
- Avisos no sino: pacientes na sala de espera, guias a faturar e lotes com pagamento atrasado.
- Migração `015_saude.sql` só acrescenta tabelas e colunas e amplia listas de valores permitidos (tipos de registro e de comissão); nenhum dado existente é alterado.

### 1.10.0 — Convite por e-mail com link de ativação
- Novo usuário (Administração › Usuários), novo membro da Equipe da Plataforma e administrador do cliente aprovado na carteira recebem um **link de ativação** por e-mail e criam a própria senha — nenhuma senha aparece na tela nem vai por e-mail. Opções no cadastro: link por e-mail (padrão quando configurado), senha temporária ou senha definida na hora.
- **Redefinição por link**: em Usuários › Senha (ou Equipe › Acesso / senha) escolha entre enviar link por e-mail ou gerar senha temporária. Lista mostra "Aguardando ativação" e falhas de envio; botão "Convite" reenvia o link.
- Envio por **serviço transacional** (Resend ou Brevo, por HTTPS) ou **SMTP** do seu e-mail (no Railway, só no plano Pro). Cliente SMTP próprio com STARTTLS/TLS obrigatório, sem novas dependências.
- Link de uso único, válido por 48 h (configurável), token guardado só como hash, sessões encerradas ao usar; se o envio falhar, alternativa automática por senha temporária.
- Minha Carteira › **E-mail de convites**: situação da configuração, e-mail de teste e histórico de envios.
- Migração `016_ativacao_email.sql` só acrescenta tabelas e uma coluna.

### 1.10.1 — Navegação: trilha clicável e pesquisa no celular
- **Trilha de navegação clicável** em todas as telas: cada nível (ex.: Cadastros › Clientes › Ficha do Cliente) leva à tela correspondente, e o ícone de casa volta à página inicial. Só vira link o que o usuário pode abrir (mesmas regras de permissão e módulos do menu). Ctrl/⌘+clique abre em nova aba.
- **Celular**: o cabeçalho mostra início, "‹ nível anterior" (para voltar com um toque) e a tela atual; **lupa de pesquisa** sempre visível, abrindo a pesquisa em tela cheia com teclado de busca, botão Cancelar, itens maiores para o toque e **acesso rápido** aos favoritos e telas recentes.
- Somente frontend e versão — nenhuma migração.

### 1.10.2 — Correções da auditoria de segurança
- **Contas entre empresas (crítico)**: cadastrar um e-mail que já tem conta no AXIONYX agora gera um **convite** — o acesso só vale depois que a própria pessoa aceita ao entrar (tela de escolha da empresa). A empresa só redefine senha, zera MFA ou altera o nome de contas **exclusivas** dela; conta usada em outras empresas aparece como "conta compartilhada" e a própria pessoa redefine pelo novo **"Esqueci minha senha"** (link por e-mail). O administrador pode cancelar convites pendentes.
- **IP real** do visitante a partir do proxy confiável (`TRUST_PROXY_HOPS`, padrão 1 = Railway): cabeçalho forjado não engana mais os limites de tentativas nem a auditoria.
- **Módulos e segmento** só pela equipe da plataforma (seguem o contrato); a tela Módulos fica somente leitura para o cliente.
- **Login**: verificação de senha sem travar o servidor, mesma resposta para e-mail inexistente, senha errada ou conta bloqueada; limite por e-mail+IP; bloqueio da conta só após muitas falhas (alguém não consegue bloquear a conta de outra pessoa com poucas tentativas). Senha com scrypt reforçado (N=2^16), refeita automaticamente no próximo login.
- **MFA**: o mesmo código não pode ser reutilizado; ativar MFA encerra as outras sessões; limites de tentativa em trocar senha, ativar e desativar MFA.
- **Sessões**: administrador só encerra sessões de usuários da própria empresa.
- **Dados sensíveis (LGPD)**: a equipe da plataforma não lê prontuário, documentos clínicos nem salários dos clientes.
- **Webhooks**: e-commerce com segredo próprio por integração (botão "Segredo do webhook" em Integrações); Mercado Pago com limite de frequência e sem guardar conteúdo de notificações com assinatura inválida.
- **Endurecimento**: cabeçalhos HSTS (produção), Permissions-Policy e CORP; `/api/health` público sem versão (versão em `/api/version`, autenticado); limites de tentativa com limpeza de memória; token de sessão só no `sessionStorage` ("Lembrar-me" guarda apenas o e-mail); arquivos estáticos e nomes de upload validados; conciliação filtrada por empresa; dependências de execução com versão fixa.
- Correção de comportamento: editar um usuário (ex.: desativar) não reinicia mais filiais nem a marcação de vendedor.
- Migração `017_seguranca.sql` só acrescenta colunas.
