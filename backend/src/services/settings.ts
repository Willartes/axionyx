import { Q } from '../core/db'

export const DEFAULT_SETTINGS = {
  vendas: {
    permitirEstoqueNegativo: false,
    exigirCaixaAberto: true,
    validadeOrcamentoDias: 7,
  },
  crediario: {
    jurosMensalPct: 2,
    multaPct: 2,
    carenciaDias: 0,
    maxParcelas: 10,
    parcelaMinima: 30,
    exigirLimite: true,
  },
  fidelidade: {
    ativo: true,
    cashbackPct: 5,
    compraMinima: 0,
    validadeDias: 90,
    resgateMaxPct: 30,
    saldoMinimoResgate: 1,
    acumularNoCrediario: false,
  },
  trocas: {
    prazoDias: 30,
    validadeValeTrocaDias: 180,
  },
  fiscal: {
    ambiente: 'homologacao' as 'homologacao' | 'producao',
    emitirNfceAutomatico: false,
    serieNfce: 1,
    serieNfe: 1,
    aliquotaEstimadaPct: 6,
  },
  condicional: {
    prazoPadraoDias: 3,
    maxPecas: 40,
  },
  segmentos: {
    inativoDias: 90,
    posVendaDias: 7,
  },
  comissoes: {
    percentualPadrao: 3,
  },
  /** Etiqueta de balança (EAN-13 começando pelo prefixo): código do produto (PLU) + peso (g) ou preço total (centavos) */
  balanca: {
    prefixo: '2',
    digitosCodigo: 5,
    digitosValor: 5,
    tipoValor: 'preco' as 'preco' | 'peso',
    baudRate: 9600,
  },
  validade: {
    alertaDias: 3,
  },
  maioridade: {
    exigirConfirmacao: true,
    idadeMinima: 18,
  },
  /** Agenda de serviços (odontologia, estética, salão) */
  agenda: {
    intervaloMin: 30,
    antecedenciaLembreteHoras: 24,
    permitirForaDoExpediente: false,
    toleranciaFaltaMin: 15,
    fusoHorario: 'America/Sao_Paulo',
  },
}
export type Settings = typeof DEFAULT_SETTINGS

function deepMerge(base: any, over: any): any {
  if (!over || typeof over !== 'object') return base
  const out: any = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' ? deepMerge(base[k], v) : v
  }
  return out
}

export async function getSettings(c: Q, companyId: string): Promise<Settings> {
  const r = await c.one<{ settings: any }>('SELECT settings FROM companies WHERE id = $1', [companyId])
  return deepMerge(DEFAULT_SETTINGS, r?.settings || {})
}

/** Valida tipos/limites básicos de cada seção ao salvar. */
export function sanitizeSettings(input: any): Partial<Settings> {
  const out: any = {}
  for (const section of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (!input?.[section]) continue
    out[section] = {}
    for (const [k, def] of Object.entries(DEFAULT_SETTINGS[section])) {
      const val = input[section][k]
      if (val === undefined) continue
      if (typeof def === 'number') {
        const n = Number(val)
        if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error(`Valor inválido em ${section}.${k}`)
        out[section][k] = n
      } else if (typeof def === 'boolean') out[section][k] = Boolean(val)
      else if (k === 'tipoValor') {
        if (!['preco', 'peso'].includes(val)) throw new Error('Tipo de valor da etiqueta de balança inválido')
        out[section][k] = val
      } else if (k === 'prefixo') {
        if (!/^\d{1,2}$/.test(String(val))) throw new Error('Prefixo da etiqueta de balança deve ter 1 ou 2 dígitos')
        out[section][k] = String(val)
      } else if (k === 'fusoHorario') {
        if (!/^(America\/[A-Za-z_]+|UTC)$/.test(String(val))) throw new Error('Fuso horário inválido')
        out[section][k] = String(val)
      } else if (k === 'ambiente') {
        if (!['homologacao', 'producao'].includes(val)) throw new Error('Ambiente fiscal inválido')
        out[section][k] = val
      } else out[section][k] = String(val)
    }
  }
  return out
}
