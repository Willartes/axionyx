import com.axionyx.erp.forecast.method.*;
import com.axionyx.erp.forecast.model.ResultadoForecast;
import com.axionyx.erp.forecast.service.ForecastService;
import java.util.*;

/** Gera resultados de referencia do codigo Java ORIGINAL (sem alteracao) para conferir o porte em TypeScript. */
public class GoldenGen {
    static String num(double v) { return Double.isNaN(v) ? "null" : Double.isInfinite(v) ? "null" : Double.toString(v); }
    static String arr(List<Double> l) { StringBuilder sb = new StringBuilder("["); for (int i = 0; i < l.size(); i++) { if (i > 0) sb.append(','); sb.append(num(l.get(i))); } return sb.append(']').toString(); }
    static String res(ResultadoForecast r) {
        return "{\"nome\":\"" + r.getNomeModelo().replace("\"", "'") + "\",\"ajuste\":" + arr(r.getAjusteHistorico()) + ",\"previsao\":" + arr(r.getPrevisao()) +
            ",\"mae\":" + num(r.getMae()) + ",\"rmse\":" + num(r.getRmse()) + ",\"mape\":" + num(r.getMape()) + ",\"bias\":" + num(r.getBias()) +
            ",\"smape\":" + num(r.getSmape()) + ",\"r2\":" + num(r.getR2()) + ",\"score\":" + num(r.getScore()) + "}";
    }
    public static void main(String[] a) {
        Map<String, List<Double>> series = new LinkedHashMap<>();
        Random g = new Random(7);
        List<Double> s1 = new ArrayList<>(); for (int i = 0; i < 104; i++) s1.add(Math.max(0, Math.round(20 + 0.15 * i + 6 * Math.sin(2 * Math.PI * i / 13.0) + g.nextGaussian() * 3) * 1.0));
        series.put("semanal_104_tendencia_sazonal", s1);
        List<Double> s2 = new ArrayList<>(); for (int i = 0; i < 60; i++) s2.add(g.nextDouble() < 0.55 ? 0.0 : (double) (1 + g.nextInt(4)));
        series.put("intermitente_60", s2);
        List<Double> s3 = new ArrayList<>(); for (int i = 0; i < 36; i++) s3.add((double) Math.round(300 + 4 * i + 60 * Math.sin(2 * Math.PI * i / 12.0) + g.nextGaussian() * 25));
        series.put("mensal_36", s3);
        series.put("curta_5", List.of(4.0, 7.0, 5.0, 9.0, 6.0));
        series.put("constante_20", Collections.nCopies(20, 8.0));
        List<Double> s6 = new ArrayList<>(); for (int i = 0; i < 30; i++) s6.add(i < 25 ? (double) (10 + i) : 0.0);
        series.put("queda_brusca_30", s6);
        List<Double> s7 = new ArrayList<>(); for (int i = 0; i < 12; i++) s7.add((double) (50 + (i % 3) * 10));
        series.put("mensal_12", s7);
        ForecastService fs = new ForecastService();
        StringBuilder out = new StringBuilder("{\"casos\":[");
        boolean first = true;
        for (var e : series.entrySet()) {
            for (int h : new int[]{1, 3, 6, 12}) {
                if (!first) out.append(','); first = false;
                List<Double> v = e.getValue();
                List<ResultadoForecast> ho = fs.compararModelosHoldout(v, 0.8, h);
                List<ResultadoForecast> pr = fs.compararModelos(v, h);
                ResultadoForecast best = fs.selecionarMelhor(ho);
                out.append("{\"serie\":\"").append(e.getKey()).append("\",\"valores\":").append(arr(v)).append(",\"horizonte\":").append(h)
                   .append(",\"melhor\":").append(ho.indexOf(best)).append(",\"holdout\":[");
                for (int i = 0; i < ho.size(); i++) { if (i > 0) out.append(','); out.append(res(ho.get(i))); }
                out.append("],\"producao\":[");
                for (int i = 0; i < pr.size(); i++) { if (i > 0) out.append(','); out.append(res(pr.get(i))); }
                out.append("]}");
            }
        }
        // Random do Java: primeiros valores com a semente 42 (para conferir o gerador portado)
        Random r = new Random(42); out.append("],\"random42\":[");
        for (int i = 0; i < 20; i++) { if (i > 0) out.append(','); out.append(num(r.nextDouble())); }
        out.append("]}");
        System.out.println(out);
    }
}
