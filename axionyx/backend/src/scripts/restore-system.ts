/**
 * Restauração COMPLETA do AXIONYX num banco NOVO e vazio, a partir de um backup do sistema (.axbak).
 * Uso:  DATABASE_URL=postgres://...banco-novo  BACKUP_ENCRYPTION_KEY=...  node dist/scripts/restore-system.js caminho/arquivo.axbak
 * (use a MESMA chave de backup do servidor que gerou o arquivo; veja docs/BACKUP.md)
 */
import fs from 'node:fs'
import { pool, tx } from '../core/db'
import { migrate } from '../db/migrate'
import { restoreSystem, openBackup } from '../backup/engine'

async function main() {
  const file = process.argv[2]
  if (!file || !fs.existsSync(file)) { console.error('Informe o caminho do arquivo .axbak.'); process.exit(1) }
  const buf = fs.readFileSync(file)
  const { header } = openBackup(buf)
  console.log(`[restaurar] backup do sistema de ${header.created_at} (versão ${header.app_version}, ${header.migrations.length} migrações)`)
  await migrate(true)
  const counts = await tx((c) => restoreSystem(c, buf, (t) => process.stdout.write(`\r[restaurar] ${t.padEnd(40)}`)))
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`\n[restaurar] concluído: ${Object.keys(counts).length} tabelas, ${total} linhas.`)
  await pool.end()
}
main().catch(async (e) => { console.error('\n[restaurar] falhou:', e.message); await pool.end().catch(() => {}); process.exit(1) })
