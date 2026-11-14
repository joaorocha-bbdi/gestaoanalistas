// Junta as migrations em supabase/setup.sql para colar no SQL Editor do Supabase.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
const dir = 'supabase/migrations'
const parts = readdirSync(dir).sort().map((f) => `-- >>> ${f}\n${readFileSync(`${dir}/${f}`, 'utf8')}`)
writeFileSync('supabase/setup.sql', `-- Gerado por scripts/bundle-sql.mjs. Não edite: edite as migrations.\n\n${parts.join('\n\n')}`)
console.log(`supabase/setup.sql: ${parts.length} migrations`)
