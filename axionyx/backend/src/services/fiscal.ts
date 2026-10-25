import { Q, nextNumber } from '../core/db'
import { conflict, notFound, unprocessable } from '../core/errors'
import { onlyDigits, isValidCNPJ, isValidCPF, isValidGTIN } from '../core/validate'
import { r2 } from '../core/http'
import { getSettings } from './settings'
import { getFiscalAdapter } from '../integrations/fiscal-adapter'

const TPAG: Record<string, string> = { dinheiro: '01', credito: '03', debito: '04', crediario: '05', vale_troca: '05', boleto: '15', pix: '17', cashback: '19', outro: '99' }
const CSOSN = ['101', '102', '103', '201', '202', '203', '300', '400', '500', '900']
const CST = ['00', '10', '20', '30', '40', '41', '50', '51', '60', '70', '90']

export interface ValidationIssue { field: string; message: string }

/** Monta os dados fiscais de uma venda (estrutura neutra entregue ao provedor). */
export async function buildSalePayload(c: Q, saleId: string, model: '55' | '65') {
  const s = await c.one(
    `SELECT s.*, b.name AS branch_name, b.cnpj AS branch_cnpj, b.ie AS branch_ie, b.address AS branch_address,
            co.name AS company_name, co.trade_name, co.cnpj AS company_cnpj, co.ie AS company_ie, co.crt, co.address AS company_address, co.tax_regime
       FROM sales s JOIN branches b ON b.id = s.branch_id JOIN companies co ON co.id = s.company_id WHERE s.id = $1`, [saleId])
  if (!s) throw notFound('Venda')
  const customer = s.customer_id ? await c.one('SELECT * FROM customers WHERE id = $1', [s.customer_id]) : null
  const allItems = await c.many(
    `SELECT si.*, v.sku, v.barcode, p.name, p.ncm, p.cest, p.origin, p.cfop, p.cst_csosn, p.unit, p.kind, sz.code AS size, co.name AS color
       FROM sale_items si JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
       LEFT JOIN sizes sz ON sz.id = v.size_id LEFT JOIN colors co ON co.id = v.color_id
      WHERE si.sale_id = $1 ORDER BY si.line`, [saleId])
  // NFC-e/NF-e acobertam mercadorias; serviços e pacotes (ISS) ficam fora e são documentados por NFS-e municipal
  const items = allItems.filter((i) => !i.kind || i.kind === 'produto')
  const servicesTotal = r2(allItems.filter((i) => i.kind && i.kind !== 'produto').reduce((acc, i) => acc + Number(i.total), 0))
  let payments = await c.many(`SELECT kind, amount, installments, details FROM sale_payments WHERE sale_id = $1`, [saleId])
  const goodsTotal = r2(items.reduce((acc, i) => acc + Number(i.total), 0))
  const goodsGross = r2(items.reduce((acc, i) => acc + Number(i.unit_price) * Number(i.qty), 0))
  if (servicesTotal > 0 && Number(s.total) > 0) {
    // rateia os pagamentos proporcionalmente à parte de mercadorias
    const ratio = goodsTotal / Number(s.total)
    let acc = 0
    payments = payments.map((p, k) => { const amt = k === payments.length - 1 ? r2(goodsTotal - acc) : r2(Number(p.amount) * ratio); acc = r2(acc + amt); return { ...p, amount: amt } }).filter((p) => Number(p.amount) > 0)
  }
  const emitAddress = Object.keys(s.branch_address || {}).length ? s.branch_address : s.company_address
  return {
    emitente: { razaoSocial: s.company_name, fantasia: s.trade_name, cnpj: onlyDigits(s.branch_cnpj || s.company_cnpj), ie: onlyDigits(s.branch_ie || s.company_ie), crt: s.crt, endereco: emitAddress },
    destinatario: customer ? { nome: customer.name, documento: onlyDigits(customer.cpf_cnpj), ie: customer.ie, email: customer.email, endereco: customer.address } : null,
    itens: items.map((i) => ({
      numero: i.line, codigo: i.sku, gtin: i.barcode && isValidGTIN(i.barcode) ? i.barcode : 'SEM GTIN',
      descricao: [i.name, i.size, i.color].filter(Boolean).join(' '), ncm: i.ncm, cest: i.cest, cfop: i.cfop, origem: i.origin,
      cstCsosn: i.cst_csosn, unidade: i.unit, quantidade: i.qty, valorUnitario: Number(i.unit_price), desconto: Number(i.discount), valorTotal: Number(i.total),
    })),
    pagamentos: payments.map((p) => ({ tPag: TPAG[p.kind] || '99', valor: Number(p.amount), parcelas: p.installments })),
    totais: servicesTotal > 0 ? { produtos: goodsGross, desconto: r2(goodsGross - goodsTotal), total: goodsTotal } : { produtos: Number(s.subtotal), desconto: Number(s.discount_total), total: Number(s.total) },
    informacoesAdicionais: `Venda nº ${s.number}` + (servicesTotal > 0 ? ` — serviços (R$ ${servicesTotal.toFixed(2)}) não incluídos: documentar por NFS-e municipal` : ''),
    modelo: model,
  }
}

