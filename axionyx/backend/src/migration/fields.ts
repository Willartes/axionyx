import { isValidCPF, isValidCNPJ, onlyDigits } from '../core/validate'

/**
 * Campos de cada tipo de importação, com os nomes de coluna mais comuns nas exportações dos ERPs do mercado
 * (ex.: Bling, Tiny/Olist, Omie, Conta Azul e planilhas próprias). O reconhecimento é por semelhança de nome;
 * quem importa sempre pode ajustar, e o mapeamento pode ser salvo para reutilizar.
 */
export type Kind = 'clientes' | 'fornecedores' | 'produtos' | 'estoque' | 'receber' | 'pagar'
export interface Field { key: string; label: string; required?: boolean; type?: 'texto' | 'doc' | 'valor' | 'numero' | 'data' | 'ean' | 'ncm' | 'uf' | 'cep' | 'telefone' | 'email'; syn: string[] }

const ADDR: Field[] = [
  { key: 'cep', label: 'CEP', type: 'cep', syn: ['cep', 'codigo postal'] },
  { key: 'logradouro', label: 'Endereço', syn: ['endereco', 'logradouro', 'rua', 'endereco completo'] },
  { key: 'numero', label: 'Número', syn: ['numero', 'nro', 'num', 'n'] },
  { key: 'complemento', label: 'Complemento', syn: ['complemento', 'compl'] },
  { key: 'bairro', label: 'Bairro', syn: ['bairro'] },
  { key: 'cidade', label: 'Cidade', syn: ['cidade', 'municipio'] },
  { key: 'uf', label: 'UF', type: 'uf', syn: ['uf', 'estado'] },
]
export const FIELDS: Record<Kind, Field[]> = {
  clientes: [
    { key: 'nome', label: 'Nome / razão social', required: true, syn: ['nome', 'razao social', 'nome razao social', 'cliente', 'nome do cliente', 'nome completo', 'contato'] },
    { key: 'fantasia', label: 'Nome fantasia', syn: ['fantasia', 'nome fantasia', 'apelido'] },
    { key: 'cpf_cnpj', label: 'CPF/CNPJ', type: 'doc', syn: ['cpf cnpj', 'cpf', 'cnpj', 'documento', 'cnpj cpf', 'cpf ou cnpj', 'cpfcnpj'] },
    { key: 'ie', label: 'Inscrição estadual', syn: ['ie', 'inscricao estadual', 'ie rg', 'rg ie'] },
    { key: 'email', label: 'E-mail', type: 'email', syn: ['email', 'e mail', 'email principal'] },
    { key: 'telefone', label: 'Telefone', type: 'telefone', syn: ['telefone', 'fone', 'tel', 'telefone principal', 'telefone 1'] },
    { key: 'whatsapp', label: 'Celular / WhatsApp', type: 'telefone', syn: ['celular', 'whatsapp', 'whats', 'telefone celular', 'telefone 2'] },
    { key: 'nascimento', label: 'Data de nascimento', type: 'data', syn: ['nascimento', 'data de nascimento', 'aniversario', 'data nascimento'] },
    ...ADDR,
    { key: 'limite', label: 'Limite de crédito', type: 'valor', syn: ['limite', 'limite de credito', 'limite credito'] },
    { key: 'observacoes', label: 'Observações', syn: ['observacoes', 'obs', 'observacao', 'notas'] },
  ],
  fornecedores: [
    { key: 'nome', label: 'Razão social', required: true, syn: ['razao social', 'nome', 'fornecedor', 'nome razao social', 'nome do fornecedor'] },
    { key: 'fantasia', label: 'Nome fantasia', syn: ['fantasia', 'nome fantasia'] },
    { key: 'cnpj', label: 'CNPJ/CPF', type: 'doc', syn: ['cnpj', 'cpf cnpj', 'cnpj cpf', 'documento'] },
    { key: 'ie', label: 'Inscrição estadual', syn: ['ie', 'inscricao estadual'] },
    { key: 'email', label: 'E-mail', type: 'email', syn: ['email', 'e mail'] },
    { key: 'telefone', label: 'Telefone', type: 'telefone', syn: ['telefone', 'fone', 'tel', 'celular'] },
    ...ADDR,
  ],
  produtos: [
    { key: 'codigo', label: 'Código', required: true, syn: ['codigo', 'cod', 'codigo do produto', 'sku', 'referencia', 'ref', 'codigo interno', 'cod produto'] },
    { key: 'nome', label: 'Descrição / nome', required: true, syn: ['descricao', 'nome', 'produto', 'descricao do produto', 'nome do produto', 'descricao completa'] },
    { key: 'ean', label: 'Código de barras (GTIN/EAN)', type: 'ean', syn: ['gtin', 'ean', 'codigo de barras', 'gtin ean', 'cod barras', 'codigo barras', 'ean13'] },
    { key: 'ncm', label: 'NCM', type: 'ncm', syn: ['ncm', 'classificacao fiscal', 'codigo ncm'] },
    { key: 'cest', label: 'CEST', syn: ['cest'] },
    { key: 'unidade', label: 'Unidade', syn: ['unidade', 'un', 'und', 'unidade de medida', 'unid'] },
    { key: 'preco', label: 'Preço de venda', type: 'valor', syn: ['preco', 'preco de venda', 'valor', 'preco venda', 'valor de venda', 'preco unitario', 'vl venda'] },
    { key: 'custo', label: 'Preço de custo', type: 'valor', syn: ['custo', 'preco de custo', 'preco custo', 'valor de custo', 'custo medio', 'vl custo'] },
    { key: 'marca', label: 'Marca', syn: ['marca', 'fabricante'] },
    { key: 'categoria', label: 'Categoria', syn: ['categoria', 'grupo', 'departamento', 'familia', 'categoria do produto'] },
    { key: 'minimo', label: 'Estoque mínimo', type: 'numero', syn: ['estoque minimo', 'minimo', 'est minimo'] },
    { key: 'cor', label: 'Cor (variação)', syn: ['cor'] },
    { key: 'tamanho', label: 'Tamanho (variação)', syn: ['tamanho', 'tam', 'numeracao'] },
    { key: 'descricao', label: 'Descrição longa', syn: ['descricao longa', 'descricao complementar', 'detalhes'] },
  ],
  estoque: [
    { key: 'produto', label: 'Código, SKU ou código de barras', required: true, syn: ['codigo', 'sku', 'gtin', 'ean', 'codigo de barras', 'cod', 'referencia', 'produto'] },
    { key: 'quantidade', label: 'Quantidade em estoque', required: true, type: 'numero', syn: ['estoque', 'quantidade', 'qtd', 'saldo', 'estoque atual', 'qtde', 'saldo em estoque', 'estoque fisico'] },
    { key: 'custo', label: 'Custo unitário', type: 'valor', syn: ['custo', 'custo medio', 'preco de custo', 'valor unitario'] },
    { key: 'filial', label: 'Filial (código)', syn: ['filial', 'loja', 'deposito', 'local'] },
  ],
  receber: [
    { key: 'cliente', label: 'Cliente (nome ou CPF/CNPJ)', required: true, syn: ['cliente', 'nome', 'sacado', 'cpf cnpj', 'devedor', 'nome do cliente'] },
    { key: 'documento', label: 'Documento / nº do título', syn: ['documento', 'titulo', 'numero', 'nota', 'n documento', 'numero do documento', 'parcela'] },
    { key: 'vencimento', label: 'Vencimento', required: true, type: 'data', syn: ['vencimento', 'data de vencimento', 'data vencimento', 'vence em', 'dt vencimento'] },
    { key: 'valor', label: 'Valor em aberto', required: true, type: 'valor', syn: ['valor', 'saldo', 'valor em aberto', 'valor do titulo', 'valor parcela', 'saldo devedor', 'valor original'] },
    { key: 'emissao', label: 'Emissão', type: 'data', syn: ['emissao', 'data de emissao', 'data emissao', 'competencia'] },
    { key: 'forma', label: 'Forma (boleto, crediário…)', syn: ['forma', 'forma de pagamento', 'tipo', 'meio de pagamento'] },
    { key: 'descricao', label: 'Descrição', syn: ['descricao', 'historico', 'observacao', 'obs'] },
  ],
  pagar: [
    { key: 'fornecedor', label: 'Fornecedor (nome ou CNPJ)', syn: ['fornecedor', 'nome', 'favorecido', 'credor', 'cnpj', 'razao social'] },
    { key: 'documento', label: 'Documento / nº do título', required: true, syn: ['documento', 'titulo', 'numero', 'nota', 'n documento', 'numero do documento'] },
    { key: 'vencimento', label: 'Vencimento', required: true, type: 'data', syn: ['vencimento', 'data de vencimento', 'data vencimento', 'dt vencimento'] },
    { key: 'valor', label: 'Valor em aberto', required: true, type: 'valor', syn: ['valor', 'saldo', 'valor em aberto', 'valor do titulo', 'valor parcela'] },
    { key: 'categoria', label: 'Categoria de despesa', syn: ['categoria', 'plano de contas', 'conta', 'classificacao', 'centro de custo'] },
    { key: 'descricao', label: 'Descrição', syn: ['descricao', 'historico', 'observacao', 'obs'] },
  ],
}

