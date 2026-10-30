# Inteligência Artificial da AXIA (versão 1.13)

A AXIA tem dois motores:

| Motor | O que faz | Dados saem do servidor? |
|---|---|---|
| **Regras** (padrão, sempre disponível) | Respostas calculadas dentro do AXIONYX: vendas, estoque, títulos, alertas, pré-diagnóstico do lucro | Não |
| **IA generativa** (opcional) | Conversa, interpreta, consulta o sistema por ferramentas e lê os documentos da empresa; modo "Consulta jurídica" | Sim, o necessário para cada pergunta, ao provedor escolhido |

Cada usuário escolhe o motor no topo da AXIA (**Regras | IA**). Se a IA não estiver disponível (não liberada, limite do mês, chave recusada), a resposta vem pelo motor de regras com um aviso.

## 1. Plataforma (Minha Carteira › Inteligência Artificial)
Acesso: equipe da plataforma com a permissão "Planos e Mercado Pago".

1. **Chaves**: cole a chave de cada provedor que quiser ter disponível e clique em **Salvar**.
   - Anthropic (Claude): console.anthropic.com · OpenAI (ChatGPT): platform.openai.com · Google (Gemini): aistudio.google.com
   - As chaves ficam **cifradas** no banco (AES-256-GCM) e nunca voltam para o navegador; o painel mostra só os 4 últimos caracteres.
   - Alternativa: variáveis de ambiente no Railway (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`). Se existirem, têm prioridade sobre a chave do painel.
2. **Modelo**: clique em **Carregar modelos** para ver os modelos que a sua chave pode usar e escolha um. **Testar conexão** faz uma pergunta curta de verdade ao provedor.
3. **Oferecer às empresas**: escolha UM provedor. É ele que todas as empresas vão usar.
4. **Quais empresas podem usar**: "Só as que eu liberar" (marque na tabela) ou "Todas".
5. **Limite mensal** de perguntas por empresa (padrão e por empresa). Defina também um limite de gasto no painel do provedor.

### Chave mestra (recomendado)
Crie no Railway a variável `ENCRYPTION_KEY` com um texto aleatório longo (ex.: `openssl rand -hex 32`) **antes** de cadastrar as chaves.
Sem ela, a chave mestra é derivada do `JWT_SECRET`; se o `JWT_SECRET` for trocado, as chaves precisam ser digitadas de novo (o painel avisa).

## 2. Empresa (Administração › Inteligência Artificial)
Acesso: perfil com "Alterar configurações".

1. Leia o termo e clique em **Ativar IA generativa** (fica registrado quem aceitou e quando).
2. **Documentos**: permita ou não que a IA consulte os documentos; bloqueie pastas (ex.: RH) com um clique.
3. **Ler documentos pendentes**: lê os documentos enviados antes desta versão. Os novos são lidos automaticamente no envio.
4. Acompanhe o uso do mês e as últimas perguntas (a pergunta fica registrada; a resposta não).

## 3. O que a IA consegue consultar
Sempre com a empresa e as permissões de quem pergunta (as mesmas das telas):
resumo de vendas, pré-diagnóstico do lucro, DRE, contas a pagar e a receber, estoque (mínimo, ruptura, parado), mais vendidos, alertas, processos do Jurídico e os documentos (busca com página e leitura).

**Nunca** consulta: prontuário e documentos clínicos, salários, CPF/telefone/endereço de clientes. Nenhuma ferramenta altera dados.

Documentos lidos: PDF com texto, Word (.docx), Excel (.xlsx), CSV, XML (inclui NF-e) e texto. PDF escaneado e imagens ainda não (OCR fica para uma próxima versão). Em clínicas, documentos de pacientes e pastas como "Exames", "Prontuário" e "Laudos" nunca são lidos.

## 4. Consulta jurídica
Na AXIA, com o motor **IA**, ative **Consulta jurídica**. A resposta segue: resposta curta → fundamento (cláusula, documento e página; lei citada com aviso de conferir a vigência) → riscos → quando acionar o jurídico.
Casos de risco (prazo processual, notificação, demissão, autuação, valores altos, documentos insuficientes) começam com "⚠️ Recomendo encaminhar ao jurídico".
O botão **Encaminhar ao jurídico** cria uma consulta em **Intelligence › Consultas ao Jurídico** com a pergunta, a pré-análise e os documentos usados. Quem tem acesso ao Jurídico responde; quem perguntou acompanha a resposta.

É uma **pré-análise automática**: não substitui o advogado.

## 5. Privacidade (LGPD)
- A empresa é a controladora; o AXIONYX é operador; o provedor de IA atua como suboperador e processa os dados fora do Brasil.
- Atualize os termos de uso e a política de privacidade para informar esse tratamento e a transferência internacional.
- Os provedores têm regras próprias de retenção e de uso por API (por exemplo, a Anthropic não treina modelos com dados enviados pela API e mantém os dados por 30 dias no padrão). Confira os termos de cada um antes de oferecer.
- No ambiente de demonstração a IA generativa fica sempre desligada.
