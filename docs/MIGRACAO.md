# Central de Migração (versão 1.15)

Traz os dados do ERP anterior de um cliente novo para o AXIONYX. Exclusivo da **equipe da plataforma** com a permissão **"Migração de dados"** (Minha Carteira › Equipe da Plataforma; o modelo **Implantação** já inclui migração, backup e acesso às empresas).

## Fluxo

1. **Arquivo**: escolha a empresa, o tipo e envie a planilha (CSV ou Excel .xlsx) ou o .zip de XMLs.
2. **Colunas**: o sistema reconhece sozinho os nomes mais comuns ("Razão Social", "CPF/CNPJ", "Cód. Barras", "Preço de Venda", "Vencimento"…). Ajuste o que faltar, use **Sugerir com IA** ou aplique um **perfil salvo** (ex.: "ERP X", para o próximo cliente que vier do mesmo sistema).
3. **Prévia**: mostra quantas linhas entram, quantas já existem e quantas têm erro, linha a linha. **Nada é gravado nesta etapa.** O relatório de erros pode ser baixado em CSV para o cliente corrigir.
4. **Importar**: tudo numa única transação: ou entra o lote inteiro, ou nada. Com linhas erradas, só importa se você marcar "Importar só as linhas válidas".
5. **Desfazer**: até 7 dias depois, no histórico. Remove o que a importação criou e ainda não foi usado. Produtos já vendidos ou movimentados e títulos já pagos são mantidos, para não quebrar o histórico.

## Ordem recomendada

**Fornecedores → Clientes → Produtos → Saldo de estoque → Contas a receber → Contas a pagar**, e por último o **XML de NF-e** (histórico).

## Tipos e regras

| Tipo | Obrigatório | Regras principais |
|---|---|---|
| Clientes | Nome | CPF/CNPJ validado (dígito verificador). Documento já cadastrado = mantido como está. Repetido na planilha = erro. |
| Fornecedores | Nome | Idem, pelo CNPJ. |
| Produtos | Código e descrição | Uma linha por produto ou por variação (mesmo código + cor/tamanho). Marca, grupo, cor e tamanho são criados se não existirem. Código de barras inválido ou já usado → o sistema gera um interno. NCM só com 8 dígitos. Código já cadastrado = mantido. |
| Saldo de estoque | Produto e quantidade | Produto pelo código de barras, SKU ou código. O sistema lança um **ajuste** até chegar no saldo informado (movimento "Saldo inicial (migração)"). Produto por unidade exige quantidade inteira. |
| Contas a receber | Cliente, vencimento e valor | Cliente pelo CPF/CNPJ ou nome único; se não existir, é cadastrado. Forma: crediário, boleto, cartão, a prazo. |
| Contas a pagar | Documento, vencimento e valor | Categoria pelo nome (se não achar: Serviços). Fornecedor pelo CNPJ ou nome; se não existir, é cadastrado. |

Valores aceitam `1.234,56`, `1234.56` e `R$`; datas aceitam `dd/mm/aaaa`, `aaaa-mm-dd` e datas do Excel. Limite de 20.000 linhas por arquivo (divida os maiores).

## XML de NF-e (histórico de vendas)

Peça ao contador (ou exporte do ERP antigo) um **.zip com os XMLs** das notas emitidas e recebidas, de preferência dos últimos 12 a 24 meses.

- **Notas emitidas pela empresa** (CNPJ da empresa ou das filiais) viram **histórico de vendas** com a data original, os clientes identificados na nota e os produtos (catálogo montado pelo código e EAN do item).
- **Notas recebidas** (compras) cadastram os **fornecedores** e preenchem o **custo** dos produtos com o mesmo código de barras, quando o custo estiver vazio.
- **Canceladas** (evento de cancelamento ou protocolo de cancelamento) e **repetidas/já importadas** (mesma chave de acesso) são ignoradas.
- O histórico **não mexe em estoque, caixa nem contas a receber**: serve para relatórios, curva ABC, previsão de demanda, diagnóstico do lucro e o histórico do cliente.
- O CNPJ da empresa precisa estar cadastrado: é por ele que o sistema separa vendas de compras.

## Privacidade da sugestão por IA

**Sugerir com IA** usa o provedor configurado em Minha Carteira › Inteligência Artificial. Vão ao provedor **só os nomes das colunas e o formato** de três valores de exemplo (letras viram `a`, dígitos viram `9`; ex.: `999.999.999-99`). Nenhum nome, documento ou valor do cliente sai do sistema. A sugestão sempre passa pela sua conferência antes da prévia.

## Auditoria

Envio, importação e desfazer ficam no log de auditoria da empresa (quem fez, quando, qual arquivo).
