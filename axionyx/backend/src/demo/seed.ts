import { pool, tx } from '../core/db'
import { hashPassword } from '../core/crypto'
import { bootstrapCompany } from '../services/bootstrap'
import { seedDemo, shiftSale } from '../db/seed'
import { demo } from './mode'

/**
 * Monta o ambiente de demonstração: uma empresa FICTÍCIA de cada segmento, todas marcadas como demonstração (faixa em
 * todas as telas), e a conta de demonstração com perfil Administrador em todas. Os dados são criados pela própria API
 * (mesmas regras do sistema) e depois "envelhecidos" para os painéis terem histórico.
 */
let seedN = 20261029
const rnd = () => { seedN = (seedN * 1664525 + 1013904223) % 4294967296; return seedN / 4294967296 }
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]
const between = (a: number, b: number) => Math.floor(a + rnd() * (b - a + 1))
const FIRST = ['Ana', 'Beatriz', 'Camila', 'Daniela', 'Eduarda', 'Fernanda', 'Helena', 'Isabela', 'Juliana', 'Larissa', 'Mariana', 'Patrícia', 'Renata', 'Sofia', 'Bruno', 'Carlos', 'Diego', 'Felipe', 'Gustavo', 'Lucas', 'Mateus', 'Pedro', 'Rodrigo', 'Thiago', 'Roberto', 'Paulo']
const LAST = ['Silva', 'Souza', 'Oliveira', 'Santos', 'Lima', 'Pereira', 'Costa', 'Almeida', 'Ribeiro', 'Carvalho', 'Gomes', 'Martins', 'Rocha', 'Barbosa']
const personName = () => `${pick(FIRST)} ${pick(LAST)}`