export function validatePayload(p: any, model: '55' | '65'): ValidationIssue[] {
  const e: ValidationIssue[] = []
  const em = p.emitente || {}
  if (!isValidCNPJ(em.cnpj || '')) e.push({ field: 'emitente.cnpj', message: 'CNPJ do emitente inválido (cadastre em Administração > Empresas/Filiais).' })
  if (!em.ie) e.push({ field: 'emitente.ie', message: 'Inscrição estadual do emitente não informada.' })
  const ad = em.endereco || {}
  if (!/^\d{7}$/.test(String(ad.codigoMunicipio || ''))) e.push({ field: 'emitente.endereco.codigoMunicipio', message: 'Código IBGE do município do emitente (7 dígitos) não informado.' })
  if (!/^[A-Z]{2}$/.test(String(ad.uf || ''))) e.push({ field: 'emitente.endereco.uf', message: 'UF do emitente inválida.' })
  if (!ad.logradouro || !ad.numero || !ad.bairro || !/^\d{8}$/.test(onlyDigits(ad.cep))) e.push({ field: 'emitente.endereco', message: 'Endereço do emitente incompleto (logradouro, número, bairro e CEP).' })
  const simples = [1, 2, 4].includes(Number(em.crt))
  const d = p.destinatario
  if (model === '55') {
    if (!d) e.push({ field: 'destinatario', message: 'NF-e exige destinatário identificado.' })
    else {
      const doc = onlyDigits(d.documento)
      if (!(doc.length === 11 ? isValidCPF(doc) : isValidCNPJ(doc))) e.push({ field: 'destinatario.documento', message: 'CPF/CNPJ do destinatário inválido.' })
      const da = d.endereco || {}
      if (!da.logradouro || !da.numero || !da.bairro || !/^\d{7}$/.test(String(da.codigoMunicipio || '')) || !/^[A-Z]{2}$/.test(String(da.uf || '')))
        e.push({ field: 'destinatario.endereco', message: 'Endereço completo do destinatário (com código IBGE e UF) é obrigatório na NF-e.' })
    }
  } else if (d && d.documento) {
    const doc = onlyDigits(d.documento)
    if (!(doc.length === 11 ? isValidCPF(doc) : isValidCNPJ(doc))) e.push({ field: 'destinatario.documento', message: 'CPF/CNPJ informado na NFC-e é inválido.' })
  }
  if (!p.itens?.length) e.push({ field: 'itens', message: 'Documento sem mercadorias (serviços não entram na NFC-e/NF-e: são documentados por NFS-e municipal).' })
  for (const it of p.itens || []) {
    const f = `itens[${it.numero}]`
    if (!/^\d{8}$/.test(String(it.ncm || ''))) e.push({ field: `${f}.ncm`, message: `Item ${it.numero} (${it.codigo}): NCM deve ter 8 dígitos.` })
    if (!/^[5-7]\d{3}$/.test(String(it.cfop || ''))) e.push({ field: `${f}.cfop`, message: `Item ${it.numero} (${it.codigo}): CFOP de saída inválido.` })
    if (simples && !CSOSN.includes(String(it.cstCsosn))) e.push({ field: `${f}.cstCsosn`, message: `Item ${it.numero}: CSOSN inválido para empresa do Simples Nacional.` })
    if (!simples && !CST.includes(String(it.cstCsosn))) e.push({ field: `${f}.cstCsosn`, message: `Item ${it.numero}: CST do ICMS inválido para o regime normal.` })
    if (it.cest && !/^\d{7}$/.test(String(it.cest))) e.push({ field: `${f}.cest`, message: `Item ${it.numero}: CEST deve ter 7 dígitos.` })
    if (!(it.quantidade > 0) || !(it.valorUnitario > 0)) e.push({ field: f, message: `Item ${it.numero}: quantidade e valor devem ser maiores que zero.` })
  }
  const pag = r2((p.pagamentos || []).reduce((a: number, x: any) => a + x.valor, 0))
  if (Math.abs(pag - p.totais.total) > 0.01) e.push({ field: 'pagamentos', message: `Soma dos pagamentos (${pag.toFixed(2)}) difere do total (${Number(p.totais.total).toFixed(2)}).` })
  return e
}

