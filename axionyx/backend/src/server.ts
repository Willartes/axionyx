import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config'
import { handle, securityHeaders } from './core/http'
import { pool } from './core/db'
import { migrate } from './db/migrate'
import './modules'
import { startWorker, stopWorker } from './integrations/worker'
import { demo, installDemoNetworkGuard, demoLinkUrl } from './demo/mode'
import { demoDatabaseCheck, resetDemo, scheduleDemoReset, syncDemoAccount } from './demo/reset'

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json' }

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const root = path.resolve(config.staticDir)
  let rel = '/'
  try { rel = decodeURIComponent((req.url || '/').split('?')[0]) } catch { /* endereço malformado: cai no index */ }
  let file = path.join(root, rel)
  // só arquivos DENTRO da pasta pública (comparação com separador evita pastas "irmãs" com o mesmo prefixo)
  if ((file !== root && !file.startsWith(root + path.sep)) || rel.includes('\0') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('Not found'); return }
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; frame-src blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=86400' })
  fs.createReadStream(file).pipe(res)
}

export function createServer() {
  return http.createServer(async (req, res) => {
    securityHeaders(res)
    const origin = req.headers.origin
    if (origin && (config.corsOrigin === '*' || config.corsOrigin.split(',').includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, idempotency-key, x-file-name, x-folder, x-entity, x-entity-id')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      res.setHeader('Access-Control-Max-Age', '600')
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    try {
      if (await handle(req, res)) return
      // atalho /demo: na produção leva ao serviço de demonstração (DEMO_URL); no próprio ambiente de demonstração, ao login
      const pathOnly = (req.url || '').split('?')[0].replace(/\/+$/, '')
      if (req.method === 'GET' && pathOnly === '/demo') {
        const target = demo.enabled ? '/login?entrar=1' : demoLinkUrl() ? `${demoLinkUrl()}/login?entrar=1` : '/'
        res.writeHead(302, { location: target, 'cache-control': 'no-store' }); res.end(); return
      }
      if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return }
      if (config.staticDir) return serveStatic(req, res)
      res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'nao_encontrado', message: 'Use /api' } }))
    } catch (e) {
      console.error(e); if (!res.headersSent) { res.writeHead(500); res.end() }
    }
  })
}

if (require.main === module) {
  ;(async () => {
    void config.jwtSecret // valida presença do segredo na inicialização
    let demoEmpty = false
    if (demo.enabled) {
      installDemoNetworkGuard()
      const chk = await demoDatabaseCheck()
      if (!chk.ok) { console.error('[demo] DEMO_MODE recusado: ' + chk.reason); process.exit(1) }
      demoEmpty = chk.empty
    }
    await migrate(false)
    const server = createServer()
    server.listen(config.port, () => {
      console.log(`[axionyx] API ouvindo em http://localhost:${config.port} (TZ=${config.timezone})${demo.enabled ? ' — AMBIENTE DE DEMONSTRAÇÃO' : ''}`)
      if (demo.enabled) {
        const base = `http://127.0.0.1:${config.port}`
        const montar = () => resetDemo(base).catch((e) => console.error('[demo] falha ao montar a demonstração:', e.message))
        if (demoEmpty) montar()
        else syncDemoAccount().then((r) => {
          if (r === 'missing') console.error('[demo] defina DEMO_LOGIN_EMAIL e DEMO_LOGIN_PASSWORD (mínimo 10 caracteres) neste serviço')
          else if (r === 'rebuild') { console.log('[demo] conta ou empresas ausentes: montando a demonstração de novo'); montar() }
          else console.log('[demo] conta de demonstração conferida')
        }).catch((e) => console.error('[demo] falha ao conferir a conta:', e.message))
        scheduleDemoReset(base)
      }
    })
    if (config.runWorker) startWorker()
    const shutdown = () => { console.log('[axionyx] encerrando...'); stopWorker(); server.close(() => pool.end().then(() => process.exit(0))) }
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
  })().catch((e) => { console.error('[axionyx] falha ao iniciar:', e.message); process.exit(1) })
}