type Prod = [code: string, name: string, price: number, unit?: string, extra?: Record<string, unknown>]
interface Spec { segment: string; name: string; trade: string; color: string; products: Prod[]; services?: [string, number, number][]; pros?: { name: string; specialty?: string; council?: [string, string]; restrict?: boolean }[]; days: number }
const SPECS: Spec[] = [
  { segment: 'hortifruti', name: 'Quitanda Folha Verde (demonstração)', trade: 'Folha Verde — Demo', color: '#2E7D32', days: 60, products: [
    ['HF-001', 'Banana prata', 6.99, 'KG', { sale_by_weight: true }], ['HF-002', 'Maçã gala', 11.9, 'KG', { sale_by_weight: true }], ['HF-003', 'Tomate italiano', 9.49, 'KG', { sale_by_weight: true }],
    ['HF-004', 'Batata inglesa', 5.99, 'KG', { sale_by_weight: true }], ['HF-005', 'Alface crespa', 3.5, 'UN'], ['HF-006', 'Ovos brancos (dúzia)', 12.9, 'DZ'], ['HF-007', 'Mamão formosa', 7.9, 'KG', { sale_by_weight: true }], ['HF-008', 'Cebola', 6.49, 'KG', { sale_by_weight: true }]] },
  { segment: 'adega', name: 'Adega Vinhedo Real (demonstração)', trade: 'Vinhedo Real — Demo', color: '#6A1B4D', days: 60, products: [
    ['AD-001', 'Vinho tinto Malbec 750 ml', 89.9, 'UN', { age_restricted: true }], ['AD-002', 'Vinho branco Sauvignon Blanc 750 ml', 74.9, 'UN', { age_restricted: true }], ['AD-003', 'Espumante brut 750 ml', 69.9, 'UN', { age_restricted: true }],
    ['AD-004', 'Cerveja artesanal IPA 500 ml', 18.9, 'UN', { age_restricted: true }], ['AD-005', 'Gin nacional 750 ml', 119.9, 'UN', { age_restricted: true }], ['AD-006', 'Água tônica 350 ml', 5.9, 'UN'], ['AD-007', 'Taça de cristal', 39.9, 'UN']] },
  { segment: 'mercado', name: 'Mercadinho do Bairro (demonstração)', trade: 'Mercadinho — Demo', color: '#EF6C00', days: 60, products: [
    ['MC-001', 'Arroz tipo 1 5 kg', 27.9], ['MC-002', 'Feijão carioca 1 kg', 8.49], ['MC-003', 'Café torrado 500 g', 19.9], ['MC-004', 'Leite integral 1 L', 5.29], ['MC-005', 'Óleo de soja 900 ml', 7.99],
    ['MC-006', 'Açúcar refinado 1 kg', 4.99], ['MC-007', 'Detergente 500 ml', 2.79], ['MC-008', 'Papel higiênico 12 rolos', 21.9], ['MC-009', 'Refrigerante 2 L', 9.49]] },
  { segment: 'cosmeticos', name: 'Perfumaria Essência Pura (demonstração)', trade: 'Essência Pura — Demo', color: '#AD1457', days: 60, products: [
    ['CS-001', 'Perfume feminino floral 100 ml', 189.9], ['CS-002', 'Perfume masculino amadeirado 100 ml', 199.9], ['CS-003', 'Base líquida tom médio 30 ml', 79.9], ['CS-004', 'Batom matte vermelho', 39.9],
    ['CS-005', 'Hidratante facial 50 g', 59.9], ['CS-006', 'Protetor solar FPS 50 120 ml', 69.9], ['CS-007', 'Shampoo reparador 300 ml', 44.9], ['CS-008', 'Máscara de cílios', 49.9]] },
  { segment: 'odontologia', name: 'Clínica Sorriso Feliz (demonstração)', trade: 'Sorriso Feliz — Demo', color: '#00838F', days: 45, products: [['OD-P01', 'Escova dental macia', 14.9], ['OD-P02', 'Fio dental 50 m', 12.9]],
    services: [['Consulta e avaliação', 150, 30], ['Limpeza (profilaxia)', 220, 40], ['Restauração em resina', 280, 60], ['Clareamento (sessão)', 450, 60]],
    pros: [{ name: 'Dra. Paula Mendes (fictícia)', specialty: 'Clínico geral', council: ['CRO', '00001'] }, { name: 'Dr. André Lopes (fictício)', specialty: 'Ortodontia', council: ['CRO', '00002'] }] },
  { segment: 'estetica', name: 'Espaço Bella Pele (demonstração)', trade: 'Bella Pele — Demo', color: '#8E24AA', days: 45, products: [['ES-P01', 'Sérum vitamina C 30 ml', 129.9], ['ES-P02', 'Protetor solar facial', 89.9]],
    services: [['Limpeza de pele', 180, 60], ['Drenagem linfática', 150, 50], ['Peeling químico', 320, 45], ['Massagem relaxante', 160, 60]],
    pros: [{ name: 'Carla Esteticista (fictícia)', specialty: 'Esteticista' }, { name: 'Renata Massoterapeuta (fictícia)', specialty: 'Massoterapia' }] },
  { segment: 'salao', name: 'Salão Studio Charme (demonstração)', trade: 'Studio Charme — Demo', color: '#D81B60', days: 45, products: [['SL-P01', 'Shampoo profissional 1 L', 89.9], ['SL-P02', 'Esmalte cremoso', 9.9]],
    services: [['Corte feminino', 90, 45], ['Escova', 60, 40], ['Coloração', 180, 90], ['Manicure', 35, 40], ['Corte masculino', 50, 30]],
    pros: [{ name: 'Júlio Cabeleireiro (fictício)', specialty: 'Cabeleireiro' }, { name: 'Tati Manicure (fictícia)', specialty: 'Manicure' }] },
  { segment: 'saude', name: 'Clínica Vida Plena (demonstração)', trade: 'Vida Plena — Demo', color: '#1565C0', days: 45, products: [['SA-P01', 'Kit curativo', 19.9]],
    services: [['Consulta clínica', 300, 30], ['Retorno', 0, 20], ['Sessão de psicoterapia', 200, 50], ['Sessão de fisioterapia', 150, 45], ['Consulta de nutrição', 220, 40]],
    pros: [{ name: 'Dra. Helena Rocha (fictícia)', specialty: 'Clínica médica', council: ['CRM', '000000'] }, { name: 'Ana Souza (fictícia)', specialty: 'Psicologia', council: ['CRP', '06/000000'], restrict: true },
      { name: 'Bruno Lima (fictício)', specialty: 'Fisioterapia', council: ['CREFITO', '0000-F'] }, { name: 'Lívia Nutri (fictícia)', specialty: 'Nutrição', council: ['CRN', '00000'] }] },
  { segment: 'oficina', name: 'Auto Center Pista Livre (demonstração)', trade: 'Pista Livre — Demo', color: '#455A64', days: 45, products: [
    ['OF-001', 'Óleo 5W30 sintético (L)', 45, 'L'], ['OF-002', 'Filtro de óleo', 35], ['OF-003', 'Pastilha de freio dianteira (jogo)', 150, 'JG'], ['OF-004', 'Vela de ignição', 28], ['OF-005', 'Palheta limpador (par)', 59.9, 'PR']],
    services: [['Troca de óleo e filtro', 50, 30], ['Alinhamento e balanceamento', 120, 60], ['Revisão de freios', 90, 60]],
    pros: [{ name: 'Carlos Mecânico (fictício)', specialty: 'Mecânico' }, { name: 'Diego Eletricista (fictício)', specialty: 'Eletricista' }] },
]

