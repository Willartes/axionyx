import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/** Exige sessão completa (empresa e filial selecionadas). Carrega o perfil se necessário. */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService), router = inject(Router);
  if (auth.stage() !== 'full') return router.parseUrl(auth.stage() === 'context' ? '/empresa' : auth.stage() === 'mfa' ? '/mfa' : '/login');
  if (!auth.me()) { try { await auth.loadMe(); } catch { auth.clear(); return router.parseUrl('/login'); } }
  return true;
};

/** Verifica permissão declarada em route.data.perm (a API também valida no servidor). */
export const permGuard: CanActivateFn = (route) => {
  const auth = inject(AuthService), router = inject(Router);
  // assinatura sem pagamento confirmado: só "Minha assinatura"
  if (auth.me()?.billing?.blocked && !auth.me()?.user?.is_superadmin) return router.parseUrl('/minha-assinatura');
  const perm = route.data?.['perm'];
  if (!perm || auth.can(perm)) return true;
  return router.parseUrl('/sem-permissao');
};

export const stageGuard = (stage: 'mfa' | 'context'): CanActivateFn => () => {
  const auth = inject(AuthService), router = inject(Router);
  if (auth.stage() === stage || (stage === 'context' && auth.stage() === 'full')) return true;
  return router.parseUrl('/login');
};
