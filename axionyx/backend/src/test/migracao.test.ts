import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { setup, teardown, call, login, PASSWORD, baseUrl } from './helpers'
import { db } from '../core/db'
import { hashPassword } from '../core/crypto'
import { autoMap, money, qty, date, docOk } from '../migration/fields'
import { parseCsv } from '../migration/parse'

/**
 * Migração: planilhas (CSV/XLSX) de clientes, fornecedores, produtos, estoque, contas a receber e a pagar, com mapeamento
 * automático, prévia sem gravar, importação atômica e desfazer; XML de NF-e com histórico de vendas; IA sem dados reais.
 */
let env: any, OWNER: string, AGENT: string, NOPERM: string, A: string, coA = '', coB = ''
const waitJob = async (id: string) => { for (let i = 0; i < 300; i++) { const j = await call('GET', `/api/platform/jobs/${id}`, { token: OWNER }); if (j.body.status !== 'executando') return j.body; await new Promise((r) => setTimeout(r, 100)) } throw new Error('tarefa não terminou') }
async function upload(token: string, params: Record<string, string>, data: Buffer | string) {
  const r = await fetch(baseUrl() + '/api/platform/migration/upload?' + new URLSearchParams(params), { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/octet-stream' }, body: typeof data === 'string' ? Buffer.from(data, 'utf8') : data })
  return { status: r.status === 201 ? 200 : r.status, body: await r.json().catch(() => null) as any }
}
const ean = (b12: string) => { const d = b12.split('').map(Number); const s = d.reverse().reduce((a, x, i) => a + x * (i % 2 === 0 ? 3 : 1), 0); return b12 + ((10 - (s % 10)) % 10) }
function zip(files: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = []; let off = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), nm = Buffer.from(name), crc = zlib.crc32(data)
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26)
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42)
    parts.push(lh, nm, data); central.push(ch, nm); off += 30 + nm.length + data.length
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16)
  return Buffer.concat([...parts, cd, end])
}
function xlsx(rows: (string | number)[][]): Buffer {
  const strings: string[] = []
  const si = (s: string) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1 } return i }
  const col = (i: number) => String.fromCharCode(65 + i)
  const sheet = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${si(v)}</v></c>`).join('')}</row>`).join('')
  return zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Produtos" sheetId="1"/></sheets></workbook>',
    'xl/sharedStrings.xml': `<sst>${strings.map((s) => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
  })
}
function nfe(o: { key: string; emit: string; emitName: string; dest?: { doc: string; name: string }; tpNF?: string; items: { code: string; ean?: string; name: string; qty: number; price: number }[]; date: string; cStat?: string }) {
  const det = o.items.map((i, n) => `<det nItem="${n + 1}"><prod><cProd>${i.code}</cProd><cEAN>${i.ean ?? 'SEM GTIN'}</cEAN><xProd>${i.name}</xProd><NCM>61091000</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>${i.qty.toFixed(4)}</qCom><vUnCom>${i.price.toFixed(2)}</vUnCom><vProd>${(i.qty * i.price).toFixed(2)}</vProd></prod></det>`).join('')
  const total = o.items.reduce((a, i) => a + i.qty * i.price, 0)
  const dest = o.dest ? `<dest>${o.dest.doc.length === 11 ? `<CPF>${o.dest.doc}</CPF>` : `<CNPJ>${o.dest.doc}</CNPJ>`}<xNome>${o.dest.name}</xNome><enderDest><xLgr>Rua A</xLgr><nro>10</nro><xMun>Goiânia</xMun><UF>GO</UF><CEP>74000000</CEP></enderDest></dest>` : ''
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc><NFe><infNFe Id="NFe${o.key}" versao="4.00"><ide><nNF>${o.key.slice(25, 34).replace(/^0+/, '')}</nNF><serie>1</serie><dhEmi>${o.date}</dhEmi><tpNF>${o.tpNF ?? '1'}</tpNF></ide><emit><CNPJ>${o.emit}</CNPJ><xNome>${o.emitName}</xNome><enderEmit><xLgr>Av B</xLgr><nro>1</nro><xMun>Goiânia</xMun><UF>GO</UF><fone>6233334444</fone></enderEmit></emit>${dest}${det}<total><ICMSTot><vProd>${total.toFixed(2)}</vProd><vDesc>0.00</vDesc><vNF>${total.toFixed(2)}</vNF></ICMSTot></total></infNFe></NFe><protNFe><infProt><cStat>${o.cStat ?? '100'}</cStat><nProt>1</nProt></infProt></protNFe></nfeProc>`
}
const key44 = (n: number, cnpj: string) => `522603${cnpj}55001${String(n).padStart(9, '0')}1${String(n).padStart(8, '0')}0`