/** Cliente HTTP do próprio servidor (loopback), autenticado como a conta de demonstração. */
function client(base: string) {
  let token = ''
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-demo-internal': demo.internalToken, 'idempotency-key': 'demo-' + Math.random().toString(36).slice(2) + Date.now(), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const j: any = await r.json().catch(() => null)
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${j?.error?.message ?? ''}`)
    return j
  }
  return { call, set: (t: string) => { token = t } }
}

export async function seedDemoInstance(base: string) {
  if (!demo.email || demo.password.length < 10) throw new Error('Defina DEMO_LOGIN_EMAIL e DEMO_LOGIN_PASSWORD (mínimo 10 caracteres, letras e números) para montar a demonstração.')
  seedN = 20261029
  const t0 = Date.now()
  // 1) Moda (o gerador completo existente) — cria também a conta de demonstração como Administrador
  await seedDemo({ password: demo.password, adminEmail: demo.email, adminName: 'Conta de Demonstração', quiet: true })
  const user = (await pool.query(`SELECT id FROM users WHERE lower(email) = $1`, [demo.email])).rows[0]
  // 2) demais segmentos: empresa + vínculo da conta de demonstração
  const companies: { spec: Spec; id: string; branch: string }[] = []
  for (const spec of SPECS) {
    const r = await tx(async (c) => {
      const r = await bootstrapCompany(c, { name: spec.name, tradeName: spec.trade, segment: spec.segment, isDemo: true, color: spec.color, branch: { code: '001', name: 'Matriz' } } as any)
      await c.query(`UPDATE companies SET settings = settings || '{"vendas":{"exigirCaixaAberto":false}}'::jsonb WHERE id = $1`, [r.company.id])
      await c.query(`INSERT INTO user_companies(user_id, company_id, role_id, all_branches) VALUES ($1,$2,$3,true)`, [user.id, r.company.id, r.roles['Administrador']])
      return r
    })
    companies.push({ spec, id: r.company.id, branch: r.branch.id })
  }
  // 3) dados pela própria API
  const api = client(base)
  const l = await api.call('POST', '/api/auth/login', { email: demo.email, password: demo.password })
  api.set(l.token)
  for (const co of companies) {
    const s = await api.call('POST', '/api/auth/context', { companyId: co.id, branchId: co.branch }).catch(async () => api.call('POST', '/api/auth/switch', { companyId: co.id, branchId: co.branch }))
    api.set(s.token)
    await fillCompany(api, co.spec, co.id)
  }
  // fixa a conta de demonstração: sem troca obrigatória de senha, sem MFA
  await pool.query(`UPDATE users SET must_change_password = false, mfa_enabled = false, mfa_secret = NULL, pending_activation = false WHERE id = $1`, [user.id])
  await pool.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1`, [user.id])
  console.log(`[demo] ambiente montado em ${Math.round((Date.now() - t0) / 1000)}s: ${companies.length + 1} empresas de demonstração`)
}

