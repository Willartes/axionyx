import { unprocessable } from './errors'

/** Validador de esquema leve (sem dependências). Retorna o valor saneado ou lança 422 com os erros por campo. */
export type Issue = { path: string; message: string }
export interface Schema<T> { parse(v: unknown, path: string, issues: Issue[]): T | undefined; optional(): Schema<T | undefined>; nullable(): Schema<T | null>; default(d: T): Schema<T> }

function base<T>(fn: (v: unknown, path: string, issues: Issue[]) => T | undefined): Schema<T> {
  const s: Schema<T> = {
    parse: (v, p, i) => {
      if (v === undefined || v === null || v === '') { i.push({ path: p, message: 'Campo obrigatório.' }); return undefined }
      return fn(v, p, i)
    },
    optional: () => wrapOpt(s, undefined) as Schema<T | undefined>,
    nullable: () => wrapOpt(s, null) as Schema<T | null>,
    default: (d: T) => wrapOpt(s, d) as Schema<T>,
  }
  return s
}
function wrapOpt<T>(inner: Schema<T>, empty: any): Schema<any> {
  const s: Schema<any> = {
    parse: (v, p, i) => (v === undefined || v === null || v === '' ? empty : inner.parse(v, p, i)),
    optional: () => s, nullable: () => wrapOpt(inner, null), default: (d) => wrapOpt(inner, d),
  }
  return s
}

interface StrOpts { min?: number; max?: number; pattern?: RegExp; patternMsg?: string; trim?: boolean; lower?: boolean }
interface NumOpts { min?: number; max?: number; int?: boolean }

export const v = {
  string: (o: StrOpts = {}) => base<string>((x, p, i) => {
    if (typeof x !== 'string' && typeof x !== 'number') { i.push({ path: p, message: 'Deve ser um texto.' }); return undefined }
    let s = String(x); if (o.trim !== false) s = s.trim(); if (o.lower) s = s.toLowerCase()
    if (o.min !== undefined && s.length < o.min) i.push({ path: p, message: `Mínimo de ${o.min} caractere(s).` })
    if (o.max !== undefined && s.length > o.max) i.push({ path: p, message: `Máximo de ${o.max} caracteres.` })
    if (o.pattern && !o.pattern.test(s)) i.push({ path: p, message: o.patternMsg || 'Formato inválido.' })
    return s
  }),
  email: () => v.string({ max: 200, lower: true, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternMsg: 'E-mail inválido.' }),
  number: (o: NumOpts = {}) => base<number>((x, p, i) => {
    const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x.replace(',', '.')) : NaN
    if (!Number.isFinite(n)) { i.push({ path: p, message: 'Deve ser um número.' }); return undefined }
    if (o.int && !Number.isInteger(n)) i.push({ path: p, message: 'Deve ser um número inteiro.' })
    if (o.min !== undefined && n < o.min) i.push({ path: p, message: `Deve ser no mínimo ${o.min}.` })
    if (o.max !== undefined && n > o.max) i.push({ path: p, message: `Deve ser no máximo ${o.max}.` })
    return n
  }),
  int: (o: Omit<NumOpts, 'int'> = {}) => v.number({ ...o, int: true }),
  money: (o: Omit<NumOpts, 'int'> = {}) => base<number>((x, p, i) => {
    const n = v.number(o).parse(x, p, i); return n === undefined ? undefined : Math.round(n * 100) / 100
  }),
  boolean: () => base<boolean>((x, p, i) => {
    if (typeof x === 'boolean') return x
    if (x === 'true' || x === 1 || x === '1') return true
    if (x === 'false' || x === 0 || x === '0') return false
    i.push({ path: p, message: 'Deve ser verdadeiro ou falso.' }); return undefined
  }),
  uuid: () => v.string({ pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, patternMsg: 'Identificador inválido.' }),
  date: () => base<string>((x, p, i) => {
    const s = String(x).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s + 'T00:00:00Z'))) { i.push({ path: p, message: 'Data inválida (use AAAA-MM-DD).' }); return undefined }
    return s
  }),
  enum: <E extends string>(vals: readonly E[]) => base<E>((x, p, i) => {
    if (!vals.includes(x as E)) { i.push({ path: p, message: `Valor inválido. Use: ${vals.join(', ')}.` }); return undefined }
    return x as E
  }),
  array: <T>(item: Schema<T>, o: { min?: number; max?: number } = {}) => base<T[]>((x, p, i) => {
    if (!Array.isArray(x)) { i.push({ path: p, message: 'Deve ser uma lista.' }); return undefined }
    if (o.min !== undefined && x.length < o.min) i.push({ path: p, message: `Informe pelo menos ${o.min} item(ns).` })
    if (o.max !== undefined && x.length > o.max) i.push({ path: p, message: `Máximo de ${o.max} itens.` })
    return x.map((e, k) => item.parse(e, `${p}[${k}]`, i) as T)
  }),
  object: <S extends Record<string, Schema<any>>>(shape: S) => base<{ [K in keyof S]: Out<S[K]> }>((x, p, i) => {
    if (typeof x !== 'object' || Array.isArray(x)) { i.push({ path: p, message: 'Deve ser um objeto.' }); return undefined }
    const out: any = {}
    for (const k of Object.keys(shape)) {
      const val = shape[k].parse((x as any)[k], p ? `${p}.${k}` : k, i)
      if (val !== undefined) out[k] = val
    }
    return out
  }),
  /** JSON livre (objeto) — use apenas para campos de configuração/preferências. */
  json: () => base<Record<string, any>>((x, p, i) => {
    if (typeof x !== 'object' || Array.isArray(x)) { i.push({ path: p, message: 'Deve ser um objeto.' }); return undefined }
    return x as Record<string, any>
  }),
  any: () => base<any>((x) => x),
}
export type Out<S> = S extends Schema<infer T> ? T : never