// provedor de IA simulado: guarda o que recebeu para conferir que nenhum dado real saiu
const seen: any[] = []
const fakeAI = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
    const body = JSON.parse(raw || '{}'); seen.push(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 20 }, content: [{ type: 'text', text: 'Segue: {"nome": "Razao", "cpf_cnpj": "Documento", "email": "Contato", "telefone": "Inexistente"}' }] }))
  })
})

before(async () => {
  await new Promise<void>((r) => fakeAI.listen(0, '127.0.0.1', () => r()))
  process.env.AI_ANTHROPIC_BASE_URL = `http://127.0.0.1:${(fakeAI.address() as AddressInfo).port}`
  env = await setup(); coA = env.companyA.company.id; coB = env.companyB.company.id
  await db.query(`INSERT INTO users(name, email, password_hash, is_superadmin, platform_owner) VALUES ('Dono', 'dono@axionyx.test', $1, true, true)`, [hashPassword(PASSWORD)])
  await db.query(`INSERT INTO users(name, email, password_hash, is_superadmin, platform_owner, platform_permissions) VALUES ('Implantação', 'impl@axionyx.test', $1, true, false, $2)`, [hashPassword(PASSWORD), ['plataforma.migracao', 'suporte.acessar']])
  await db.query(`INSERT INTO users(name, email, password_hash, is_superadmin, platform_owner, platform_permissions) VALUES ('Suporte', 'suporte@axionyx.test', $1, true, false, $2)`, [hashPassword(PASSWORD), ['suporte.acessar', 'plataforma.backup']])
  OWNER = (await login('dono@axionyx.test', coA)).token; AGENT = (await login('impl@axionyx.test', coA)).token; NOPERM = (await login('suporte@axionyx.test', coA)).token
  A = (await login('admin.a@teste.local')).token
  await call('POST', '/api/customers', { token: A, body: { name: 'Cliente Que Já Existe', cpf_cnpj: '52998224725' } })
})
after(async () => { await teardown(); fakeAI.close(); delete process.env.AI_ANTHROPIC_BASE_URL })

test('normalizadores e mapeamento automático de colunas', () => {
  assert.equal(money('R$ 1.234,56'), 1234.56); assert.equal(money('1,234.56'), 1234.56); assert.equal(money('99,9'), 99.9); assert.ok(Number.isNaN(money('abc') as number))
  assert.equal(qty('1,250'), 1.25); assert.equal(qty('0,375'), 0.375)
  assert.equal(date('05/03/2026'), '2026-03-05'); assert.equal(date('2026-03-05'), '2026-03-05'); assert.equal(date('31/02/2026'), 'invalida'); assert.equal(date('46086'), '2026-03-05')
  assert.equal(docOk('529.982.247-25').ok, true); assert.equal(docOk('111.111.111-11').ok, false); assert.equal(docOk('11.222.333/0001-81').type, 'PJ')
  const m = autoMap('produtos', ['Cód. Barras', 'Código', 'Descrição do Produto', 'Preço de Venda', 'Preço Custo', 'Unid', 'NCM', 'Grupo', 'Tam', 'Cor'])
  assert.equal(m.ean, 'Cód. Barras'); assert.equal(m.codigo, 'Código'); assert.equal(m.nome, 'Descrição do Produto'); assert.equal(m.preco, 'Preço de Venda'); assert.equal(m.custo, 'Preço Custo')
  assert.equal(m.categoria, 'Grupo'); assert.equal(m.tamanho, 'Tam'); assert.equal(m.cor, 'Cor')
  const c = parseCsv('Nome;"Endereço; completo"\r\n"Maria ""Mel""";Rua 1\n\nJoão;Rua 2')
  assert.deepEqual(c.headers, ['Nome', 'Endereço; completo']); assert.deepEqual(c.rows, [['Maria "Mel"', 'Rua 1'], ['João', 'Rua 2']])
})

