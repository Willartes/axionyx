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

## Acesso pela página de apresentação (sem subdomínio)
Não é preciso criar `demo.axionyxerp.com.br`:
1. No serviço `axionyx-demo`, abra Settings › Networking › **Generate Domain**. O Railway cria um endereço `...up.railway.app` gratuito, que não conta no limite de domínios.
2. No serviço de **produção**, crie a variável `DEMO_URL` com esse endereço (exemplo: `https://axionyx-demo-production.up.railway.app`).
3. Pronto:
   - **`www.axionyxerp.com.br/demo`** leva direto à demonstração. Esse atalho não aparece em nenhum menu, então você manda por WhatsApp ou e-mail só para quem quiser.
   - No rodapé da página de apresentação, o **ponto "·" no canto direito da última linha do rodapé** é um link discreto para a demonstração.
   - Com `DEMO_PUBLIC_LOGIN=true` no serviço de demonstração, o visitante entra direto, sem digitar a senha. Sem essa variável, ele cai na tela de login da demonstração.

## Uso
- Em `https://demo.axionyxerp.com.br`, entre com a conta de demonstração e escolha a empresa do segmento do cliente.
- Antes de cada apresentação, se quiser tudo "zerado", clique em **Restaurar demonstração**. Em 1 a 3 minutos, entre de novo.
