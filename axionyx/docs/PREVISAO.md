# Previsão de Demanda (versão 1.17)

Tela **Inteligência › Previsão de Demanda**. Mesmos algoritmos e mesma lógica da Previsão de Demanda do AXIONYX ERP
(JavaFX), portados para o servidor e conferidos número a número contra o código Java original.

## Métodos

| Método | Parâmetros (iguais ao original) | Observação |
|---|---|---|
| Naive | último valor | base de comparação obrigatória |
| Média móvel | 3 períodos | |
| Suavização exponencial simples | α = 0,3 | |
| Regressão linear | mínimos quadrados sobre o índice do período | previsão nunca negativa |
| ARIMA(1,1,1) | Hannan-Rissanen (AR por mínimos quadrados, MA sobre os resíduos), QR de Householder como no commons-math | resíduos futuros = 0 |
| **Rede neural MLP** | janela 3, 5 neurônios ocultos, 300 épocas, taxa 0,1, semente 42, sigmoide, backpropagation, normalização mín-máx | pesos iniciais idênticos aos do Java (mesmo gerador `java.util.Random`) |

ARIMA e rede neural precisam de um mínimo de histórico (6 períodos de treino); abaixo disso usam o Naive e a tabela
mostra a indicação, como no original.

## Como o método é escolhido

1. **Holdout cronológico 80/20**: o treino são os primeiros 80% (arredondado para baixo) dos períodos; o teste, os 20%
   finais. Nunca há sorteio de períodos.
2. Cada método é ajustado só no treino e prevê o teste em **rodadas do tamanho do horizonte**, sem retreinar; no início
   de cada rodada a janela usa valores reais já observados.
3. O recomendado é o de **menor RMSE + MAPE** no teste (MAPE indefinido vale 999; empate: o primeiro da lista).
4. A previsão exibida é o **mesmo método** ajustado com a série inteira.
5. Confiança: alta com 24 períodos ou mais, média com 12 a 23, baixa abaixo de 12.

Métricas: MAE, RMSE, MAPE, sMAPE, viés (média de real − previsto) e R², calculadas como no original (sMAPE e R² só
para Naive, ARIMA e rede neural).

## Semanal ou mensal

- **Padrão da empresa**: Configurações › Previsão de demanda (período e horizonte sugerido). Na tela o usuário alterna.
- **Semanal**: até 104 semanas de histórico; horizontes 1, 2, 3, 4, 6, 8 ou 12 semanas.
- **Mensal**: até 36 meses; horizontes 1, 2, 3, 6 ou 12 meses.

## A série (diferenças deliberadas em relação ao original)

Os algoritmos são idênticos; a **série** foi corrigida para não distorcer produtos que não vendem todo período:

| Original (JavaFX) | AXIONYX web |
|---|---|
| Semana sem venda some da série | Período sem venda entra como **zero** |
| Pedidos cancelados contam | Vendas **canceladas ficam de fora** |
| Devoluções não são descontadas | Quantidade e valor **líquidos de devolução** |
| — | Faturamento **líquido de descontos**, sem frete |
| Semana atual incompleta entra no treino | Período em andamento fica fora do treino (é o 1º ponto da previsão) |
| — | Se a empresa começou a usar o sistema no meio de um período, esse período incompleto fica fora |
| Só semanal | Semanal ou mensal |

Fuso: o de Configurações › Agenda (padrão Brasília). Filtro por produto (todas as variações) ou faturamento total.

## Avisos da tela

- **Histórico curto** (menos de 10 períodos): o teste tem poucos pontos e a recomendação pode mudar.
- **Demanda intermitente** (30% ou mais dos períodos sem venda): os métodos clássicos tendem a errar mais.

## Conferência com o Java

`src/test/previsao.test.ts` compara 7 séries × 4 horizontes (28 casos) com resultados gerados pelo código Java original
(`tools/previsao-referencia`): método recomendado igual em todos; Naive, média móvel, suavização, regressão e ARIMA
idênticos; rede neural com diferença máxima na 15ª casa decimal (função exponencial do Java × JavaScript).

## Próximos passos previstos

Análise multicritério do original (mais 12 modelos, diagnóstico da série e score ponderado) e uso da previsão
recomendada no Estoque Inteligente e na AXIA.