async function fillCompany(api: ReturnType<typeof client>, spec: Spec, companyId: string) {
  const lk = await api.call('GET', '/api/lookups')
  const pm = (k: string) => lk.paymentMethods.find((x: any) => x.kind === k)?.id
  // produtos + estoque
  const variants: { id: string; price: number; frac: boolean }[] = []
  for (const [code, name, price, unit, extra] of spec.products) {
    const p = await api.call('POST', '/api/products', { code, name, sale_price: price, cost_price: Math.round(price * 0.55 * 100) / 100, unit: unit || 'UN', ...(extra || {}) })
    const frac = ['KG', 'L'].includes(unit || '')
    variants.push({ id: p.variants[0].id, price, frac })
    await api.call('POST', '/api/stock/movements', { type: 'entrada', reason: 'Estoque inicial (demonstração)', items: [{ variantId: p.variants[0].id, qty: frac ? 400 : 300 }] })
  }
  // clientes
  const customers: string[] = []
  for (let i = 0; i < 24; i++) {
    const c = await api.call('POST', '/api/customers', { name: `${personName()} (demo)`, whatsapp: `119${between(10000000, 99999999)}`, birth_date: `${between(1960, 2005)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}` })
    customers.push(c.id)
  }
  const pay = (net: number) => { const r = rnd(); return r < 0.4 ? [{ methodId: pm('pix'), amount: net }] : r < 0.65 ? [{ methodId: pm('debito'), amount: net }] : [{ methodId: pm('credito'), amount: net, installments: net > 300 ? 2 : 1 }] }
  const sell = async (items: { variantId: string; qty: number }[], total: number, days: number, customerId: string | null) => {
    const net = Math.round(total * 100) / 100
    const s = await api.call('POST', '/api/sales', { customerId, items, payments: pay(net), ageConfirmed: true })
    await tx((c) => shiftSale(c, s.id, days, between(9, 19)))
  }
  // vendas de balcão (histórico)
  if (!spec.services || spec.segment === 'oficina' || variants.length > 2) {
    for (let day = spec.days; day >= 0; day--) {
      for (let k = 0; k < between(1, spec.services ? 1 : 4); k++) {
        const items: { variantId: string; qty: number }[] = []; let total = 0
        for (let j = 0; j < between(1, 3); j++) {
          const v = pick(variants); if (items.find((x) => x.variantId === v.id)) continue
          const qty = v.frac ? Math.round((0.4 + rnd() * 2) * 1000) / 1000 : between(1, 2)
          items.push({ variantId: v.id, qty }); total += Math.round(qty * v.price * 100) / 100
        }
        await sell(items, total, day, rnd() < 0.6 ? pick(customers) : null).catch(() => {})
      }
    }
  }
  if (!spec.services) return
  // serviços, profissionais e agenda
  const services: { id: string; price: number }[] = []
  for (const [name, price, dur] of spec.services) {
    const s = await api.call('POST', '/api/services', { kind: 'servico', name, sale_price: price, duration_min: dur, ...(spec.segment === 'oficina' && /óleo/i.test(name) ? { return_km: 5000, return_days: 180 } : {}) })
    services.push({ id: s.id, price })
  }
  const pros: string[] = []
  for (const p of spec.pros ?? []) {
    const r = await api.call('POST', '/api/professionals', { name: p.name, specialty: p.specialty, commission_services_pct: 40, commission_products_pct: 5,
      ...(p.council ? { council: p.council[0], council_number: p.council[1], council_uf: 'SP' } : {}), ...(p.restrict ? { restrict_records: true } : {}) })
    pros.push(r.id)
  }
  if (spec.segment === 'oficina') return fillWorkshop(api, variants, services, pros, customers)
  const pad = (n: number) => String(n).padStart(2, '0')
  const local = (offsetDays: number, hour: number, min = 0) => { const d = new Date(Date.now() + offsetDays * 86400000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:${pad(min)}` }
  // histórico: atendimentos concluídos e cobrados
  for (let day = spec.days; day >= 1; day--) {
    if (new Date(Date.now() - day * 86400000).getDay() === 0) continue
    for (let k = 0; k < between(1, 3); k++) {
      const svc = pick(services), pro = pick(pros), cust = pick(customers)
      try {
        const a = await api.call('POST', '/api/appointments', { professionalId: pro, customerId: cust, start: local(-day, 8 + k * 2 + between(0, 1)), services: [{ productId: svc.id }], ignoreHours: true, ...(spec.segment === 'saude' ? { visitType: pick(['primeira', 'retorno', 'sessao']) } : {}) })
        if (rnd() < 0.08) { await api.call('POST', `/api/appointments/${a.id}/status`, { status: 'faltou', reason: 'Não compareceu' }); continue }
        await api.call('POST', `/api/appointments/${a.id}/complete`, {})
        if (svc.price > 0) {
          const d = await api.call('GET', `/api/appointments/${a.id}`)
          const s = await api.call('POST', '/api/sales', { customerId: cust, items: d.services.map((x: any) => ({ appointmentServiceId: x.id, qty: 1 })), payments: pay(svc.price) })
          await tx((c) => shiftSale(c, s.id, day, 10))
        }
      } catch { /* conflito de horário: ignora */ }
    }
  }
  // agenda de hoje e dos próximos dias
  for (let day = 0; day <= 3; day++) for (let k = 0; k < 4; k++) {
    await api.call('POST', '/api/appointments', { professionalId: pros[k % pros.length], customerId: pick(customers), start: local(day, 9 + k * 2), services: [{ productId: pick(services).id }], ignoreHours: true }).catch(() => {})
  }
  // prontuário: registros de exemplo (fictícios) em alguns pacientes
  if (['saude', 'odontologia', 'estetica'].includes(spec.segment)) {
    for (const cust of customers.slice(0, 6)) {
      await api.call('POST', `/api/customers/${cust}/clinical-records`, { kind: spec.segment === 'saude' ? 'consulta' : 'evolucao', title: 'Atendimento (exemplo fictício)',
        content: spec.segment === 'saude' ? 'S: queixa de cefaleia leve.\nO: bom estado geral.\nA: cefaleia tensional.\nP: orientações e retorno em 30 dias. (registro fictício de demonstração)' : 'Procedimento realizado sem intercorrências. (registro fictício de demonstração)',
        ...(spec.segment === 'saude' ? { vitals: { pas: between(110, 130), pad: between(70, 85), fc: between(62, 88) } } : {}) }).catch(() => {})
    }
  }
  if (spec.segment === 'saude') {
    const ins = await api.call('POST', '/api/insurers', { name: 'Plano Exemplo Saúde (fictício)', paymentDays: 30 })
    await api.call('PUT', `/api/insurers/${ins.id}/prices`, { items: [{ productId: services[0].id, price: 180, tussCode: '10101012' }] })
    for (const cust of customers.slice(0, 3)) {
      await api.call('PUT', `/api/patients/${cust}/profile`, { insurerId: ins.id, insuranceCard: `${between(100000, 999999)}` })
      const a = await api.call('POST', '/api/appointments', { professionalId: pros[0], customerId: cust, start: local(-between(2, 10), 15), services: [{ productId: services[0].id }], payer: 'convenio', ignoreHours: true }).catch(() => null)
      if (a) await api.call('POST', `/api/appointments/${a.id}/complete`, {}).catch(() => {})
    }
  }
  void companyId
}

async function fillWorkshop(api: ReturnType<typeof client>, variants: { id: string }[], services: { id: string }[], pros: string[], customers: string[]) {
  const cars: [string, string, string, number][] = [['Chevrolet', 'Onix 1.0', 'DEM1A11', 2022], ['Volkswagen', 'Gol 1.6', 'DEM2B22', 2019], ['Honda', 'CG 160', 'DEM3C33', 2021], ['Fiat', 'Argo 1.3', 'DEM4D44', 2023]]
  for (let i = 0; i < cars.length; i++) {
    const [brand, model, plate, year] = cars[i]
    const wo = await api.call('POST', '/api/work-orders', { customerId: customers[i], vehicle: { type: /CG/.test(model) ? 'moto' : 'carro', brand, model, plate, yearModel: year }, kmIn: between(20000, 90000), complaint: 'Revisão e verificação geral (exemplo fictício)', professionalId: pros[i % pros.length] }).catch(() => null)
    if (!wo) continue
    await api.call('POST', `/api/work-orders/${wo.id}/items`, { kind: 'servico', productId: services[0].id }).catch(() => {})
    await api.call('POST', `/api/work-orders/${wo.id}/items`, { kind: 'mao_de_obra', hours: 1, description: 'Diagnóstico' }).catch(() => {})
    await api.call('POST', `/api/work-orders/${wo.id}/items`, { kind: 'peca', productId: (await api.call('GET', `/api/products?q=OF-002`)).items?.[0]?.id, qty: 1 }).catch(() => {})
    if (i < 2) {
      await api.call('POST', `/api/work-orders/${wo.id}/status`, { to: 'aguardando_aprovacao' }).catch(() => {})
      if (i === 1) {
        const d = await api.call('GET', `/api/work-orders/${wo.id}`)
        await api.call('POST', `/api/work-orders/${wo.id}/approve`, { itemIds: d.items.map((x: any) => x.id), approvedBy: 'Cliente (fictício)', channel: 'telefone' }).catch(() => {})
        await api.call('POST', `/api/work-orders/${wo.id}/status`, { to: 'em_execucao' }).catch(() => {})
      }
    }
  }
  void variants
}

/** Cria a marca do banco de demonstração e uma senha conhecida só pela variável de ambiente. */
export async function markDemoDatabase() {
  await pool.query(`CREATE TABLE IF NOT EXISTS demo_instance (id int PRIMARY KEY DEFAULT 1 CHECK (id = 1), created_at timestamptz NOT NULL DEFAULT now(), last_reset_at timestamptz)`)
  await pool.query(`INSERT INTO demo_instance(id, last_reset_at) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET last_reset_at = now()`)
  void hashPassword
}