export function parse<T>(schema: Schema<T>, value: unknown): T {
  const issues: Issue[] = []
  const out = schema.parse(value ?? {}, '', issues)
  if (issues.length) throw unprocessable('Verifique os campos destacados.', issues)
  return out as T
}

// ---------- Documentos brasileiros ----------
export const onlyDigits = (s: string | null | undefined) => (s || '').replace(/\D/g, '')

export function isValidCPF(cpf: string): boolean {
  const d = onlyDigits(cpf)
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false
  for (let t = 9; t < 11; t++) {
    let s = 0
    for (let k = 0; k < t; k++) s += Number(d[k]) * (t + 1 - k)
    const dv = ((s * 10) % 11) % 10
    if (dv !== Number(d[t])) return false
  }
  return true
}
export function isValidCNPJ(cnpj: string): boolean {
  const d = onlyDigits(cnpj)
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    const s = w.reduce((a, wi, k) => a + Number(d[k]) * wi, 0)
    const r = s % 11
    return r < 2 ? 0 : 11 - r
  }
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13])
}
export function isValidDoc(doc: string): boolean {
  const d = onlyDigits(doc)
  return d.length === 11 ? isValidCPF(d) : d.length === 14 ? isValidCNPJ(d) : false
}
/** Valida EAN-8/EAN-13/GTIN-14 pelo dígito verificador. */
export function isValidGTIN(code: string): boolean {
  const d = onlyDigits(code)
  if (![8, 12, 13, 14].includes(d.length) || d.length !== code.length) return false
  const digits = d.split('').map(Number)
  const check = digits.pop()!
  const sum = digits.reverse().reduce((a, n, k) => a + n * (k % 2 === 0 ? 3 : 1), 0)
  return (10 - (sum % 10)) % 10 === check
}
export function gtinCheckDigit(body: string): number {
  const digits = body.split('').map(Number).reverse()
  const sum = digits.reduce((a, n, k) => a + n * (k % 2 === 0 ? 3 : 1), 0)
  return (10 - (sum % 10)) % 10
}
