# Backup e restauração (versão 1.15)

Exclusivo da **equipe da plataforma** com a permissão **"Backup e restauração"** (Minha Carteira › Equipe da Plataforma). Os clientes não veem esta tela.

## O que o sistema faz

| Recurso | Como funciona |
|---|---|
| **Escopo** | Sistema inteiro **ou** uma empresa isolada (só os dados dela: cadastros, vendas, estoque, financeiro, fiscal, documentos…). |
| **Quando** | Botão "Gerar backup" ou **agendamentos** (diário, semanal ou mensal, no horário de Brasília). |
| **Onde fica** | **Cloudflare R2** (ou outro S3) quando configurado; se não, guardado no próprio banco. Se o R2 falhar no momento, o arquivo vai para o banco e a tela avisa. |
| **Segurança** | Arquivo `.axbak` comprimido e cifrado com **AES-256-GCM**. Arquivo alterado ou chave errada é recusado antes de qualquer gravação. |
| **Retenção** | Cada agendamento mantém as últimas N cópias (1 a 365). Os backups de segurança automáticos são guardados por 30 dias. |
| **Falha** | Se um backup agendado falhar, os proprietários da plataforma recebem e-mail (quando o e-mail está configurado). |
| **Consistência** | Leitura numa "fotografia" do banco (transação somente leitura): o sistema continua funcionando durante o backup. |

## Restaurar uma empresa

Na lista de backups, **Restaurar**:

- **Como cópia** (recomendado para conferir): cria uma nova empresa "… (restaurada em dd/mm/aaaa)" com os dados do backup. A empresa atual não muda. Útil para recuperar um cadastro apagado ou comparar.
- **Substituindo os dados atuais**: só o **proprietário da plataforma**, digitando `SUBSTITUIR`. Antes de tudo, o sistema gera automaticamente um **backup de segurança** da situação atual (aparece na lista como "Segurança"). A empresa volta exatamente ao estado do backup, inclusive os vínculos dos usuários com a empresa; as sessões abertas continuam valendo.

Um backup feito numa versão **mais nova** do AXIONYX não é restaurado numa versão mais antiga (o sistema avisa).

## Configurar o Cloudflare R2 (recomendado)

1. Cloudflare › **R2 Object Storage** › **Create bucket**: nome `axionyx-backups`, localização automática.
2. No bucket › **Settings**: confira que o acesso público está **desligado** (padrão).
3. R2 › **Manage R2 API Tokens** › **Create API token**: permissão **Object Read & Write**, restrito ao bucket `axionyx-backups`. Copie o **Access Key ID** e o **Secret Access Key** (o segredo só aparece uma vez).
4. Anote o **Account ID** (lado direito da página do R2).
5. No Railway, serviço **axionyx** (produção) › **Variables**:

```
BACKUP_R2_ACCOUNT_ID=<account id>
BACKUP_S3_BUCKET=axionyx-backups
BACKUP_S3_ACCESS_KEY_ID=<access key id>
BACKUP_S3_SECRET_ACCESS_KEY=<secret access key>
BACKUP_ENCRYPTION_KEY=<gere abaixo>
```

Gere a chave de criptografia no seu computador:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

6. Depois do deploy: Minha Carteira › **Backup e Restauração** › **Testar** (grava, lê e apaga um arquivo de teste).
7. Crie o agendamento recomendado: **Sistema inteiro, diário às 3h, manter 14 cópias**.

Outros S3 (AWS, Backblaze, MinIO): use `BACKUP_S3_ENDPOINT=https://...` no lugar de `BACKUP_R2_ACCOUNT_ID` e, se precisar, `BACKUP_S3_REGION`. Opcional: `BACKUP_S3_PREFIX` (pasta dentro do bucket; padrão `axionyx-backups`).

### ⚠️ Guarde a BACKUP_ENCRYPTION_KEY fora do Railway

Sem ela, **nenhum backup pode ser aberto**. Guarde uma cópia num gerenciador de senhas. Se a variável não existir, o sistema usa uma chave derivada de `ENCRYPTION_KEY`/`JWT_SECRET` (funciona, mas trocar essas variáveis torna os backups antigos ilegíveis). A tela mostra a "impressão" da chave em uso, para conferir depois.

Não troque a `BACKUP_ENCRYPTION_KEY` depois de ter backups: os antigos continuam exigindo a chave antiga.

## Restaurar o SISTEMA INTEIRO (desastre)

O backup do sistema inteiro é restaurado num **banco novo e vazio**, nunca por cima do banco em uso:

1. Railway › **New** › **Database** › PostgreSQL (ex.: `postgres-restaurado`).
2. Baixe o `.axbak` do sistema (botão de download na lista, ou direto do bucket R2).
3. No seu computador, dentro de `axionyx/backend` (com `npm install` e `npm run build` feitos):

```bash
DATABASE_URL="<DATABASE_PUBLIC_URL do banco novo>" \
BACKUP_ENCRYPTION_KEY="<a mesma chave do servidor que gerou o backup>" \
npm run restore-system -- caminho/para/arquivo.axbak
```

O comando cria as tabelas (migrações), confere que o banco está vazio, grava tudo numa única transação (se falhar, nada fica pela metade) e ajusta as sequências.

4. Aponte o `DATABASE_URL` do serviço `axionyx` para o banco novo (`${{postgres-restaurado.DATABASE_URL}}`) e faça redeploy.
5. Todos precisam entrar de novo (as sessões não fazem parte do backup).

**Teste a restauração uma vez por mês** num banco separado: backup que nunca foi restaurado não é garantia.

## O que não entra no backup

Sessões de login, tokens de convite, filas de envio, índices de leitura dos documentos (são refeitos sozinhos) e o próprio histórico de backups. Os backups de empresa também não levam usuários nem configurações da plataforma (planos, chaves de IA, e-mail). Esses ficam no backup do sistema inteiro.

## Backup do Railway

Continue com o backup nativo do Postgres no Railway (Postgres › Backups) como segunda camada. O backup do AXIONYX acrescenta: cópia **por empresa**, restauração seletiva, cifragem própria e armazenamento fora do Railway.