test('exclusivo da plataforma com a permissão "Migração de dados"', async () => {
  assert.equal((await call('GET', '/api/platform/migration/meta', { token: A })).status, 403)
  assert.equal((await call('GET', '/api/platform/migration/meta', { token: NOPERM })).status, 403)
  assert.equal((await upload(A, { company: coA, kind: 'clientes', name: 'c.csv' }, 'Nome\nX')).status, 403)
  const m = await call('GET', '/api/platform/migration/meta', { token: AGENT })
  assert.equal(m.status, 200); assert.ok(m.body.fields.clientes.find((f: any) => f.key === 'nome' && f.required))
  assert.equal((await call('GET', '/api/platform/migration/meta', { token: OWNER })).status, 200)
})

test('clientes: prévia não grava, erros bloqueiam, existentes são mantidos, importa e desfaz', async () => {
  const before = (await db.query(`SELECT count(*)::int AS n FROM customers WHERE company_id = $1`, [coA])).rows[0].n
  const csv = 'Razão Social;CPF/CNPJ;E-mail;Telefone;Cidade;UF;Limite de Crédito\n' +
    'Ana Souza;111.444.777-35;ana@ex.com;(62) 99999-0000;Goiânia;go;1.500,00\n' +
    'Cliente Que Já Existe;529.982.247-25;x@ex.com;;;;\n' +
    'Documento Errado;123.456.789-00;;;;;\n' +
    'Ana Repetida;11144477735;;;;;\n' +
    ';;sem-nome@ex.com;;;;\n' +
    'Bruno Sem Documento;;email-invalido;;;;'
  const up = await upload(AGENT, { company: coA, kind: 'clientes', name: 'clientes.csv' }, Buffer.from(csv, 'latin1'))
  assert.equal(up.status, 200, JSON.stringify(up.body))
  assert.equal(up.body.batch.mapping.nome, 'Razão Social'); assert.equal(up.body.batch.mapping.cpf_cnpj, 'CPF/CNPJ'); assert.equal(up.body.batch.mapping.cidade, 'Cidade')
  const s = up.body.preview.summary
  assert.deepEqual([s.total, s.novos, s.existentes, s.erros], [6, 2, 1, 3])
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM customers WHERE company_id = $1`, [coA])).rows[0].n, before, 'a prévia não grava nada')
  const issues = up.body.preview.issues.map((i: any) => `${i.line}:${i.errors.join(',')}|${i.warnings.join(',')}`).join('\n')
  assert.match(issues, /4:CPF\/CNPJ inválido/); assert.match(issues, /5:CPF\/CNPJ repetido/); assert.match(issues, /6:Nome.*não informado/); assert.match(issues, /7:\|.*E-mail "email-invalido" ignorado/)
  // relatório de erros em CSV
  const csvErr = await fetch(baseUrl() + `/api/platform/migration/batches/${up.body.batch.id}/errors.csv`, { headers: { authorization: 'Bearer ' + AGENT } })
  const txt = await csvErr.text(); assert.match(txt, /Não será importada/); assert.match(txt, /Documento Errado/)
  // com erros, só importa se confirmar
  assert.equal((await call('POST', `/api/platform/migration/batches/${up.body.batch.id}/commit`, { token: AGENT, body: {} })).status, 422)
  const cm = await call('POST', `/api/platform/migration/batches/${up.body.batch.id}/commit`, { token: AGENT, body: { ignoreErrors: true } })
  assert.equal(cm.status, 200); const job = await waitJob(cm.body.jobId)
  assert.equal(job.status, 'ok', JSON.stringify(job)); assert.equal(job.result.clientes, 2)
  const ana = (await db.query(`SELECT * FROM customers WHERE company_id = $1 AND cpf_cnpj = '11144477735'`, [coA])).rows[0]
  assert.equal(ana.name, 'Ana Souza'); assert.equal(ana.phone, '62999990000'); assert.equal(Number(ana.credit_limit), 1500); assert.equal(ana.address.uf, 'GO'); assert.equal(ana.address.cidade, 'Goiânia')
  assert.equal((await db.query(`SELECT name FROM customers WHERE company_id = $1 AND cpf_cnpj = '52998224725'`, [coA])).rows[0].name, 'Cliente Que Já Existe', 'existente mantido')
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM customers WHERE company_id = $1 AND name = 'Ana Souza'`, [coB])).rows[0].n, 0, 'nada na outra empresa')
  assert.equal((await call('POST', `/api/platform/migration/batches/${up.body.batch.id}/commit`, { token: AGENT, body: { ignoreErrors: true } })).status, 409, 'não importa duas vezes')
  const und = await call('POST', `/api/platform/migration/batches/${up.body.batch.id}/undo`, { token: AGENT })
  assert.equal(und.status, 200); const uj = await waitJob(und.body.jobId)
  assert.equal(uj.status, 'ok'); assert.equal(uj.result.removed, 2)
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM customers WHERE company_id = $1`, [coA])).rows[0].n, before)
  assert.equal((await db.query(`SELECT status FROM migration_batches WHERE id = $1`, [up.body.batch.id])).rows[0].status, 'desfeito')
})

test('produtos (XLSX com grade) + estoque + a receber + a pagar; desfazer mantém o que já foi usado', async () => {
  const e1 = ean('789000000001'), e2 = ean('789000000002')
  const book = xlsx([
    ['Código', 'Descrição', 'Cód. Barras', 'Preço Venda', 'Custo', 'Tamanho', 'Cor', 'Marca', 'Grupo', 'NCM'],
    ['MIG-1', 'Camiseta Migrada', e1, '79,90', '30', 'P', 'Azul', 'Marca Mig', 'Camisetas', '6109.10.00'],
    ['MIG-1', 'Camiseta Migrada', e2, '79,90', '30', 'M', 'Azul', 'Marca Mig', 'Camisetas', '6109.10.00'],
    ['MIG-2', 'Boné Migrado', '7890000000001', 49.9, 20, '', '', 'Marca Mig', 'Acessórios', '123'],
    ['MIG-1', 'Camiseta Migrada', '', '79,90', '30', 'P', 'Azul', '', '', ''],
  ])
  const up = await upload(AGENT, { company: coA, kind: 'produtos', name: 'produtos.xlsx' }, book)
  assert.equal(up.status, 200, JSON.stringify(up.body))
  const s = up.body.preview.summary
  assert.deepEqual([s.total, s.novos, s.erros, s.extra.produtos], [4, 3, 1, 2])
  const iss = JSON.stringify(up.body.preview.issues); assert.match(iss, /inválido: será gerado um interno/); assert.match(iss, /NCM .* ignorado/); assert.match(iss, /repetido na planilha/)
  const job = await waitJob((await call('POST', `/api/platform/migration/batches/${up.body.batch.id}/commit`, { token: AGENT, body: { ignoreErrors: true } })).body.jobId)
  assert.equal(job.status, 'ok', JSON.stringify(job)); assert.equal(job.result.produtos, 2); assert.equal(job.result.variacoes, 3)
  const vars = (await db.query(`SELECT v.sku, v.barcode, p.code, p.ncm, p.sale_price, b.name AS brand, s.code AS size FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN sizes s ON s.id = v.size_id WHERE p.company_id = $1 AND p.code LIKE 'MIG-%' ORDER BY v.sku`, [coA])).rows
  assert.equal(vars.length, 3); assert.equal(vars.find((v: any) => v.size === 'M').barcode, e2); assert.equal(Number(vars[0].sale_price), 79.9); assert.equal(vars.find((v: any) => v.code === 'MIG-1').ncm, '61091000'); assert.equal(vars[0].brand, 'Marca Mig')
  const prodBatch = up.body.batch.id

  // estoque: saldo inicial pelo código de barras e pelo SKU
  const sku = vars.find((v: any) => v.code === 'MIG-2').sku
  const st = await upload(AGENT, { company: coA, kind: 'estoque', name: 'estoque.csv' }, `Produto;Saldo;Custo\n${e1};12;31,50\n${sku};5;\n${e2};2,5;\nNAO-EXISTE;1;`)
  assert.equal(st.status, 200, JSON.stringify(st.body)); assert.deepEqual([st.body.preview.summary.novos, st.body.preview.summary.erros], [2, 2])
  const sj = await waitJob((await call('POST', `/api/platform/migration/batches/${st.body.batch.id}/commit`, { token: AGENT, body: { ignoreErrors: true } })).body.jobId)
  assert.equal(sj.status, 'ok', JSON.stringify(sj)); assert.equal(sj.result.ajustes, 2)
  const bal = async (code: string) => Number((await db.query(`SELECT COALESCE(sum(b.qty),0) AS q FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id WHERE v.company_id = $1 AND (v.barcode = $2 OR v.sku = $2)`, [coA, code])).rows[0].q)
  assert.equal(await bal(e1), 12); assert.equal(await bal(sku), 5)

  // contas a receber: cliente pelo nome, cliente novo pelo CNPJ
  const rc = await upload(AGENT, { company: coA, kind: 'receber', name: 'receber.csv' }, `Cliente;Documento;Vencimento;Valor;Forma\nCliente Que Já Existe;D-1;10/12/2026;150,00;Crediário\n11.222.333/0001-81;D-2;15/12/2026;99,90;boleto\nNinguém;D-3;31/13/2026;10;`)
  assert.equal(rc.status, 200, JSON.stringify(rc.body)); assert.deepEqual([rc.body.preview.summary.novos, rc.body.preview.summary.erros], [3 - 1, 1])
  const rj = await waitJob((await call('POST', `/api/platform/migration/batches/${rc.body.batch.id}/commit`, { token: AGENT, body: { ignoreErrors: true } })).body.jobId)
  assert.equal(rj.status, 'ok', JSON.stringify(rj)); assert.equal(rj.result.titulos, 2); assert.equal(rj.result.clientes_criados, 1)
  const recs = (await db.query(`SELECT document, method_kind, amount, due_date, status FROM receivables WHERE company_id = $1 AND source_type = 'migracao' ORDER BY document`, [coA])).rows
  assert.deepEqual(recs.map((r: any) => [r.document, r.method_kind, Number(r.amount), r.due_date]), [['D-1', 'crediario', 150, '2026-12-10'], ['D-2', 'boleto', 99.9, '2026-12-15']])

  // contas a pagar: categoria pelo nome; fornecedor novo
  const cat = (await db.query(`SELECT name FROM financial_categories WHERE company_id = $1 AND type = 'despesa' AND system_key = 'aluguel'`, [coA])).rows[0]?.name ?? 'Aluguel'
  const pg = await upload(AGENT, { company: coA, kind: 'pagar', name: 'pagar.csv' }, `Fornecedor;Nº Documento;Vencimento;Valor;Categoria\nImobiliária Central;ALU-12;05/12/2026;3.200,00;${cat}\n;ENERGIA-11;20/11/2026;410,55;`)
  assert.equal(pg.status, 200, JSON.stringify(pg.body)); assert.equal(pg.body.preview.summary.novos, 2)
  const pj = await waitJob((await call('POST', `/api/platform/migration/batches/${pg.body.batch.id}/commit`, { token: AGENT, body: {} })).body.jobId)
  assert.equal(pj.status, 'ok', JSON.stringify(pj)); assert.equal(pj.result.titulos, 2); assert.equal(pj.result.fornecedores_criados, 1)
  const pays = (await db.query(`SELECT p.document, p.amount, s.name AS supplier, c.system_key FROM payables p LEFT JOIN suppliers s ON s.id = p.supplier_id JOIN financial_categories c ON c.id = p.category_id WHERE p.company_id = $1 AND p.source_type = 'migracao' ORDER BY p.document`, [coA])).rows
  assert.equal(pays[0].document, 'ALU-12'); assert.equal(Number(pays[0].amount), 3200); assert.equal(pays[0].supplier, 'Imobiliária Central'); assert.equal(pays[1].supplier, null)

  // desfazer o estoque: movimento inverso, saldo volta a zero
  const ue = await waitJob((await call('POST', `/api/platform/migration/batches/${st.body.batch.id}/undo`, { token: AGENT })).body.jobId)
  assert.equal(ue.status, 'ok', JSON.stringify(ue)); assert.equal(await bal(e1), 0)
  // um título já pago não é apagado ao desfazer
  await db.query(`UPDATE receivables SET paid_amount = amount, status = 'pago' WHERE company_id = $1 AND document = 'D-1'`, [coA])
  const ur = await waitJob((await call('POST', `/api/platform/migration/batches/${rc.body.batch.id}/undo`, { token: AGENT })).body.jobId)
  assert.equal(ur.status, 'ok'); assert.equal(ur.result.kept, 1)
  assert.deepEqual((await db.query(`SELECT document FROM receivables WHERE company_id = $1 AND source_type = 'migracao'`, [coA])).rows.map((r: any) => r.document), ['D-1'])
  // produto que já teve movimento é mantido; o outro é removido
  await db.query(`UPDATE migration_batches SET imported_at = now() - interval '8 days' WHERE id = $1`, [pg.body.batch.id])
  assert.equal((await call('POST', `/api/platform/migration/batches/${pg.body.batch.id}/undo`, { token: AGENT })).status, 409, 'prazo de 7 dias')
  const up2 = await waitJob((await call('POST', `/api/platform/migration/batches/${prodBatch}/undo`, { token: AGENT })).body.jobId)
  assert.equal(up2.status, 'ok', JSON.stringify(up2))
  const left = (await db.query(`SELECT code FROM products WHERE company_id = $1 AND code LIKE 'MIG-%' ORDER BY code`, [coA])).rows.map((r: any) => r.code)
  assert.deepEqual(left, ['MIG-1', 'MIG-2'], 'os dois tiveram movimento de estoque (histórico preservado)')
  assert.ok(up2.result.kept >= 2)
})

test('XML de NF-e: catálogo, clientes, fornecedores e histórico sem estoque/financeiro; canceladas e repetidas ignoradas', async () => {
  const own = '11222333000181', forn = '04252011000110'
  const e1 = ean('789111111111')
  const k1 = key44(1, own), k2 = key44(2, own), k3 = key44(3, own), k4 = key44(4, forn), k5 = key44(5, own)
  const files: Record<string, string> = {
    'vendas/1.xml': nfe({ key: k1, emit: own, emitName: 'Loja A', dest: { doc: '11144477735', name: 'Carla Compradora' }, date: '2026-03-10T10:00:00-03:00', items: [{ code: 'NF-10', ean: e1, name: 'Vestido Floral', qty: 2, price: 150 }, { code: 'NF-11', name: 'Cinto Couro', qty: 1, price: 60 }] }),
    'vendas/2.xml': nfe({ key: k2, emit: own, emitName: 'Loja A', date: '2026-04-02T15:30:00-03:00', items: [{ code: 'NF-10', ean: e1, name: 'Vestido Floral', qty: 1, price: 160 }] }),
    'vendas/3.xml': nfe({ key: k3, emit: own, emitName: 'Loja A', date: '2026-04-05T09:00:00-03:00', items: [{ code: 'NF-12', name: 'Cancelada', qty: 1, price: 10 }] }),
    'vendas/3-canc.xml': `<procEventoNFe><evento><infEvento><chNFe>${k3}</chNFe><tpEvento>110111</tpEvento></infEvento></evento><retEvento><infEvento><cStat>135</cStat></infEvento></retEvento></procEventoNFe>`,
    'compras/4.xml': nfe({ key: k4, emit: forn, emitName: 'Confecções Fornecedora Ltda', dest: { doc: own, name: 'Loja A' }, date: '2026-02-01T08:00:00-03:00', items: [{ code: 'F-999', ean: e1, name: 'VESTIDO FLORAL REF 999', qty: 10, price: 70 }] }),
    'vendas/5.xml': nfe({ key: k5, emit: own, emitName: 'Loja A', date: '2026-04-06T09:00:00-03:00', cStat: '101', items: [{ code: 'NF-13', name: 'Cancelada no protocolo', qty: 1, price: 10 }] }),
    'vendas/1-copia.xml': nfe({ key: k1, emit: own, emitName: 'Loja A', dest: { doc: '11144477735', name: 'Carla Compradora' }, date: '2026-03-10T10:00:00-03:00', items: [{ code: 'NF-10', ean: e1, name: 'Vestido Floral', qty: 2, price: 150 }] }),
    'lixo.xml': '<isso nao fecha',
  }
  const movesBefore = (await db.query(`SELECT count(*)::int AS n FROM stock_movements WHERE company_id = $1`, [coA])).rows[0].n
  const recBefore = (await db.query(`SELECT count(*)::int AS n FROM receivables WHERE company_id = $1`, [coA])).rows[0].n
  const up = await upload(AGENT, { company: coA, kind: 'xml', name: 'xmls.zip' }, zip(files))
  assert.equal(up.status, 200, JSON.stringify(up.body))
  const s = up.body.batch.summary
  assert.deepEqual([s.vendas, s.compras, s.canceladas, s.repetidas, s.invalidas, s.clientes_novos, s.fornecedores_novos, s.produtos_novos], [2, 1, 2, 1, 1, 1, 1, 2])
  const job = await waitJob((await call('POST', `/api/platform/migration/batches/${up.body.batch.id}/commit`, { token: AGENT, body: {} })).body.jobId)
  assert.equal(job.status, 'ok', JSON.stringify(job))
  assert.deepEqual([job.result.vendas, job.result.clientes, job.result.fornecedores, job.result.produtos, job.result.custos_atualizados], [2, 1, 1, 2, 1])
  const sales = (await db.query(`SELECT s.total, s.created_at, s.external_id, s.origin_type, c.name AS customer, (SELECT count(*)::int FROM sale_items i WHERE i.sale_id = s.id) AS n FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.company_id = $1 AND s.origin_type = 'migracao' ORDER BY s.created_at`, [coA])).rows
  assert.equal(sales.length, 2); assert.equal(Number(sales[0].total), 360); assert.equal(sales[0].customer, 'Carla Compradora'); assert.equal(sales[0].n, 2); assert.equal(sales[0].external_id, 'nfe:' + k1)
  assert.equal(new Date(sales[0].created_at).toISOString(), '2026-03-10T13:00:00.000Z', 'data original da nota')
  const v = (await db.query(`SELECT v.cost_price, p.sale_price, p.name FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.company_id = $1 AND v.barcode = $2`, [coA, e1])).rows[0]
  assert.equal(Number(v.cost_price), 70, 'custo da última compra com o mesmo código de barras'); assert.equal(Number(v.sale_price), 160, 'último preço vendido'); assert.equal(v.name, 'Vestido Floral')
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM suppliers WHERE company_id = $1 AND cnpj = $2`, [coA, forn])).rows[0].n, 1)
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM stock_movements WHERE company_id = $1`, [coA])).rows[0].n, movesBefore, 'histórico não mexe no estoque')
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM receivables WHERE company_id = $1`, [coA])).rows[0].n, recBefore, 'nem no financeiro')
  // reenviar o mesmo .zip: as vendas já importadas aparecem como duplicadas
  const again = await upload(AGENT, { company: coA, kind: 'xml', name: 'xmls.zip' }, zip(files))
  assert.equal(again.body.batch.summary.duplicadas, 2); assert.equal(again.body.batch.summary.vendas, 0)
  await call('DELETE', `/api/platform/migration/batches/${again.body.batch.id}`, { token: AGENT })
  // desfazer remove histórico, clientes e produtos criados
  const u = await waitJob((await call('POST', `/api/platform/migration/batches/${up.body.batch.id}/undo`, { token: AGENT })).body.jobId)
  assert.equal(u.status, 'ok', JSON.stringify(u))
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM sales WHERE company_id = $1 AND origin_type = 'migracao'`, [coA])).rows[0].n, 0)
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM products WHERE company_id = $1 AND code LIKE 'NF-%'`, [coA])).rows[0].n, 0)
  // empresa sem CNPJ não consegue separar vendas de compras
  await db.query(`UPDATE companies SET cnpj = NULL WHERE id = $1`, [coB]); await db.query(`UPDATE branches SET cnpj = NULL WHERE company_id = $1`, [coB])
  assert.equal((await upload(AGENT, { company: coB, kind: 'xml', name: 'x.zip' }, zip(files))).status, 422)
})

