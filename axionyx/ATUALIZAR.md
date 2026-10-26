# Como atualizar o repositório no GitHub com uma nova versão

Use sempre a pasta clonada do GitHub (ex.: `~/Downloads/axionyx-repo`, que contém a pasta `axionyx/`).

```bash
cd ~/Downloads/axionyx-repo
git pull                                            # traz o que já está no GitHub
unzip -o ~/Downloads/axionyx-erp-v1.6.0.zip          # substitui os arquivos alterados (seu .env não vai no zip)
git status                                          # confira: nenhum arquivo .env pode aparecer
git add -A
git commit -m "AXIONYX 1.6.0: carteira de clientes e cobranca Mercado Pago"
git push origin main
```

O Railway faz o deploy sozinho após o `push`. As migrações novas (`backend/migrations/007..011`) são aplicadas automaticamente quando a API inicia; elas só **acrescentam** tabelas/colunas e ampliam tipos — nenhum dado cadastrado é apagado ou alterado.

**Recomendado antes do push:** faça um backup do banco do Railway (Postgres › Backups › Create backup) — boa prática a cada atualização.

## Novidades da versão 1.5
- Segmentos Odontologia, Clínica de estética e Salão de beleza e estética: agenda por profissional, serviços e pacotes de sessões, comissão por profissional, prontuário/fichas com consentimento e acesso auditado, odontograma, planos de tratamento e Inteligência de Serviços.
- Gerente/dono pode ser também profissional (“Eu também atendo”).
- Nova marca (símbolo de rede conectada) em todo o sistema e no site.
- Migração `011_servicos.sql`: só acrescenta tabelas e colunas (empresas existentes continuam no segmento atual; para usar os novos recursos, aplique o segmento em Administração › Módulos › Aplicar outro segmento ou cadastre uma nova empresa).

## Novidades da versão 1.4
- Segmento Mercadinho e conveniência (preço por quantidade/atacarejo, fardos, peso, validade, combos, maioridade).
- Segmento Cosméticos e perfumaria (tonalidade/volume, atributos, ANVISA, lote/validade, testers, kits, revendedoras).

## Novidades da versão 1.3
- Site institucional em `/` com link **Axionyx** (canto superior direito) para o sistema e formulário de demonstração.
- Segmentos de negócio: Moda (convertida, sem perder nada), Hortifrúti/Quitanda, Adega/Bebidas e Varejo geral.
- Venda por peso, leitura de balança, etiqueta de balança, lotes e validade (FEFO), perdas, embalagens unidade/caixa, combos e controle de maioridade.

**1.5.2**: só frontend (responsividade) e número de versão — nenhuma migração nova, nenhum dado é tocado. Após o deploy, recarregue com Ctrl+Shift+R (no celular, feche e reabra a aba) para limpar o cache.

**1.6.0**: nova migração `012_assinaturas.sql`, aplicada sozinha ao iniciar a API. Ela só **cria tabelas novas** (planos, contratos, cobranças, fila de auditoria, notificações do gateway); nenhuma tabela existente é alterada e as empresas atuais continuam funcionando sem bloqueio. Depois do deploy, configure no Railway as variáveis `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` e `APP_PUBLIC_URL` (passo a passo na tela Minha Carteira › Mercado Pago e em `docs/INTEGRACOES.md`, seção 7).
