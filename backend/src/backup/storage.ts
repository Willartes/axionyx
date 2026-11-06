import crypto from 'node:crypto'
import { db } from '../core/db'

/**
 * Onde os backups ficam:
 *  - R2/S3 (recomendado): Cloudflare R2 ou qualquer armazenamento compatível com S3, configurado por variáveis de ambiente;
 *  - banco: sem armazenamento externo, o arquivo cifrado fica no próprio banco (serve para baixar e restaurar empresas,
 *    mas NÃO protege contra a perda do banco — a tela avisa).
 * Assinatura AWS SigV4 implementada aqui, sem bibliotecas extras.
 */
export interface S3Config { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string; prefix: string }
export function s3Config(): S3Config | null {
  const e = (k: string) => (process.env[k] || '').trim()
  const endpoint = e('BACKUP_S3_ENDPOINT') || (e('BACKUP_R2_ACCOUNT_ID') ? `https://${e('BACKUP_R2_ACCOUNT_ID')}.r2.cloudflarestorage.com` : '')
  const cfg = { endpoint: endpoint.replace(/\/+$/, ''), bucket: e('BACKUP_S3_BUCKET'), accessKeyId: e('BACKUP_S3_ACCESS_KEY_ID'), secretAccessKey: e('BACKUP_S3_SECRET_ACCESS_KEY'), region: e('BACKUP_S3_REGION') || 'auto', prefix: (e('BACKUP_S3_PREFIX') || 'axionyx-backups').replace(/^\/+|\/+$/g, '') }
  return cfg.endpoint && cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey ? cfg : null
}
export const storageKind = (): 'r2' | 'banco' => (s3Config() ? 'r2' : 'banco')

const sha256 = (d: string | Buffer) => crypto.createHash('sha256').update(d).digest('hex')
const hmac = (k: Buffer | string, d: string) => crypto.createHmac('sha256', k).update(d).digest()
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/** Assinatura SigV4 (cabeçalho Authorization). Exportada para teste com o vetor oficial da AWS. */
export function signV4(o: { method: string; host: string; path: string; query?: Record<string, string>; headers: Record<string, string>; payloadHash: string; accessKeyId: string; secretAccessKey: string; region: string; service?: string; date: Date }) {
  const service = o.service ?? 's3'
  const amzDate = o.date.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = amzDate.slice(0, 8)
  const headers: Record<string, string> = { host: o.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': o.payloadHash }
  for (const [k, v] of Object.entries(o.headers)) headers[k.toLowerCase()] = String(v).trim()
  const names = Object.keys(headers).sort()
  const canonicalQuery = Object.entries(o.query ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&')
  const canonical = [o.method, o.path.split('/').map((s) => enc(decodeURIComponent(s))).join('/'), canonicalQuery, names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), o.payloadHash].join('\n')
  const scope = `${day}/${o.region}/${service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac('AWS4' + o.secretAccessKey, day), o.region), service), 'aws4_request')
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex')
  return { headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` }, signature }
}

async function s3(method: 'PUT' | 'GET' | 'DELETE' | 'HEAD', key: string, body?: Buffer): Promise<Response> {
  const cfg = s3Config()
  if (!cfg) throw new Error('Armazenamento externo de backup não configurado.')
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${key.split('/').map(enc).join('/')}`)
  const payloadHash = body ? sha256(body) : sha256('')
  const s = signV4({ method, host: url.host, path: url.pathname, headers: body ? { 'content-type': 'application/octet-stream', 'content-length': String(body.length) } : {}, payloadHash, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region, date: new Date() })
  const headers: Record<string, string> = { ...s.headers }; delete headers.host
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15 * 60_000)
  try {
    const r = await fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: ctl.signal })
    if (!r.ok && !(method === 'DELETE' && r.status === 404)) {
      const txt = (await r.text().catch(() => '')).slice(0, 300)
      throw new Error(`Armazenamento de backup respondeu ${r.status}${/AccessDenied|SignatureDoesNotMatch|InvalidAccessKeyId/.test(txt) ? ' (credenciais recusadas: confira as variáveis BACKUP_S3_*)' : /NoSuchBucket/.test(txt) ? ' (bucket não encontrado)' : ''}.`)
    }
    return r
  } finally { clearTimeout(t) }
}

export function objectKey(scope: string, companyId: string | null, id: string, createdAt: Date) {
  const cfg = s3Config()!
  const d = createdAt.toISOString().slice(0, 10)
  return `${cfg.prefix}/${scope === 'sistema' ? 'sistema' : `empresas/${companyId}`}/${d}/${id}.axbak`
}

/** Grava no R2/S3; se o R2 não responder, guarda no banco (o backup não se perde) e devolve o aviso. */
export async function putFile(backupId: string, key: string | null, data: Buffer): Promise<{ storage: 'r2' | 'banco'; key: string | null; warning: string | null }> {
  let warning: string | null = null
  if (key) {
    try { await s3('PUT', key, data); return { storage: 'r2', key, warning: null } }
    catch (e: any) { warning = `R2/S3 indisponível (${String(e.message).slice(0, 200)}): guardado no banco.`; console.error('[backup] ' + warning) }
  }
  await db.query(`UPDATE backup_files SET content = $2 WHERE id = $1`, [backupId, data])
  return { storage: 'banco', key: null, warning }
}
export async function getFile(b: { id: string; storage: string; storage_key: string | null }): Promise<Buffer> {
  if (b.storage === 'r2') return Buffer.from(await (await s3('GET', b.storage_key!)).arrayBuffer())
  const r = await db.one(`SELECT content FROM backup_files WHERE id = $1`, [b.id])
  if (!r?.content) throw new Error('Conteúdo do backup não encontrado.')
  return r.content
}
export async function deleteFile(b: { id: string; storage: string; storage_key: string | null }) {
  if (b.storage === 'r2' && b.storage_key) await s3('DELETE', b.storage_key)
  await db.query(`UPDATE backup_files SET content = NULL, status = 'excluido' WHERE id = $1`, [b.id])
}
/** Teste de gravação/leitura/exclusão no armazenamento externo. */
export async function testStorage(): Promise<{ ok: boolean; error?: string; kind: 'r2' | 'banco' }> {
  if (!s3Config()) return { ok: true, kind: 'banco' }
  const key = `${s3Config()!.prefix}/_teste/${crypto.randomUUID()}.txt`
  try { await s3('PUT', key, Buffer.from('axionyx')); const got = Buffer.from(await (await s3('GET', key)).arrayBuffer()).toString(); await s3('DELETE', key); return { ok: got === 'axionyx', kind: 'r2' } }
  catch (e: any) { return { ok: false, error: e.message, kind: 'r2' } }
}
