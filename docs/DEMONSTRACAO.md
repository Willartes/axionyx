# Ambiente de demonstração (versão 1.11)

Um **segundo serviço** no Railway, com **banco de dados próprio**, roda o mesmo código do AXIONYX em modo demonstração.
Ele não compartilha nada com a produção: nem banco, nem usuários, nem integrações.

## O que ele tem
- **10 empresas fictícias**, uma por segmento: Moda, Hortifrúti, Adega, Mercadinho, Cosméticos, Odontologia, Estética, Salão, Clínica de saúde e Oficina.
  Cada uma vem com produtos, clientes, vendas dos últimos 45 a 180 dias, financeiro, agenda, prontuário de exemplo, convênio e OS, conforme o segmento.
  Todas são marcadas como demonstração: o nome leva "(demonstração)" e a faixa de demonstração aparece em todas as telas.
- **Uma conta de demonstração** (`DEMO_LOGIN_EMAIL` / `DEMO_LOGIN_PASSWORD`) com perfil Administrador em todas as empresas.
- **Restauração automática** todo dia às `DEMO_RESET_HOUR` (padrão 3h) e pelo botão **Restaurar demonstração** na faixa do topo.
  Tudo o que foi feito na apresentação é desfeito.

## Proteções
- **Nenhuma comunicação externa:** o servidor só conversa com ele mesmo. E-mail, WhatsApp, Mercado Pago, NF-e, e-commerce e consulta de CNPJ ficam desligados, mesmo que alguém configure as variáveis.
- **Conta de demonstração restrita:** não troca a própria senha, não ativa MFA, não cadastra usuários nem perfis, não altera empresas, configurações ou integrações, não exporta dados e não transmite nem cancela notas.
- **Proteção da produção:** com `DEMO_MODE=true`, o servidor **se recusa a iniciar** se o banco tiver qualquer empresa real. A restauração (que apaga e recria o banco) só roda num banco criado pelo próprio ambiente de demonstração. Ligar o modo por engano no serviço de produção não apaga nada.

## Passo a passo no Railway
1. No mesmo projeto, crie um **novo banco**: **+ New › Database › PostgreSQL** e dê o nome `demo-postgres`.
2. Crie um **novo serviço** a partir do mesmo repositório: **+ New › GitHub Repo › Willartes/axionyx**.
   - Em Settings › **Root Directory**, coloque `axionyx`, igual ao serviço principal.
   - Dê o nome `axionyx-demo`.
3. Em **Variables** do `axionyx-demo`:
   - `DATABASE_URL` = referência ao banco **demo-postgres**. Use "Add Reference › demo-postgres › DATABASE_URL". **Não use o banco da produção.**
   - `JWT_SECRET` = um texto **novo**, com 40 ou mais caracteres e diferente do da produção.
   - `DEMO_MODE` = `true`
   - `DEMO_LOGIN_EMAIL` = o e-mail que você vai usar nas apresentações (exemplo: `demo@axionyxerp.com.br`)
   - `DEMO_LOGIN_PASSWORD` = uma senha com 10 ou mais caracteres, letras e números
   - Opcional: `DEMO_PUBLIC_LOGIN` = `true` mostra o botão **"Entrar na demonstração"** na tela de login, com o e-mail e a senha já preenchidos. Use se quiser deixar a demonstração aberta. Sem essa variável, só quem sabe a senha entra.
   - Opcional: `DEMO_RESET_HOUR` = hora da restauração diária, de 0 a 23.
   - **Não** copie para este serviço as variáveis do Mercado Pago, do e-mail, do WhatsApp e afins. Mesmo que copie, elas são ignoradas.
4. Faça o deploy. Na primeira subida, o banco está vazio, e o sistema monta as 10 empresas sozinho em cerca de 1 a 3 minutos.
   O log mostra `[demo] ambiente montado`.
5. Para usar um endereço próprio:
   - em Settings › Networking › **Custom Domain**, adicione `demo.axionyxerp.com.br`;
   - no Cloudflare › DNS, crie o **CNAME** `demo` e o **TXT** de verificação que o Railway mostrar, em modo **DNS only**.

## Botão "Acessar a demonstração" na página de apresentação
Com o subdomínio `demo.axionyxerp.com.br` (passo 5) já funcionando:
1. No serviço de **produção**, crie a variável `DEMO_URL` = `https://demo.axionyxerp.com.br`.
2. A página de apresentação passa a mostrar **"Acessar a demonstração"** em quatro lugares: no topo, no início da página, no menu do celular e no rodapé. O botão leva a `https://demo.axionyxerp.com.br`.
3. Com `DEMO_PUBLIC_LOGIN=true` no serviço `axionyx-demo`, o visitante entra direto na escolha das 10 empresas, sem digitar a senha. Sem essa variável, ele vê a tela de login da demonstração.
4. Também funciona o atalho `www.axionyxerp.com.br/demo`, bom para mandar por WhatsApp ou e-mail.

Sem `DEMO_URL`, os botões não aparecem, e o site fica como antes.

> O plano Hobby do Railway permite 2 domínios próprios por serviço. O `demo.axionyxerp.com.br` fica no serviço **axionyx-demo**, que tem a sua própria contagem.

## Uso
- Em `https://demo.axionyxerp.com.br`, entre com a conta de demonstração e escolha a empresa do segmento do cliente.
- Antes de cada apresentação, se quiser tudo "zerado", clique em **Restaurar demonstração**. Em 1 a 3 minutos, entre de novo.

## Não consigo entrar na demonstração
- As variáveis `DEMO_MODE`, `DEMO_LOGIN_EMAIL` e `DEMO_LOGIN_PASSWORD` precisam estar no serviço **axionyx-demo**. No serviço de produção elas não fazem nada; lá vai só `DEMO_URL`.
- Entre pelo endereço da **demonstração** (`.../demo` ou `...up.railway.app`), não pela tela de login do site principal: a conta de demonstração só existe no banco da demonstração.
- Confira o log do `axionyx-demo`:
  - `[demo] conta de demonstração conferida`: a conta está ativa com o e-mail e a senha das variáveis;
  - `[demo] ambiente montado`: a demonstração foi (re)montada;
  - `defina DEMO_LOGIN_EMAIL e DEMO_LOGIN_PASSWORD`: faltam as variáveis, ou a senha tem menos de 10 caracteres.
- Trocou a senha na variável? Ela passa a valer no próximo deploy. Trocou o e-mail? A demonstração é montada de novo com o e-mail novo (cerca de 1 a 3 minutos).
