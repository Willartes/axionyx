import { db, type Q } from '../core/db'
import { unprocessable } from '../core/errors'
import type { AuthUser } from '../core/http'

/**
 * Limites comerciais de usuários e filiais. Origem: plano do contrato da empresa, ou o valor do próprio contrato quando a
 * plataforma definiu um limite específico. Empresa sem contrato, ou plano sem limite = ilimitado.
 * Contagem de usuários: vínculos ATIVOS + convites pendentes (para não contornar o limite convidando); não contam
 * usuários desativados nem a equipe da plataforma. Filiais: as ativas.
 */
export type LimitKind = 'users' | 'branches'
export interface Usage { used: number; limit: number | null; source: 'plano' | 'contrato' | null }
export interface CompanyLimits { contract: boolean; plan: string | null; users: Usage; branches: Usage }

export const USERS_USED_SQL = `(SELECT count(*)::int FROM user_companies uc JOIN users u ON u.id = uc.user_id
   WHERE uc.company_id = $1 AND NOT u.is_superadmin AND ((uc.active AND u.active AND NOT uc.invite_pending) OR uc.invite_pending))`
export const BRANCHES_USED_SQL = `(SELECT count(*)::int FROM branches b WHERE b.company_id = $1 AND b.active)`

export async function companyLimits(companyId: string, c: Q | typeof db = db): Promise<CompanyLimits> {
  const r = await c.one(`SELECT k.id IS NOT NULL AS contract, p.name AS plan, k.max_users_override, k.max_branches_override, p.max_users, p.max_branches,
                                ${USERS_USED_SQL} AS users_used, ${BRANCHES_USED_SQL} AS branches_used
                           FROM (SELECT $1::uuid AS company_id) x LEFT JOIN saas_contracts k ON k.company_id = x.company_id LEFT JOIN saas_plans p ON p.id = k.plan_id`, [companyId])
  const pick = (override: number | null, plan: number | null): Pick<Usage, 'limit' | 'source'> =>
    !r.contract ? { limit: null, source: null } : override ? { limit: override, source: 'contrato' } : plan ? { limit: plan, source: 'plano' } : { limit: null, source: null }
  return {
    contract: !!r.contract, plan: r.plan ?? null,
    users: { used: r.users_used, ...pick(r.max_users_override, r.max_users) },
    branches: { used: r.branches_used, ...pick(r.max_branches_override, r.max_branches) },
  }
}

/** Bloqueia acrescentar usuário/filial além do limite. Use DENTRO da transação que cria ou reativa (trava por empresa). */
export async function assertCanAdd(c: Q, user: AuthUser, companyId: string, kind: LimitKind) {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('limite:' || $1 || ':' || $2))`, [kind, companyId])
  const l = await companyLimits(companyId, c)
  const u = l[kind]
  if (u.limit === null || u.used < u.limit) return
  const what = kind === 'users' ? `${u.limit} usuário(s)` : `${u.limit} filial(is) ativa(s)`
  const now = kind === 'users' ? `a empresa já tem ${u.used} (contando convites pendentes)` : `a empresa já tem ${u.used}`
  const how = user.isSuperadmin
    ? 'Para ampliar, ajuste o limite do contrato em Minha Carteira › Clientes e Contratos.'
    : kind === 'users' ? 'Desative um usuário ou cancele um convite, ou fale com o suporte AXIONYX para ampliar o plano.' : 'Desative uma filial ou fale com o suporte AXIONYX para ampliar o plano.'
  throw unprocessable(`${u.source === 'contrato' ? 'O contrato' : 'O plano'} desta empresa permite até ${what} e ${now}. ${how}`)
}
