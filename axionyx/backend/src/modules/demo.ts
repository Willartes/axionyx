import { router, audit, rateLimit } from '../core/http'
import { forbidden } from '../core/errors'
import { config } from '../config'
import { demo, isDemoAccount, demoLinkUrl } from '../demo/mode'
import { resetDemo } from '../demo/reset'

/** Informações públicas do ambiente (a tela de login mostra a faixa de demonstração). */
router.get('/api/public/demo', { auth: 'none' }, async () => {
  if (!demo.enabled) { const url = demoLinkUrl(); return url ? { demo: false, url } : { demo: false } }
  return { demo: true, resetting: demo.resetting, resetHour: demo.resetHour, lastResetAt: demo.lastResetAt,
    ...(demo.publicLogin ? { email: demo.email, password: demo.password } : {}) }
})

/** Restaurar a demonstração ao estado original (antes de uma apresentação). */
router.post('/api/demo/reset', {}, async (ctx) => {
  if (!demo.enabled) throw forbidden('Disponível somente no ambiente de demonstração.')
  if (!isDemoAccount(ctx.user.email) && !ctx.user.isSuperadmin) throw forbidden()
  rateLimit('demo-reset', 1, 5 * 60_000)
  await audit(null, ctx, 'demo.restaurar', null, null, null, 'warning')
  // roda em segundo plano: a sessão atual deixa de existir (o banco é recriado)
  resetDemo(`http://127.0.0.1:${config.port}`).catch((e) => console.error('[demo] falha na restauração:', e.message))
  return { ok: true, message: 'Restaurando a demonstração. Em cerca de 1 a 3 minutos, entre novamente.' }
})