/** Cria (ou reaproveita) o documento fiscal de uma venda em rascunho, já validado. */
export async function createDocumentForSale(c: Q, companyId: string, branchId: string, saleId: string, model: '55' | '65', userId?: string) {
  const existing = await c.one(`SELECT * FROM fiscal_documents WHERE sale_id = $1 AND model = $2 AND status NOT IN ('cancelado','invalido','rejeitado','erro')`, [saleId, model])
  if (existing) return existing
  const settings = (await getSettings(c, companyId)).fiscal
  const payload = await buildSalePayload(c, saleId, model)
  const issues = validatePayload(payload, model)
  const doc = await c.one(
    `INSERT INTO fiscal_documents(company_id, branch_id, model, environment, series, operation, sale_id, recipient, totals, payload, status, is_test, validation, created_by)
     VALUES ($1,$2,$3,$4,$5,'venda',$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [companyId, branchId, model, settings.ambiente, model === '65' ? settings.serieNfce : settings.serieNfe, saleId, JSON.stringify(payload.destinatario || {}),
      JSON.stringify(payload.totais), JSON.stringify(payload), issues.length ? 'invalido' : 'rascunho', settings.ambiente !== 'producao', JSON.stringify(issues), userId ?? null])
  await c.query(`INSERT INTO fiscal_events(document_id, type, status, message, user_id) VALUES ($1,'criacao',$2,$3,$4)`,
    [doc.id, doc.status, issues.length ? `${issues.length} pendência(s) de validação` : 'Documento validado e pronto para envio', userId ?? null])
  return doc
}

/** Revalida com os cadastros atuais (após correções) e reconstrói o payload. */
export async function revalidate(c: Q, docId: string, companyId: string) {
  const doc = await c.one(`SELECT * FROM fiscal_documents WHERE id = $1 AND company_id = $2 FOR UPDATE`, [docId, companyId])
  if (!doc) throw notFound('Documento fiscal')
  if (!['rascunho', 'invalido', 'pendente_configuracao', 'rejeitado', 'erro'].includes(doc.status)) throw conflict('Documento não pode mais ser alterado.')
  if (!doc.sale_id) return doc
  const payload = await buildSalePayload(c, doc.sale_id, doc.model)
  const issues = validatePayload(payload, doc.model)
  const status = issues.length ? 'invalido' : (doc.status === 'invalido' ? 'rascunho' : doc.status)
  return c.one(`UPDATE fiscal_documents SET payload = $2, validation = $3, status = $4, updated_at = now() WHERE id = $1 RETURNING *`,
    [docId, JSON.stringify(payload), JSON.stringify(issues), status])
}

/** Envia ao provedor configurado. Sem provedor: marca "pendente_configuracao" sem simular autorização. */
export async function transmit(c: Q, docId: string, companyId: string, userId?: string) {
  let doc = await revalidate(c, docId, companyId)
  if (doc.status === 'invalido') throw unprocessable('Corrija as pendências de validação antes de transmitir.', doc.validation)
  const adapter = getFiscalAdapter()
  if (!doc.number && adapter.configured()) {
    const n = await nextNumber(c, companyId, `fiscal:${doc.branch_id}:${doc.model}:${doc.series}:${doc.environment}`)
    doc = await c.one(`UPDATE fiscal_documents SET number = $2 WHERE id = $1 RETURNING *`, [docId, n])
  }
  const result = await adapter.emit({ id: doc.id, model: doc.model, environment: doc.environment, series: doc.series, number: doc.number, payload: doc.payload })
  const updated = await c.one(
    `UPDATE fiscal_documents SET status = $2, access_key = COALESCE($3, access_key), protocol = COALESCE($4, protocol), xml = COALESCE($5, xml),
            danfe_url = COALESCE($6, danfe_url), provider = $7, provider_ref = COALESCE($8, provider_ref), messages = $9, attempts = attempts + 1,
            authorized_at = CASE WHEN $2 = 'autorizado' THEN now() ELSE authorized_at END, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [docId, result.status, result.accessKey ?? null, result.protocol ?? null, result.xml ?? null, result.danfeUrl ?? null, adapter.name, result.providerRef ?? null, JSON.stringify(result.messages)])
  await c.query(`INSERT INTO fiscal_events(document_id, type, status, message, response, user_id) VALUES ($1,'transmissao',$2,$3,$4,$5)`,
    [docId, result.status, result.messages.map((m) => m.text).join(' | ') || null, JSON.stringify({ ...result, xml: result.xml ? '[xml armazenado]' : undefined }), userId ?? null])
  return updated
}

