import type { AuthUser, Ctx } from './http'
import { forbidden } from './errors'

/**
 * Permissões da equipe da plataforma AXIONYX (superadministradores).
 * O proprietário tem tudo; os demais (agentes operacionais) só o que for concedido.
 * Nenhum membro da equipe aparece ou conta como usuário das empresas clientes.
 */
export const PLATFORM_PERMISSIONS: { key: string; group: string; label: string; description: string }[] = [
  { key: 'suporte.acessar', group: 'Atendimento', label: 'Acessar empresas clientes', description: 'Entrar em qualquer empresa para atendimento. Sem "Alterar dados", fica somente consulta.' },
  { key: 'suporte.editar', group: 'Atendimento', label: 'Alterar dados nas empresas', description: 'Cadastrar, editar e operar dentro das empresas (inclusive usuários e perfis do cliente).' },
  { key: 'empresas.criar', group: 'Atendimento', label: 'Criar empresas', description: 'Criar empresas manualmente em Administração › Empresas (fora da carteira).' },
  { key: 'carteira.ver', group: 'Carteira', label: 'Ver carteira', description: 'Painel, clientes, contratos, cobranças, fila de auditoria e contatos do site (somente leitura).' },
  { key: 'carteira.propostas', group: 'Carteira', label: 'Propostas e contratos', description: 'Cadastrar propostas, vincular clientes existentes e editar condições.' },
  { key: 'carteira.aprovar', group: 'Carteira', label: 'Auditar', description: 'Aprovar ou recusar propostas e resolver a fila de auditoria.' },
  { key: 'carteira.financeiro', group: 'Carteira', label: 'Financeiro da carteira', description: 'Gerar cobranças e links, baixa manual, estorno, suspender, reativar e cancelar contratos.' },
  { key: 'carteira.configurar', group: 'Carteira', label: 'Planos e Mercado Pago', description: 'Criar e alterar planos, testar a integração e reprocessar notificações.' },
  { key: 'plataforma.equipe', group: 'Equipe', label: 'Gerenciar a equipe', description: 'Cadastrar agentes e definir permissões (só pode conceder as que ele mesmo tem).' },
]
export const PLATFORM_KEYS = PLATFORM_PERMISSIONS.map((p) => p.key)

/** Rotas de plataforma: não são dados de empresa, então não passam pela trava de "somente consulta" do suporte. */
export const PLATFORM_PATHS = ['/api/auth/', '/api/saas/', '/api/platform/', '/api/admin/leads', '/api/billing/']

export function platformCan(u: AuthUser | null | undefined, perm: string): boolean {
  return !!u?.isSuperadmin && (u.platformOwner || u.platformPerms.has(perm))
}
export function requirePlatform(ctx: Ctx, perm: string) {
  if (!ctx.user?.isSuperadmin) throw forbidden('Área exclusiva da equipe da plataforma AXIONYX.')
  if (!platformCan(ctx.user, perm)) throw forbidden(`Seu perfil na equipe não tem a permissão "${PLATFORM_PERMISSIONS.find((p) => p.key === perm)?.label ?? perm}".`)
}