export const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Sugere a coluna de cada campo pelo nome (igual > começa com > contém). */
export function autoMap(kind: Kind, headers: string[]): Record<string, string | null> {
  const hn = headers.map(norm), used = new Set<number>(), out: Record<string, string | null> = {}
  const score = (h: string, syn: string) => (h === syn ? 3 : h.startsWith(syn + ' ') || h.endsWith(' ' + syn) ? 2 : syn.length > 3 && h.includes(syn) ? 1 : 0)
  // campos com mais sinônimos específicos primeiro, para "codigo de barras" não ser tomado por "codigo"
  const fields = [...FIELDS[kind]].sort((a, b) => Math.max(...b.syn.map((x) => x.length)) - Math.max(...a.syn.map((x) => x.length)))
  for (const f of fields) {
    let best = -1, bs = 0
    hn.forEach((h, i) => { if (used.has(i)) return; const sc = Math.max(...f.syn.map((s) => score(h, s))); if (sc > bs) { bs = sc; best = i } })
    out[f.key] = best >= 0 ? headers[best] : null
    if (best >= 0) used.add(best)
  }
  return out
}

// ---------- normalizadores ----------
export function money(s: string): number | null { return parseNum(s, 2) }
export function qty(s: string): number | null { return parseNum(s, 3) }
function parseNum(s: string, dec: number): number | null {
  if (!s) return null
  let t = s.replace(/[R$\s]/g, '')
  if (/^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(t) || /^-?\d+,\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.')
  else if (/^-?\d{1,3}(,\d{3})*(\.\d+)?$/.test(t)) t = t.replace(/,/g, '')
  const n = Number(t)
  return Number.isFinite(n) ? Math.round(n * 10 ** dec) / 10 ** dec : NaN
}
export function date(s: string): string | null {
  if (!s) return null
  const t = s.trim()
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(t)
  if (m) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return valid(y, Number(m[2]), Number(m[1])) }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t)
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]))
  if (/^\d{5}(\.\d+)?$/.test(t)) { const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86400000); return d.toISOString().slice(0, 10) } // número de série do Excel
  return 'invalida'
}
function valid(y: number, mo: number, d: number) { const dt = new Date(Date.UTC(y, mo - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && y > 1900 && y < 2100 ? dt.toISOString().slice(0, 10) : 'invalida' }
export function gtinOk(code: string) {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false
  const d = code.split('').map(Number), check = d.pop()!
  const sum = d.reverse().reduce((a, x, i) => a + x * (i % 2 === 0 ? 3 : 1), 0)
  return (10 - (sum % 10)) % 10 === check
}
export function docOk(s: string): { digits: string; type: 'PF' | 'PJ' | null; ok: boolean } {
  const d = onlyDigits(s || '')
  if (!d) return { digits: '', type: null, ok: true }
  if (d.length === 11) return { digits: d, type: 'PF', ok: isValidCPF(d) }
  if (d.length === 14) return { digits: d, type: 'PJ', ok: isValidCNPJ(d) }
  return { digits: d, type: null, ok: false }
}
