# Operação — instalação, backup e atualização

## Requisitos
- Node.js 22.22.3+ ou 24.15+ (exigência do Angular 22; testado com 22) e npm 10+
- PostgreSQL 14+ (testado com 16)

## Banco de dados
```sql
CREATE ROLE axionyx LOGIN PASSWORD 'troque-esta-senha';
CREATE DATABASE axionyx OWNER axionyx;
-- opcional, para os testes automatizados:
CREATE DATABASE axionyx_test OWNER axionyx;
```
As migrações (`backend/migrations/*.sql`) são aplicadas automaticamente ao iniciar a API (ou com `npm run migrate`), cada uma em transação e registradas em `schema_migrations`.

## Primeira carga
```bash
cd backend && cp .env.example .env    # preencha DATABASE_URL e JWT_SECRET
npm install && npm run build
ADMIN_EMAIL=voce@empresa.com.br COMPANY_NAME="Sua Loja Ltda" npm run seed   # COMPANY_CNPJ é opcional (validado)
# a senha gerada é exibida uma única vez (ou defina ADMIN_PASSWORD)
```
Empresa de demonstração (dados fictícios, marcada como DEMONSTRAÇÃO em toda a interface):
```bash
DEMO_PASSWORD='Uma-Senha-Forte-123' npm run seed:demo
```

## Produção (um único processo servindo API + frontend)
```bash
cd frontend && npm install && npm run build          # gera frontend/dist/axionyx/browser
cd ../backend && STATIC_DIR=../frontend/dist/axionyx/browser NODE_ENV=production npm start
```
Coloque um proxy reverso com HTTPS (nginx, Caddy, balanceador da nuvem) na frente da porta `PORT`. Ajuste `CORS_ORIGIN` se o frontend for servido em outro domínio.
Com Docker: `docker compose up -d --build` (veja `docker-compose.yml`; troque as senhas antes).

## Backup
Diário, com retenção e teste de restauração periódico:
```bash
pg_dump --format=custom --file=axionyx-$(date +%F).dump "$DATABASE_URL"
# restauração (em banco vazio ou de homologação):
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" axionyx-AAAA-MM-DD.dump
```
A tela **Plataforma › Backup** exporta os dados da empresa em JSON (portabilidade/conferência); não substitui o `pg_dump`.

## Atualização
1. faça backup; 2. publique o novo código; 3. `npm install && npm run build` (backend e frontend); 4. reinicie a API — migrações novas são aplicadas na inicialização.

## Segurança operacional
- `JWT_SECRET` com 48+ bytes aleatórios; troque-o para invalidar todas as sessões.
- Nunca versione `.env`. Credenciais de integração apenas em variáveis de ambiente/secret manager.
- Ative MFA para administradores (Configurações › Segurança).
- Monitoramento: **Plataforma › Monitoramento** (latência do banco, erros 5xx, fila de integrações, memória). Logs da API vão para stdout.
- Trilha de auditoria (somente inclusão): **Core › Auditoria**.