export async function cancelDocument(c: Q, docId: string, companyId: string, reason: string, userId?: string) {
  if (!reason || reason.trim().length < 15) throw unprocessable('A justificativa do cancelamento deve ter pelo menos 15 caracteres.')
  const doc = await c.one(`SELECT * FROM fiscal_documents WHERE id = $1 AND company_id = $2 FOR UPDATE`, [docId, companyId])
  if (!doc) throw notFound('Documento fiscal')
  if (doc.status === 'cancelado') return doc
  if (doc.status !== 'autorizado') {
    // documento nunca autorizado: apenas descarta localmente
    const u = await c.one(`UPDATE fiscal_documents SET status = 'cancelado', cancelled_at = now(), cancel_reason = $2, updated_at = now() WHERE id = $1 RETURNING *`, [docId, reason])
    await c.query(`INSERT INTO fiscal_events(document_id, type, status, message, user_id) VALUES ($1,'descarte','cancelado',$2,$3)`, [docId, 'Documento não autorizado descartado: ' + reason, userId ?? null])
    return u
  }
  const adapter = getFiscalAdapter()
  const result = await adapter.cancel({ id: doc.id, model: doc.model, environment: doc.environment, series: doc.series, number: doc.number, payload: doc.payload, accessKey: doc.access_key, providerRef: doc.provider_ref }, reason)
  const ok = result.status === 'cancelado'
  const u = await c.one(
    `UPDATE fiscal_documents SET status = CASE WHEN $2 THEN 'cancelado' ELSE status END, cancelled_at = CASE WHEN $2 THEN now() ELSE cancelled_at END,
            cancel_reason = CASE WHEN $2 THEN $3 ELSE cancel_reason END, messages = $4, updated_at = now() WHERE id = $1 RETURNING *`,
    [docId, ok, reason, JSON.stringify(result.messages)])
  await c.query(`INSERT INTO fiscal_events(document_id, type, status, message, user_id) VALUES ($1,'cancelamento',$2,$3,$4)`,
    [docId, result.status, result.messages.map((m) => m.text).join(' | ') || null, userId ?? null])
  if (!ok) return { ...u, cancel_error: `Cancelamento não concluído pelo provedor: ${result.messages.map((m) => m.text).join(' ') || result.status}` }
  return u
}
