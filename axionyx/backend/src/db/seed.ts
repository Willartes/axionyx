/**
 * Carga inicial.
 *   npm run seed        -> cria a primeira empresa e o superadministrador (dados reais, informados por variáveis de ambiente)
 *   npm run seed:demo   -> cria uma EMPRESA DE DEMONSTRAÇÃO (is_demo = true) com dados fictícios para validar os fluxos
 *
 * Nenhuma senha é fixa no código: use ADMIN_PASSWORD / DEMO_PASSWORD ou deixe gerar uma senha aleatória (exibida uma única vez).
 */
import { pool, tx, Q, nextNumber } from '../core/db'
import { migrate } from './migrate'
import { hashPassword, randomCode } from '../core/crypto'
import { bootstrapCompany } from '../services/bootstrap'
import { onlyDigits, isValidCNPJ, gtinCheckDigit } from '../core/validate'
import { createSale, cancelSale, registerReturn, Actor } from '../services/sales'
import { moveStock } from '../services/stock'
import { payTitle } from '../services/finance'
import { r2 } from '../core/http'

const genPassword = () => `Ax-${randomCode(5)}-${randomCode(5)}-${Math.floor(Math.random() * 90 + 10)}`

async function seedBase() {
  const email = process.env.ADMIN_EMAIL, name = process.env.ADMIN_NAME || 'Administrador'
  const companyName = process.env.COMPANY_NAME, cnpj = process.env.COMPANY_CNPJ
  if (!email || !companyName) throw new Error('Defina ADMIN_EMAIL e COMPANY_NAME (opcionais: ADMIN_NAME, ADMIN_PASSWORD, COMPANY_CNPJ, BRANCH_NAME).')
  if (cnpj && !isValidCNPJ(cnpj)) throw new Error('COMPANY_CNPJ inválido.')
  const password = process.env.ADMIN_PASSWORD || genPassword()
  await tx(async (c) => {
    const exists = await c.one(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email])
    if (exists) throw new Error('Usuário já existe; seed base já executado?')
    const r = await bootstrapCompany(c, { name: companyName, cnpj: cnpj ? onlyDigits(cnpj) : null, branch: { code: '001', name: process.env.BRANCH_NAME || 'Matriz', cnpj: cnpj ? onlyDigits(cnpj) : null } })
    const u = await c.one(`INSERT INTO users(name, email, password_hash, is_superadmin, platform_owner) VALUES ($1,$2,$3,true,true) RETURNING id`, [name, email, hashPassword(password)])
    await c.query(`INSERT INTO user_companies(user_id, company_id, role_id, all_branches) VALUES ($1,$2,$3,true)`, [u.id, r.company.id, r.roles['Administrador']])
  })
  console.log(`\n✔ Empresa "${companyName}" criada.\n  Login: ${email}\n  Senha: ${process.env.ADMIN_PASSWORD ? '(a definida em ADMIN_PASSWORD)' : password}\n  Ative o MFA em Configurações > Segurança após o primeiro acesso.\n`)
}

// ----------------- DEMONSTRAÇÃO -----------------
let seed = 20261024
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]
const between = (a: number, b: number) => Math.floor(a + rnd() * (b - a + 1))

async function shiftSale(c: Q, saleId: string, days: number, hour: number) {
  const iv = `${days} days`
  await c.query(`UPDATE sales SET created_at = date_trunc('day', now()) - $2::interval + ($3 || ' hours')::interval WHERE id = $1`, [saleId, iv, String(hour)])
  await c.query(`UPDATE stock_movements SET created_at = created_at - $2::interval WHERE ref_type = 'sale' AND ref_id = $1`, [saleId, iv])
  await c.query(`UPDATE financial_transactions SET date = date - $2::interval, created_at = created_at - $2::interval WHERE sale_id = $1`, [saleId, iv])
  await c.query(`UPDATE receivables SET issue_date = issue_date - $2::interval, due_date = due_date - $2::interval, created_at = created_at - $2::interval WHERE sale_id = $1`, [saleId, iv])
  await c.query(`UPDATE commissions SET created_at = created_at - $2::interval, competence = date_trunc('month', now() - $2::interval)::date WHERE sale_id = $1`, [saleId, iv])
  await c.query(`UPDATE loyalty_ledger SET created_at = created_at - $2::interval, expires_at = expires_at - $2::interval WHERE source_id = $1`, [saleId, iv])
  await c.query(`UPDATE cash_movements SET created_at = created_at - $2::interval WHERE ref_id = $1`, [saleId, iv])
  await c.query(`UPDATE audit_log SET created_at = created_at - $2::interval WHERE entity = 'sale' AND entity_id = $1::text`, [saleId, iv])
}