test('sugestão de colunas por IA: só nomes de colunas e formato dos valores saem do sistema', async () => {
  assert.equal((await call('PUT', '/api/platform/ai/keys/anthropic', { token: OWNER, body: { key: 'sk-ant-teste-migracao-0000XYZ9' } })).status, 200)
  assert.equal((await call('PUT', '/api/platform/ai', { token: OWNER, body: { provider: 'anthropic' } })).status, 200)
  const up = await upload(AGENT, { company: coA, kind: 'clientes', name: 'erp-x.csv' }, 'Razao;Documento;Contato;Obs\nMariana Segredo Silva;529.982.247-25;mariana.segredo@ex.com;cliente vip\n')
  assert.equal(up.status, 200)
  const r = await call('POST', `/api/platform/migration/batches/${up.body.batch.id}/ai-mapping`, { token: AGENT })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.mapping.nome, 'Razao'); assert.equal(r.body.mapping.cpf_cnpj, 'Documento'); assert.equal(r.body.mapping.email, 'Contato'); assert.equal(r.body.mapping.telefone, null, 'coluna inventada é descartada')
  const sent = JSON.stringify(seen)
  for (const secret of ['Mariana', 'Segredo', '52998224725', '529.982', 'mariana.segredo', 'vip']) assert.ok(!sent.includes(secret), `não pode enviar "${secret}" ao provedor`)
  assert.match(sent, /999\.999\.999-99/)
  const pm = await call('PUT', `/api/platform/migration/batches/${up.body.batch.id}/mapping`, { token: AGENT, body: { mapping: r.body.mapping } })
  assert.equal(pm.status, 200); assert.equal(pm.body.preview.summary.existentes, 1)
  // perfil salvo reaplica o mapeamento no próximo arquivo do mesmo ERP
  const prof = await call('POST', '/api/platform/migration/profiles', { token: AGENT, body: { name: 'ERP X', kind: 'clientes', mapping: r.body.mapping } })
  assert.equal(prof.status, 200)
  const up2 = await upload(AGENT, { company: coA, kind: 'clientes', name: 'erp-x-2.csv', profile: prof.body.id }, 'Razao;Documento;Contato\nZé;;\n')
  assert.equal(up2.body.batch.mapping.email, 'Contato')
})
