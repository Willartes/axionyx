# Referência Java da Previsão de Demanda

`GoldenGen.java` executa o código **original** do AXIONYX ERP (JavaFX), pacote `com.axionyx.erp.forecast`
(`method/*`, `model/ResultadoForecast`, `service/ForecastService`), sem nenhuma alteração, e grava
`src/test/fixtures/previsao-java.json`. O teste `src/test/previsao.test.ts` compara o motor TypeScript com esse arquivo.

Para gerar de novo (precisa de JDK 17+ e do commons-math 3.6.1):

```bash
# 1. copie forecast/method, forecast/model (ResultadoForecast.java) e forecast/service/ForecastService.java
#    do projeto JavaFX para src/com/axionyx/erp/forecast/...
# 2. compile e rode
javac -cp commons-math3-3.6.1.jar -d out $(find src -name "*.java") GoldenGen.java
java -cp out:commons-math3-3.6.1.jar GoldenGen > ../../src/test/fixtures/previsao-java.json
```
