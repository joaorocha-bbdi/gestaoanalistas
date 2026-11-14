// Gera supabase/atualizar_banco.sql: as migrations que faltam num banco criado
// antes das etapas (0007 em diante), numa única transação.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
const dir = 'supabase/migrations'
const files = readdirSync(dir).sort().filter((f) => f >= '20261113000700')
const body = files.map((f) => `-- >>> ${f}\n${readFileSync(`${dir}/${f}`, 'utf8')}`).join('\n\n')
writeFileSync('supabase/atualizar_banco.sql',
  `-- Gerado por scripts/bundle-update.mjs. Rode UMA vez no SQL Editor, num banco criado com o setup.sql antigo.\n` +
  `-- Tudo numa transação: se algo falhar, nada muda.\nbegin;\n\n${body}\n\ncommit;\n`)
console.log(`supabase/atualizar_banco.sql: ${files.join(', ')}`)