async function seedDemo() {
  const password = process.env.DEMO_PASSWORD || genPassword()
  const adminEmail = process.env.DEMO_ADMIN_EMAIL || 'admin@demo.axionyx.local'
  const t0 = Date.now()
  const ctxIds = await tx(async (c) => {
    if (await c.one(`SELECT 1 FROM companies WHERE is_demo AND name LIKE 'Moda Viva%'`)) throw new Error('A empresa de demonstração já existe.')
    const address = { logradouro: 'Rua Augusta', numero: '1500', bairro: 'Consolação', cidade: 'São Paulo', uf: 'SP', cep: '01304001', codigoMunicipio: '3550308' }
    const r = await bootstrapCompany(c, { name: 'Moda Viva Comércio de Vestuário Ltda (DEMONSTRAÇÃO)', tradeName: 'Moda Viva — Demo', cnpj: '11222333000181', ie: '110042490114',
      taxRegime: 'simples', crt: 1, address, isDemo: true, color: '#C2185B', branch: { code: '001', name: 'Loja Centro', cnpj: '11222333000181', ie: '110042490114', address } })
    const co = r.company.id, b1 = r.branch.id
    const b2 = (await c.one(`INSERT INTO branches(company_id, code, name, cnpj, address) VALUES ($1,'002','Loja Shopping Norte',$2,$3) RETURNING id`, [co, '11222333000262', JSON.stringify({ ...address, logradouro: 'Av. Otto Baumgart', numero: '500', bairro: 'Vila Guilherme', cep: '02049000' })])).id
    const caixa2 = await c.one(`INSERT INTO financial_accounts(company_id, branch_id, name, type) VALUES ($1,$2,'Caixa Loja Shopping Norte','caixa') RETURNING id`, [co, b2])
    await c.query(`INSERT INTO cash_registers(company_id, branch_id, name, account_id) VALUES ($1,$2,'Caixa 01',$3)`, [co, b2, caixa2.id])
    await c.query(`UPDATE financial_accounts SET opening_balance = 45000 WHERE id = $1`, [r.accounts.banco])
    const ph = hashPassword(password)
    const mk = async (name: string, email: string, role: string, opts: { all?: boolean; branches?: string[]; seller?: boolean; pct?: number } = {}) => {
      const u = await c.one(`INSERT INTO users(name, email, password_hash) VALUES ($1,$2,$3) RETURNING id`, [name, email, ph])
      await c.query(`INSERT INTO user_companies(user_id, company_id, role_id, all_branches, is_seller, commission_pct) VALUES ($1,$2,$3,$4,$5,$6)`, [u.id, co, r.roles[role], !!opts.all, !!opts.seller, opts.pct ?? null])
      for (const b of opts.branches ?? []) await c.query(`INSERT INTO user_branches(user_id, company_id, branch_id) VALUES ($1,$2,$3)`, [u.id, co, b])
      if (role !== 'Administrador') await c.query(`INSERT INTO employees(company_id, branch_id, user_id, name, email, job_title, department, admission_date, salary, status) VALUES ($1,$2,$3,$4,$5,$6,$7,current_date - $8::int,$9,'Ativo')`,
        [co, (opts.branches ?? [b1])[0], u.id, name, email, role === 'Vendedor' ? 'Consultora de Moda' : role, role === 'Vendedor' ? 'Vendas' : role === 'Financeiro' ? 'Financeiro' : 'Gestão', between(200, 1500), role === 'Vendedor' ? 1800 : role === 'Financeiro' ? 2600 : 3200])
      return u.id as string
    }
    const admin = await mk('Admin Demonstração', adminEmail, 'Administrador', { all: true })
    const gerente = await mk('Carla Gerente (demo)', 'gerente@demo.axionyx.local', 'Gerente de Loja', { all: true })
    const v1 = await mk('Júlia Vendedora (demo)', 'julia@demo.axionyx.local', 'Vendedor', { branches: [b1], seller: true, pct: 4 })
    const v2 = await mk('Rafael Vendedor (demo)', 'rafael@demo.axionyx.local', 'Vendedor', { branches: [b1], seller: true })
    const v3 = await mk('Bianca Vendedora (demo)', 'bianca@demo.axionyx.local', 'Vendedor', { branches: [b2], seller: true })
    await mk('Marcos Financeiro (demo)', 'financeiro@demo.axionyx.local', 'Financeiro', { all: true })
    await c.query(`UPDATE companies SET settings = $2 WHERE id = $1`, [co, JSON.stringify({ vendas: { exigirCaixaAberto: true }, fidelidade: { cashbackPct: 5, validadeDias: 120 } })])
    return { co, b1, b2, admin, gerente, sellers1: [v1, v2], sellers2: [v3], accounts: r.accounts }
  })
  const { co, b1, b2, admin } = ctxIds
  const actor = (branchId: string, userId = admin): Actor => ({ companyId: co, branchId, userId, userName: 'seed', permissions: new Set(['vendas.desconto_extra']), isSuperadmin: true, maxDiscountPct: 100 })

  // ---------- catálogo ----------
  const cat = await tx(async (c) => {
    const ins = async (table: string, cols: string[], rows: any[][]) => {
      const out: Record<string, string> = {}
      for (const row of rows) {
        const ins = await c.one(`INSERT INTO ${table}(company_id, ${cols.join(',')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(',')}) ON CONFLICT DO NOTHING RETURNING id`, [co, ...row])
        out[row[0]] = ins?.id ?? (await c.one(`SELECT id FROM ${table} WHERE company_id = $1 AND ${cols[0]} = $2`, [co, row[0]])).id
      }
      return out
    }
    const brands = await ins('brands', ['name'], [['Aurora Basics'], ['Linha Urbana'], ['Mar Azul Beachwear'], ['Vértice Jeans'], ['Bossa Feminina']])
    const collections = await ins('collections', ['name', 'season', 'year'], [['Verão 2026', 'Verão', 2026], ['Inverno 2026', 'Inverno', 2026], ['Primavera-Verão 2027', 'Primavera-Verão', 2027]])
    const categories = await ins('categories', ['name'], [['Camisetas'], ['Blusas'], ['Vestidos'], ['Calças'], ['Bermudas'], ['Saias'], ['Jaquetas'], ['Moda Praia'], ['Acessórios']])
    const colors = await ins('colors', ['name', 'code', 'hex'], [['Preto', 'PRE', '#111111'], ['Branco', 'BRA', '#FFFFFF'], ['Azul Marinho', 'MAR', '#1B2A4A'], ['Off-White', 'OFF', '#F3EFE6'],
      ['Verde Oliva', 'OLI', '#5B6236'], ['Vermelho', 'VER', '#B3261E'], ['Bege', 'BEG', '#D8C3A5'], ['Jeans Claro', 'JCL', '#8FB3D9'], ['Jeans Escuro', 'JES', '#2C3E66'], ['Rosa', 'ROS', '#E8A0B4']])
    const sizes = Object.fromEntries((await c.many(`SELECT id, grid || ':' || code AS k FROM sizes WHERE company_id = $1`, [co])).map((s) => [s.k, s.id]))
    await c.query(`INSERT INTO commission_rules(company_id, name, scope, ref_id, pct, priority) VALUES ($1,'Moda praia (giro de estação)','categoria',$2,5,10)`, [co, categories['Moda Praia']])
    const sup = async (name: string, cnpj: string) => (await c.one(`INSERT INTO suppliers(company_id, name, cnpj) VALUES ($1,$2,$3) RETURNING id`, [co, name, cnpj])).id
    const suppliers = [await sup('Confecções Horizonte Ltda (fictício)', '04252011000110'), await sup('Tecelagem Vale Azul S.A. (fictício)', '60701190000104'), await sup('Atacado Jeans Brasil Ltda (fictício)', '33000167000101')]
    return { brands, collections, categories, colors, sizes, suppliers }
  })
  const P: [string, string, string, string, string, string[], string[], number, number, string][] = [
    // code, name, brand, category, collection, colors, sizes(grid:codes), cost, price, ncm
    ['CAM-001', 'Camiseta Básica Algodão', 'Aurora Basics', 'Camisetas', 'Verão 2026', ['Preto', 'Branco', 'Azul Marinho'], ['Adulto:P', 'Adulto:M', 'Adulto:G', 'Adulto:GG'], 22, 59.9, '61091000'],
    ['CAM-002', 'Camiseta Gola V Premium', 'Aurora Basics', 'Camisetas', 'Primavera-Verão 2027', ['Off-White', 'Verde Oliva'], ['Adulto:P', 'Adulto:M', 'Adulto:G'], 28, 79.9, '61091000'],
    ['CAM-003', 'Camiseta Estampada Urbana', 'Linha Urbana', 'Camisetas', 'Verão 2026', ['Preto', 'Branco'], ['Adulto:P', 'Adulto:M', 'Adulto:G', 'Adulto:GG'], 31, 89.9, '61091000'],
    ['BLU-001', 'Blusa Viscose Manga Curta', 'Bossa Feminina', 'Blusas', 'Verão 2026', ['Rosa', 'Off-White', 'Vermelho'], ['Adulto:PP', 'Adulto:P', 'Adulto:M', 'Adulto:G'], 35, 109.9, '62064000'],
    ['BLU-002', 'Camisa Linho Feminina', 'Bossa Feminina', 'Blusas', 'Primavera-Verão 2027', ['Branco', 'Bege'], ['Adulto:P', 'Adulto:M', 'Adulto:G'], 58, 169.9, '62061000'],
    ['VES-001', 'Vestido Midi Floral', 'Bossa Feminina', 'Vestidos', 'Verão 2026', ['Rosa', 'Azul Marinho'], ['Adulto:PP', 'Adulto:P', 'Adulto:M', 'Adulto:G'], 72, 219.9, '62044300'],
    ['VES-002', 'Vestido Tubinho Malha', 'Aurora Basics', 'Vestidos', 'Inverno 2026', ['Preto', 'Vermelho'], ['Adulto:P', 'Adulto:M', 'Adulto:G'], 48, 149.9, '61044300'],
    ['CAL-001', 'Calça Jeans Skinny', 'Vértice Jeans', 'Calças', 'Inverno 2026', ['Jeans Claro', 'Jeans Escuro'], ['Numérica:36', 'Numérica:38', 'Numérica:40', 'Numérica:42', 'Numérica:44'], 65, 199.9, '62046200'],
    ['CAL-002', 'Calça Jeans Reta Masculina', 'Vértice Jeans', 'Calças', 'Inverno 2026', ['Jeans Escuro'], ['Numérica:38', 'Numérica:40', 'Numérica:42', 'Numérica:44', 'Numérica:46'], 70, 219.9, '62034200'],
    ['CAL-003', 'Calça Alfaiataria Wide Leg', 'Bossa Feminina', 'Calças', 'Primavera-Verão 2027', ['Preto', 'Bege'], ['Numérica:36', 'Numérica:38', 'Numérica:40', 'Numérica:42'], 62, 189.9, '62046300'],
    ['BER-001', 'Bermuda Sarja Masculina', 'Linha Urbana', 'Bermudas', 'Verão 2026', ['Bege', 'Azul Marinho', 'Verde Oliva'], ['Numérica:38', 'Numérica:40', 'Numérica:42', 'Numérica:44'], 39, 119.9, '62034300'],
    ['SAI-001', 'Saia Midi Plissada', 'Bossa Feminina', 'Saias', 'Primavera-Verão 2027', ['Preto', 'Rosa'], ['Adulto:P', 'Adulto:M', 'Adulto:G'], 44, 139.9, '62045300'],
    ['JAQ-001', 'Jaqueta Jeans Oversized', 'Vértice Jeans', 'Jaquetas', 'Inverno 2026', ['Jeans Claro'], ['Adulto:P', 'Adulto:M', 'Adulto:G', 'Adulto:GG'], 95, 279.9, '62023900'],
    ['JAQ-002', 'Jaqueta Corta-vento', 'Linha Urbana', 'Jaquetas', 'Inverno 2026', ['Preto', 'Verde Oliva'], ['Adulto:M', 'Adulto:G', 'Adulto:GG'], 88, 249.9, '62019300'],
    ['PRA-001', 'Biquíni Cortininha', 'Mar Azul Beachwear', 'Moda Praia', 'Verão 2026', ['Preto', 'Vermelho', 'Rosa'], ['Adulto:P', 'Adulto:M', 'Adulto:G'], 34, 129.9, '61124100'],
    ['PRA-002', 'Maiô Decote Profundo', 'Mar Azul Beachwear', 'Moda Praia', 'Verão 2026', ['Preto', 'Azul Marinho'], ['Adulto:P', 'Adulto:M', 'Adulto:G'], 52, 189.9, '61124100'],
    ['PRA-003', 'Short Praia Masculino', 'Mar Azul Beachwear', 'Moda Praia', 'Verão 2026', ['Azul Marinho', 'Verde Oliva'], ['Adulto:P', 'Adulto:M', 'Adulto:G', 'Adulto:GG'], 29, 99.9, '62031900'],
    ['ACE-001', 'Cinto Couro Fivela Dourada', 'Bossa Feminina', 'Acessórios', 'Inverno 2026', ['Preto', 'Bege'], ['Único:U'], 25, 79.9, '42033000'],
    ['ACE-002', 'Bolsa Tiracolo Matelassê', 'Bossa Feminina', 'Acessórios', 'Primavera-Verão 2027', ['Preto', 'Off-White'], ['Único:U'], 68, 199.9, '42022200'],
  ]
  const COLOR_CODES: Record<string, string> = { 'Preto': 'PRE', 'Branco': 'BRA', 'Azul Marinho': 'MAR', 'Off-White': 'OFF', 'Verde Oliva': 'OLI', 'Vermelho': 'VER', 'Bege': 'BEG', 'Jeans Claro': 'JCL', 'Jeans Escuro': 'JES', 'Rosa': 'ROS' }
  const variantsBy: { id: string; price: number; cost: number; cat: string }[] = []
  await tx(async (c) => {
    for (const [code, name, brand, category, coll, colors, sizes, cost, price, ncm] of P) {
      const p = await c.one(`INSERT INTO products(company_id, code, name, brand_id, category_id, collection_id, supplier_id, ncm, cost_price, sale_price, min_stock, created_by, gender)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [co, code, name, cat.brands[brand], cat.categories[category], cat.collections[coll], pick(cat.suppliers), ncm, cost, price, 2, admin, /Masculin|Bermuda|Short/.test(name) ? 'Masculino' : /Feminin|Vestido|Saia|Blusa|Biquíni|Maiô|Bolsa/.test(name) ? 'Feminino' : 'Unissex'])
      for (const color of colors) for (const s of sizes) {
        const n = await nextNumber(c, co, 'ean_interno')
        const body = '2' + String(n).padStart(11, '0')
        const v = await c.one(`INSERT INTO product_variants(company_id, product_id, size_id, color_id, sku, barcode) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [co, p.id, cat.sizes[s], cat.colors[color], `${code}-${COLOR_CODES[color]}-${s.split(':')[1]}`, body + gtinCheckDigit(body)])
        variantsBy.push({ id: v.id, price, cost, cat: category })
      }
    }
  })
  // ---------- estoque inicial via entradas de compra (há ~200 dias) ----------
  for (const [branch, factor] of [[b1, 1], [b2, 0.6]] as [string, number][]) {
    await tx(async (c) => {
      const number = await nextNumber(c, co, 'entrada')
      const total = r2(variantsBy.reduce((s, v) => s + v.cost * Math.max(2, Math.round(between(6, 14) * factor)), 0))
      const e = await c.one(`INSERT INTO purchase_entries(company_id, branch_id, number, supplier_id, source, nfe_number, issue_date, total_products, total, status, created_by, confirmed_by, confirmed_at, created_at)
                             VALUES ($1,$2,$3,$4,'manual',$5,current_date - 200,$6,$6,'confirmada',$7,$7,now() - interval '200 days', now() - interval '200 days') RETURNING id`, [co, branch, number, cat.suppliers[0], String(4500 + number), total, admin])
      let line = 0
      for (const v of variantsBy) {
        const qty = Math.max(2, Math.round(between(6, 14) * factor))
        await c.query(`INSERT INTO purchase_entry_items(entry_id, line, variant_id, description, qty, unit_cost, total, match_status) VALUES ($1,$2,$3,'Carga inicial (demo)',$4,$5,$6,'vinculado')`, [e.id, ++line, v.id, qty, v.cost, r2(qty * v.cost)])
        await moveStock(c, { companyId: co, branchId: branch, variantId: v.id, qty, type: 'compra', refType: 'purchase_entry', refId: e.id, unitCost: v.cost, userId: admin, notes: `Entrada nº ${number} (demo)` })
      }
      await c.query(`UPDATE stock_movements SET created_at = now() - interval '200 days' WHERE ref_id = $1`, [e.id])
      for (let i = 0; i < 3; i++) {
        await c.query(`INSERT INTO payables(company_id, branch_id, supplier_id, source_type, source_id, document, installment_no, installments_total, category_id, due_date, amount, paid_amount, status, paid_at, created_by)
                       VALUES ($1,$2,$3,'purchase_entry',$4,$5,$6,3,(SELECT id FROM financial_categories WHERE company_id = $1 AND system_key = 'compra_mercadoria'),current_date - 200 + 30 * $6,$7,$7,'pago',now(),$8)`,
          [co, branch, cat.suppliers[0], e.id, `NF ${4500 + number}`, i + 1, r2(total / 3), admin])
      }
    })
  }
  // ---------- clientes ----------
  const first = ['Ana', 'Beatriz', 'Camila', 'Daniela', 'Eduarda', 'Fernanda', 'Gabriela', 'Helena', 'Isabela', 'Juliana', 'Larissa', 'Mariana', 'Natália', 'Patrícia', 'Renata', 'Sofia', 'Tatiane', 'Vanessa', 'Bruno', 'Carlos', 'Diego', 'Felipe', 'Gustavo', 'Lucas', 'Mateus', 'Pedro', 'Rodrigo', 'Thiago']
  const last = ['Silva', 'Souza', 'Oliveira', 'Santos', 'Lima', 'Pereira', 'Costa', 'Almeida', 'Ribeiro', 'Carvalho', 'Gomes', 'Martins', 'Rocha', 'Barbosa']
  const customers: string[] = []
  await tx(async (c) => {
    for (let i = 0; i < 48; i++) {
      const code = await nextNumber(c, co, 'cliente')
      const name = `${pick(first)} ${pick(last)} ${pick(last)}`
      const birth = `${between(1965, 2004)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`
      const cu = await c.one(`INSERT INTO customers(company_id, code, name, email, whatsapp, birth_date, credit_limit, preferences, tags, address, created_at)
                              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() - ($11 || ' days')::interval) RETURNING id`,
        [co, code, name, `cliente${code}@exemplo.invalid`, `119${String(between(10000000, 99999999))}`, birth, i % 2 === 0 ? pick([500, 800, 1200, 2000]) : 0,
          JSON.stringify({ tamanhos: { superior: pick(['P', 'M', 'G']), inferior: pick(['36', '38', '40', '42']), calcado: pick(['35', '36', '37', '38']) }, marcas: [pick(['Bossa Feminina', 'Aurora Basics', 'Vértice Jeans'])], estilos: [pick(['Casual', 'Clássico', 'Praia', 'Urbano'])], cores: [], observacoes: '' }),
          i % 7 === 0 ? ['vip'] : [], JSON.stringify({ cidade: 'São Paulo', uf: 'SP' }), String(between(200, 400))])
      if (i % 4 !== 3) await c.query(`INSERT INTO customer_consents(company_id, customer_id, channel, granted, source, user_id) VALUES ($1,$2,'whatsapp',true,'loja',$3), ($1,$2,'preferencias',true,'loja',$3)`, [co, cu.id, admin])
      customers.push(cu.id)
    }
    await c.query(`UPDATE customers SET is_partner = true, name = 'Revendedora Luana Prado (demo)', credit_limit = 3000 WHERE id = $1`, [customers[0]])
  })
  // ---------- vendas históricas (180 dias) usando o serviço real ----------
  const methods = Object.fromEntries((await pool.query(`SELECT kind, id FROM payment_methods WHERE company_id = $1`, [co])).rows.map((r: any) => [r.kind, r.id]))
  for (const [branch, regs] of [[b1, null], [b2, null]] as [string, null][]) {
    void regs
    const reg = (await pool.query(`SELECT id FROM cash_registers WHERE branch_id = $1 LIMIT 1`, [branch])).rows[0]
    await pool.query(`INSERT INTO cash_sessions(company_id, branch_id, register_id, opened_by, opening_amount, opened_at) VALUES ($1,$2,$3,$4,200, now() - interval '181 days')`, [co, branch, reg.id, admin])
  }
  let created = 0
  const saleIds: { id: string; days: number; branch: string; kinds: string[] }[] = []
  for (let day = 180; day >= 0; day--) {
    const weekday = new Date(Date.now() - day * 86400000).getDay()
    const n = weekday === 0 ? between(0, 2) : weekday === 6 ? between(3, 6) : between(1, 4)
    for (let k = 0; k < n; k++) {
      const branch = rnd() < 0.62 ? b1 : b2
      const seller = branch === b1 ? pick(ctxIds.sellers1) : pick(ctxIds.sellers2)
      const items: { variantId: string; qty: number }[] = []
      const nItems = between(1, 4)
      const seasonal = day > 120 ? ['Moda Praia', 'Camisetas', 'Bermudas', 'Vestidos'] : day > 40 ? ['Calças', 'Jaquetas', 'Blusas', 'Vestidos'] : ['Blusas', 'Saias', 'Calças', 'Acessórios', 'Camisetas']
      for (let j = 0; j < nItems; j++) {
        const pool2 = rnd() < 0.7 ? variantsBy.filter((v) => seasonal.includes(v.cat)) : variantsBy
        const v = pick(pool2)
        if (!items.find((i) => i.variantId === v.id)) items.push({ variantId: v.id, qty: rnd() < 0.85 ? 1 : 2 })
      }
      const total = items.reduce((s, i) => s + i.qty * variantsBy.find((v) => v.id === i.variantId)!.price, 0)
      const discount = rnd() < 0.25 ? r2(total * pick([0.05, 0.1])) : 0
      const net = r2(total - discount)
      const customer = rnd() < 0.72 ? pick(customers.slice(1)) : null
      const roll = rnd()
      let payments: any[]
      let kinds: string[]
      if (roll < 0.18) { payments = [{ methodId: methods.dinheiro, amount: Math.ceil(net / 10) * 10 }]; kinds = ['dinheiro'] }
      else if (roll < 0.42) { payments = [{ methodId: methods.pix, amount: net }]; kinds = ['pix'] }
      else if (roll < 0.58) { payments = [{ methodId: methods.debito, amount: net }]; kinds = ['debito'] }
      else if (roll < 0.80) { payments = [{ methodId: methods.credito, amount: net, installments: net > 300 ? pick([2, 3, 4]) : 1 }]; kinds = ['credito'] }
      else if (customer && roll < 0.94) {
        const lim = (await pool.query(`SELECT credit_limit FROM customers WHERE id = $1`, [customer])).rows[0]
        if (Number(lim.credit_limit) >= net) { payments = [{ methodId: methods.crediario, amount: net, installments: pick([2, 3, 4]) }]; kinds = ['crediario'] }
        else { payments = [{ methodId: methods.pix, amount: net }]; kinds = ['pix'] }
      } else { const half = r2(net / 2); payments = [{ methodId: methods.pix, amount: half }, { methodId: methods.credito, amount: r2(net - half), installments: 1 }]; kinds = ['pix', 'credito'] }
      try {
        const sale = await tx(async (c) => {
          const s = await createSale(c, actor(branch, seller), { customerId: customer, sellerId: seller, items, discountTotal: discount, payments })
          await shiftSale(c, s.id, day, between(10, 20))
          return s
        })
        saleIds.push({ id: sale.id, days: day, branch, kinds }); created++
      } catch (e: any) { if (!/Estoque insuficiente|Limite de crediário|Parcela mínima/.test(e.message)) throw e }
    }
    // reposição mensal de estoque (compras recorrentes)
    if (day % 30 === 15) {
      await tx(async (c) => {
        for (const branch of [b1, b2]) for (const v of variantsBy) {
          const bal = (await c.one(`SELECT COALESCE(qty,0) AS q FROM stock_balances WHERE branch_id = $1 AND variant_id = $2`, [branch, v.id]))?.q ?? 0
          if (bal < 4) {
            await moveStock(c, { companyId: co, branchId: branch, variantId: v.id, qty: between(5, 10), type: 'compra', refType: 'reposicao_demo', unitCost: v.cost, userId: admin, notes: 'Reposição (demo)' })
          }
        }
        await c.query(`UPDATE stock_movements SET created_at = now() - ($2 || ' days')::interval WHERE company_id = $1 AND ref_type = 'reposicao_demo' AND created_at > now() - interval '1 minute'`, [co, String(day)])
      })
    }
  }
  // ---------- crediário/cartões passados: liquidações realistas ----------
  await tx(async (c) => {
    const due = await c.many(`SELECT id, method_kind, amount, fee_amount, due_date, (amount + interest + fine - discount - paid_amount) AS balance FROM receivables WHERE company_id = $1 AND status = 'aberto' AND due_date < current_date ORDER BY due_date`, [co])
    let k = 0
    for (const t of due) {
      if (t.method_kind === 'crediario' && ++k % 8 === 0) continue // deixa parte do crediário em atraso (inadimplência)
      if (t.method_kind === 'cartao_credito' || t.method_kind === 'cartao_debito') {
        await payTitle(c, 'receber', co, t.id, { amount: r2(Number(t.balance) - Number(t.fee_amount)), discount: Number(t.fee_amount), date: t.due_date, method: 'liquidacao_cartao' }, { id: admin })
      } else {
        await payTitle(c, 'receber', co, t.id, { amount: Number(t.balance), date: t.due_date, method: 'pix' }, { id: admin })
      }
    }
    await c.query(`UPDATE financial_transactions SET created_at = date::timestamptz WHERE company_id = $1 AND source_type = 'title_payment'`, [co])
  })
  // ---------- despesas recorrentes ----------
  await tx(async (c) => {
    const exp: [string, number, string][] = [['aluguel', 3200, 'Aluguel Loja Centro'], ['aluguel', 4300, 'Aluguel Shopping Norte'], ['salarios', 11200, 'Folha de pagamento'], ['utilidades', 640, 'Energia e internet'], ['marketing', 600, 'Anúncios e redes sociais'], ['servicos', 390, 'Sistemas e contabilidade']]
    for (let m = 6; m >= -1; m--) {
      for (const [key, amount, desc] of exp) {
        const paid = m >= 0
        await c.query(`INSERT INTO payables(company_id, branch_id, source_type, document, category_id, due_date, amount, paid_amount, status, description, created_by, paid_at)
                       VALUES ($1,$2,'manual',$3,(SELECT id FROM financial_categories WHERE company_id = $1 AND system_key = $4),(date_trunc('month', current_date) - ($5 || ' months')::interval + interval '9 days')::date,$6,$7,$8,$9,$10,$11)`,
          [co, b1, `DESP-${key.toUpperCase()}`, key, String(m), amount, paid ? amount : 0, paid ? 'pago' : 'aberto', desc, admin, paid ? new Date() : null])
      }
    }
    const bank = ctxIds.accounts.banco
    const paidRows = await c.many(`SELECT id, amount, due_date, description, category_id FROM payables WHERE company_id = $1 AND source_type = 'manual' AND status = 'pago'`, [co])
    for (const p of paidRows) await c.query(`INSERT INTO financial_transactions(company_id, account_id, direction, amount, date, description, category_id, payable_id, source_type, source_id) VALUES ($1,$2,'saida',$3,$4,$5,$6,$7,'seed_despesa',$7)`,
      [co, bank, p.amount, p.due_date, p.description, p.category_id, p.id])
  })
  // ---------- repasses mensais: adquirente e depósitos do caixa vão para o banco ----------
  await tx(async (c) => {
    const bank = ctxIds.accounts.banco
    const others = await c.many(`SELECT id, type FROM financial_accounts WHERE company_id = $1 AND type IN ('adquirente','caixa')`, [co])
    for (let m = 6; m >= 1; m--) {
      const d = (await c.one(`SELECT (date_trunc('month', current_date) - ($1 || ' months')::interval + interval '1 month' - interval '1 day')::date AS d`, [String(m)])).d
      for (const a of others) {
        const bal = Number((await c.one(`SELECT a.opening_balance + COALESCE((SELECT sum(CASE WHEN direction='entrada' THEN amount ELSE -amount END) FROM financial_transactions WHERE account_id = a.id AND date <= $2),0) AS b FROM financial_accounts a WHERE a.id = $1`, [a.id, d])).b)
        const amount = r2(a.type === 'caixa' ? bal - 500 : bal)
        if (amount < 100) continue
        const ref = (await c.one(`SELECT gen_random_uuid() AS id`)).id
        const desc = a.type === 'caixa' ? 'Depósito do caixa no banco (demo)' : 'Repasse da adquirente (demo)'
        await c.query(`INSERT INTO financial_transactions(company_id, account_id, direction, amount, date, description, source_type, source_id, source_seq, created_at) VALUES ($1,$2,'saida',$3,$4::date,$5,'transferencia',$6,1,$4::date::timestamptz), ($1,$7,'entrada',$3,$4::date,$5,'transferencia',$6,2,$4::date::timestamptz)`,
          [co, a.id, amount, d, desc, ref, bank])
      }
    }
  })
  // ---------- trocas, devolução e cancelamento ----------
  const recent = saleIds.filter((s) => s.days < 25 && s.days > 3)
  for (const s of recent.slice(0, 4)) {
    await tx(async (c) => {
      const it = await c.one(`SELECT id FROM sale_items WHERE sale_id = $1 ORDER BY line LIMIT 1`, [s.id])
      await registerReturn(c, actor(s.branch), { saleId: s.id, type: 'troca', refundMode: 'vale_troca', items: [{ saleItemId: it.id, qty: 1 }], reason: 'Troca de tamanho (demo)' })
    })
  }
  const cancelable = saleIds.find((x) => x.days === 0 && !x.kinds.includes('crediario'))
  if (cancelable) await tx((c) => cancelSale(c, actor(cancelable.branch), cancelable.id, 'Venda lançada em duplicidade (demo)'))
  // ---------- condicionais e consignação ----------
  await tx(async (c) => {
    const mkCond = async (customer: string, days: number, kind: string, dueOffset: number) => {
      const number = await nextNumber(c, co, 'condicional')
      const k = await c.one(`INSERT INTO conditionals(company_id, branch_id, number, kind, customer_id, responsible_id, seller_id, due_date, delivery, created_by, created_at)
                             VALUES ($1,$2,$3,$4,$5,$6,$6,current_date + $7::int,$8,$6, now() - ($9 || ' days')::interval) RETURNING *`,
        [co, b1, number, kind, customer, ctxIds.sellers1[0], dueOffset, JSON.stringify(kind === 'bag_delivery' ? { address: 'Rua das Flores, 120 — Pinheiros', fee: 15, scheduledAt: 'Sábado 10h' } : {}), String(days)])
      for (const v of [pick(variantsBy), pick(variantsBy), pick(variantsBy)]) {
        const bal = (await c.one(`SELECT qty FROM stock_balances WHERE branch_id = $1 AND variant_id = $2`, [b1, v.id]))?.qty ?? 0
        if (bal < 1) continue
        const ex = await c.one(`SELECT 1 FROM conditional_items WHERE conditional_id = $1 AND variant_id = $2`, [k.id, v.id])
        if (ex) continue
        await c.query(`INSERT INTO conditional_items(conditional_id, variant_id, qty_sent, unit_price) VALUES ($1,$2,1,$3)`, [k.id, v.id, v.price])
        await moveStock(c, { companyId: co, branchId: b1, variantId: v.id, qty: -1, type: 'condicional_saida', refType: 'conditional', refId: k.id, userId: admin, notes: `Condicional nº ${number}` })
      }
      await c.query(`INSERT INTO conditional_events(conditional_id, type, data, user_id) VALUES ($1,'criado','{}',$2)`, [k.id, admin])
    }
    await mkCond(customers[3], 1, 'condicional', 2)
    await mkCond(customers[5], 6, 'condicional', -2)
    await mkCond(customers[8], 0, 'bag_delivery', 3)
  })
  await tx(async (c) => {
    const number = await nextNumber(c, co, 'consignacao')
    const k = await c.one(`INSERT INTO consignments(company_id, branch_id, number, partner_id, due_date, commission_pct, created_by) VALUES ($1,$2,$3,$4,current_date + 20,25,$5) RETURNING *`, [co, b1, number, customers[0], admin])
    for (const v of variantsBy.filter((x) => ['Blusas', 'Vestidos', 'Saias'].includes(x.cat)).slice(0, 6)) {
      const bal = (await c.one(`SELECT qty FROM stock_balances WHERE branch_id = $1 AND variant_id = $2`, [b1, v.id]))?.qty ?? 0
      if (bal < 2) continue
      await c.query(`INSERT INTO consignment_items(consignment_id, variant_id, qty_sent, unit_price) VALUES ($1,$2,2,$3)`, [k.id, v.id, v.price])
      await moveStock(c, { companyId: co, branchId: b1, variantId: v.id, qty: -2, type: 'consignacao_saida', refType: 'consignment', refId: k.id, userId: admin, notes: `Consignação nº ${number}` })
    }
    await c.query(`INSERT INTO consignment_events(consignment_id, type, data, user_id) VALUES ($1,'remessa','{}',$2)`, [k.id, admin])
  })
  // ---------- metas, CRM, jurídico ----------
  await tx(async (c) => {
    for (const s of [...ctxIds.sellers1, ...ctxIds.sellers2]) await c.query(`INSERT INTO sales_goals(company_id, seller_id, month, target_amount, bonus_pct) VALUES ($1,$2,date_trunc('month', now())::date,$3,1)`, [co, s, pick([9000, 11000, 13000])])
    await c.query(`INSERT INTO sales_goals(company_id, month, target_amount) VALUES ($1, date_trunc('month', now())::date, 45000)`, [co])
    const st = ['Prospecção', 'Qualificação', 'Proposta', 'Negociação', 'Fechamento']
    for (const [t, val] of [['Uniformes equipe Clínica Bem-Estar (demo)', 8400], ['Kit presentes fim de ano — escritório (demo)', 5200], ['Revenda no interior — nova parceira (demo)', 12000], ['Coleção cápsula com influenciadora (demo)', 15000]] as [string, number][])
      await c.query(`INSERT INTO opportunities(company_id, title, value, probability, stage, owner_id) VALUES ($1,$2,$3,$4,$5,$6)`, [co, t, val, between(20, 80), pick(st), ctxIds.gerente])
    // precificação: custos fixos mensais e custo unitário de embalagem (fictícios, em escala com o faturamento do seed)
    for (const [cat, d, val] of [['ocupacao', 'Aluguel Loja Centro', 2200], ['ocupacao', 'Aluguel Shopping Norte', 2900], ['pessoal', 'Folha de pagamento e encargos', 4800],
      ['administrativo', 'Energia, água e internet', 420], ['comercial', 'Marketing e redes sociais', 350], ['administrativo', 'Sistemas e contabilidade', 290]] as [string, string, number][])
      await c.query(`INSERT INTO fixed_costs(company_id, category, description, monthly_amount, notes) VALUES ($1,$2,$3,$4,'Exemplo (empresa de demonstração)')`, [co, cat, d, val])
    await c.query(`INSERT INTO variable_costs(company_id, category, description, kind, value) VALUES ($1,'embalagem','Sacola, etiqueta e tag por peça (exemplo)','valor_unitario',1.80)`, [co])
    await c.query(`INSERT INTO legal_cases(company_id, number, title, kind, court, counterpart, risk, amount, next_deadline, lawyer) VALUES ($1,'0001234-56.2026.8.26.0100','Ação de cobrança — cliente inadimplente (demo)','Cível','TJSP — Foro Central','Cliente fictício','Baixo',1850.40,current_date + 12,'Escritório Exemplo Advogados')`, [co])
  })
  // fecha os caixas usados no histórico (o usuário abre um novo para operar)
  await pool.query(`UPDATE cash_sessions cs SET status = 'fechado', closed_by = $2, closed_at = now(), expected_amount = x.s, declared_amount = x.s, difference = 0
                      FROM (SELECT session_id, sum(amount) AS s FROM cash_movements GROUP BY session_id) x WHERE x.session_id = cs.id AND cs.company_id = $1 AND cs.status = 'aberto'`, [co, admin])
  await pool.query(`UPDATE cash_sessions SET status = 'fechado', closed_at = now() WHERE company_id = $1 AND status = 'aberto'`, [co])
  console.log(`\n✔ Empresa de DEMONSTRAÇÃO criada em ${Math.round((Date.now() - t0) / 1000)}s (${created} vendas fictícias).`)
  console.log(`  Todos os dados são fictícios e a empresa é marcada como demonstração no sistema.`)
  console.log(`  Usuários: ${adminEmail} (Administrador), gerente@, julia@, rafael@, bianca@, financeiro@demo.axionyx.local`)
  console.log(`  Senha de todos: ${process.env.DEMO_PASSWORD ? '(a definida em DEMO_PASSWORD)' : password}\n`)
}

if (require.main === module) {
  ;(async () => {
    await migrate(false)
    if (process.argv.includes('--demo')) await seedDemo()
    else await seedBase()
    await pool.end()
  })().catch(async (e) => { console.error('Falha no seed:', e.message); await pool.end(); process.exit(1) })
}
