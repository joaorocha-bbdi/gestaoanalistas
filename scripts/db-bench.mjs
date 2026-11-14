// Mede o tempo das consultas mais pesadas, com volume realista, antes e depois
// da migration de desempenho (20261113001500). Postgres embutido (PGlite).
// Uso: node scripts/db-bench.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (p) => readFileSync(join(root, p), 'utf8')
const PERF = '20261113001500_performance.sql'

const STUB = read('scripts/db-test.mjs').match(/const SUPABASE_STUB = `([\s\S]*?)`/)[1]

const db = new PGlite({ extensions: { pgcrypto } })
await db.exec(STUB)
await db.exec('create extension if not exists pgcrypto;')
for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) if (f < PERF) await db.exec(read(`supabase/migrations/${f}`))

// Volume: 1 gestor + 12 analistas, ~4 meses de tarefas, etapas e envios.
const N = 12
await db.exec(`
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
  select ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid, 'u' || g || '@bench.local', 'authenticated', 'authenticated',
         case when g = 0 then '{"role":"admin"}'::jsonb else '{}'::jsonb end, jsonb_build_object('full_name', 'Pessoa ' || g),
         now() - interval '200 days'
  from generate_series(0, ${N}) g;
  update profiles set created_at = now() - interval '200 days';
  update activity_templates set created_at = now() - interval '200 days';
  select generate_tasks(local_today() - 120, local_today());
  insert into task_steps (task_id, step_index, checked_by)
    select t.id, g.i, t.user_id from task_instances t
    cross join lateral generate_series(0, jsonb_array_length(t.template_snapshot->'instructions') - 1) g(i)
    where t.ref_date < local_today();
  update task_instances set status = 'concluida_prazo', submitted_at = due_at - interval '2 hours', completed_at = due_at - interval '2 hours'
   where ref_date < local_today();
  insert into task_submissions (task_id, user_id, payload, gate_passed, result_status)
    select id, user_id, '{}', true, 'concluida_prazo' from task_instances where ref_date < local_today();
`)
const counts = (await db.query(`select (select count(*) from task_instances)::int tarefas, (select count(*) from task_steps)::int etapas`)).rows[0]
console.log(`Volume: ${N} analistas, ${counts.tarefas} tarefas, ${counts.etapas} etapas marcadas\n`)

const ADMIN = '00000000-0000-4000-b000-000000000000'
const ANALYST = '00000000-0000-4000-b000-000000000001'
const QUERIES = {
  'gestor · fatos de 12 semanas (visão geral)': [ADMIN, `select * from v_task_facts where ref_date >= local_today() - 84`],
  'gestor · fatos de 30 dias (indicadores)':    [ADMIN, `select * from v_task_facts where ref_date >= local_today() - 30`],
  'analista · tarefas do período (Hoje)':       [ANALYST, `select * from task_instances where period_start <= local_today() and period_end >= local_today()`],
  'analista · etapas das tarefas':               [ANALYST, `select s.* from task_steps s join task_instances t on t.id = s.task_id where t.ref_date >= local_today() - 7`],
  'analista · fatos de 30 dias (desempenho)':    [ANALYST, `select * from v_task_facts where ref_date >= local_today() - 30`],
}

async function time(user, sql, runs = 5) {
  const out = []
  for (let i = 0; i < runs; i++) {
    await db.exec(`begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${user}","role":"authenticated"}', true);`)
    const t0 = performance.now()
    const r = await db.query(sql)
    out.push(performance.now() - t0)
    await db.exec('rollback;')
    if (i === 0) { out.rows = r.rows.length; out.sig = JSON.stringify([...r.rows].map((x) => JSON.stringify(x)).sort()) }
  }
  out.sort((a, b) => a - b)
  return { ms: out[Math.floor(out.length / 2)], rows: out.rows, sig: out.sig }
}

const before = {}
for (const [k, [u, q]] of Object.entries(QUERIES)) before[k] = await time(u, q)
await db.exec(read(`supabase/migrations/${PERF}`))
const after = {}
for (const [k, [u, q]] of Object.entries(QUERIES)) after[k] = await time(u, q)

// "Hoje" numa chamada só
await db.exec(`begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${ANALYST}","role":"authenticated"}', true);`)
let t0 = performance.now()
const dash = (await db.query(`select dashboard_today(local_today(), local_today() - 7) d`)).rows[0].d
const dashMs = performance.now() - t0
await db.exec('rollback;')

console.table(Object.keys(QUERIES).map((k) => ({
  consulta: k, linhas: after[k].rows,
  'antes (ms)': before[k].ms.toFixed(1), 'depois (ms)': after[k].ms.toFixed(1),
  ganho: `${(before[k].ms / after[k].ms).toFixed(1)}×`,
  'mesmo resultado': before[k].sig === after[k].sig ? 'sim' : 'NÃO',
})))
console.log(`dashboard_today: ${dash.tasks.length} tarefas, ${dash.steps.length} etapas em uma chamada (${dashMs.toFixed(1)} ms)`)
await db.close()
