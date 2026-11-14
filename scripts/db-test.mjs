// Roda as migrations, os testes de banco (pgTAP) e a limpeza dos dados de demonstração
// num Postgres embutido (PGlite), com um stub mínimo do ambiente Supabase
// (schema auth, auth.uid(), papéis anon/authenticated/service_role).
// Não substitui `supabase test db`, mas pega erro de SQL e regra quebrada sem Docker.
//
// Uso: npm run test:db
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (p) => readFileSync(join(root, p), 'utf8')

const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (
  instance_id uuid, id uuid primary key, aud text, role text, email text, encrypted_password text,
  email_confirmed_at timestamptz, raw_app_meta_data jsonb default '{}', raw_user_meta_data jsonb default '{}',
  created_at timestamptz default now(), updated_at timestamptz default now(),
  confirmation_token text, email_change text, email_change_token_new text, recovery_token text, banned_until timestamptz);
create table auth.identities (
  id uuid primary key, user_id uuid references auth.users, provider_id text, identity_data jsonb, provider text,
  last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz, unique (provider_id, provider));
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid $$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to public;
-- Privilégios padrão do Supabase em public
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`

// Shim mínimo de pgTAP: plan/is/ok/throws_ok/finish.
const PGTAP_SHIM = `
create schema extensions;
grant usage on schema extensions to public;
create table extensions._tap (n serial primary key, ok boolean, descr text, info text);
grant all on extensions._tap to public;
grant all on sequence extensions._tap_n_seq to public;
create function extensions.plan(int) returns text language sql as $$ select '1..' || $1 $$;
create function extensions.is(anyelement, anyelement, text) returns text language plpgsql as $$
begin insert into extensions._tap (ok, descr, info) values ($1 is not distinct from $2, $3, format('obtido %s, esperado %s', $1, $2)); return $3; end $$;
create function extensions.ok(boolean, text) returns text language plpgsql as $$
begin insert into extensions._tap (ok, descr, info) values (coalesce($1, false), $2, 'falso'); return $2; end $$;
create function extensions.throws_ok(text, text, text, text) returns text language plpgsql as $$
begin
  begin
    execute $1;
    insert into extensions._tap (ok, descr, info) values (false, $4, 'não lançou exceção');
  exception when others then
    insert into extensions._tap (ok, descr, info) values (sqlstate = $2, $4, format('sqlstate %s: %s', sqlstate, sqlerrm));
  end;
  return $4;
end $$;
create function extensions.lives_ok(text, text) returns text language plpgsql as $$
begin
  begin
    execute $1;
    insert into extensions._tap (ok, descr, info) values (true, $2, null);
  exception when others then
    insert into extensions._tap (ok, descr, info) values (false, $2, format('sqlstate %s: %s', sqlstate, sqlerrm));
  end;
  return $2;
end $$;
create function extensions.finish() returns setof text language sql as $$
  select format('%s %s - %s%s', case when ok then 'ok' else 'not ok' end, n, descr, case when ok then '' else '  # ' || info end)
  from extensions._tap order by n $$;
grant execute on all functions in schema extensions to public;
`

const db = new PGlite({ extensions: { pgcrypto } })
let failed = 0

async function step(label, sql) {
  try {
    await db.exec(sql)
    console.log(`✓ ${label}`)
  } catch (e) {
    failed++
    console.error(`✗ ${label}\n  ${e.message}${e.position ? ` (posição ${e.position})` : ''}`)
    if (e.position) {
      const pos = Number(e.position)
      console.error('  …' + sql.slice(Math.max(0, pos - 160), pos + 80).replace(/\n/g, '\n  ') + '…')
    }
    await db.close()
    process.exit(1)
  }
}

await step('stub Supabase', SUPABASE_STUB)
await step('extensão pgcrypto', 'create extension if not exists pgcrypto;')
for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) {
  await step(`migration ${f}`, read(`supabase/migrations/${f}`))
}
await step('shim pgTAP', PGTAP_SHIM)

// Testes pgTAP (o arquivo faz begin … rollback)
const testSql = read('supabase/tests/regras_criticas.test.sql')
  .replace(/create extension if not exists pgtap[^;]*;/i, '')
let results = []
try {
  results = await db.exec(testSql)
} catch (e) {
  failed++
  console.error(`✗ pgTAP abortou: ${e.message}
  ${e.where ?? ''}
  ${e.internalQuery ?? ''}`)
  try { await db.exec('rollback;') } catch { /* sem transação */ }
}
const tap = results.flatMap((r) => r.rows.map((row) => Object.values(row)[0])).filter((v) => typeof v === 'string' && /^(not )?ok \d+/.test(v))
for (const line of tap) console.log('  ' + line)
const notOk = tap.filter((l) => l.startsWith('not ok')).length
const planned = Number((read('supabase/tests/regras_criticas.test.sql').match(/plan\((\d+)\)/) ?? [])[1])
if (notOk || tap.length !== planned) {
  failed++
  console.error(`✗ pgTAP: ${notOk} falha(s), ${tap.length}/${planned} executados`)
} else console.log(`✓ pgTAP: ${tap.length}/${planned}`)

// ---------------------------------------------------------------------
// Limpeza dos dados de demonstração: só roda com um admin real e é tudo ou nada.
// Monta usuários @demo.rotina com tarefas, etapas, revisões e auditoria, e confere.
// ---------------------------------------------------------------------
{
  const q = async (sql) => (await db.query(sql)).rows
  const one = async (sql) => Object.values((await q(sql))[0])[0]
  const check = (okay, msg) => { console.log(`${okay ? '✓' : '✗'} ${msg}`); if (!okay) failed++ }
  const uuid = (n) => `00000000-0000-4000-a000-0000000000${String(n).padStart(2, '0')}`

  await db.exec(`
    insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at) values
      ('${uuid(1)}', 'gestor@demo.rotina', 'authenticated', 'authenticated', '{"role":"admin"}', '{"full_name":"Gestor Demo"}', now() - interval '30 days'),
      ('${uuid(2)}', 'ana@demo.rotina',    'authenticated', 'authenticated', '{}', '{"full_name":"Ana Demo"}',    now() - interval '30 days'),
      ('${uuid(3)}', 'bruno@demo.rotina',  'authenticated', 'authenticated', '{}', '{"full_name":"Bruno Demo"}',  now() - interval '30 days');
    select generate_tasks(local_today(), week_end(local_today()));
    insert into task_steps (task_id, step_index, checked_by)
      select id, 0, user_id from task_instances where user_id = '${uuid(2)}' and jsonb_array_length(template_snapshot->'instructions') > 0 limit 5;
    insert into reviews (task_id, reviewer_id, status, reason)
      select id, '${uuid(1)}', 'contestada', 'Motivo' from task_instances where user_id = '${uuid(2)}' limit 1;
  `)
  const before = {
    tasks: await one(`select count(*)::int from task_instances where user_id in ('${uuid(2)}','${uuid(3)}')`),
    templates: await one(`select count(*)::int from activity_templates`),
    settings: await one(`select count(*)::int from settings`),
  }
  check(before.tasks > 0, `fixture de demonstração criada (${before.tasks} tarefas)`)

  // 1. Sem admin real: recusa e não apaga nada
  await db.exec(read('supabase/maintenance/remove_demo_data.sql').replace(/insert into _rotina_cfg values \('[^']*'\)/, "insert into _rotina_cfg values ('SEU-EMAIL@empresa.com')"))
  check(await one(`select count(*)::int from profiles where email like '%@demo.rotina'`) === 3, 'limpeza não roda sem admin master real')
  check(await one(`select count(*)::int from task_instances where user_id in ('${uuid(2)}','${uuid(3)}')`) === before.tasks,
    'recusa não apagou nenhuma tarefa')

  // 2. Usuário real criado como analista; o script o promove a admin e remove a demonstração
  await db.exec(`insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
    values ('${uuid(9)}', 'voce@empresa.com', 'authenticated', 'authenticated', '{}', '{"full_name":"Admin Real"}', now() - interval '1 day');`)
  await db.exec(read('supabase/maintenance/remove_demo_data.sql').replace(/insert into _rotina_cfg values \('[^']*'\)/, "insert into _rotina_cfg values ('Voce@Empresa.com')"))
  check(await one(`select count(*)::int from profiles where email like '%@demo.rotina'`) === 0, 'perfis de demonstração removidos')
  check(await one(`select count(*)::int from auth.users where email like '%@demo.rotina'`) === 0, 'usuários de demonstração removidos do login')
  check(await one(`select count(*)::int from task_instances where user_id in ('${uuid(2)}','${uuid(3)}')`) === 0, 'tarefas de demonstração removidas')
  check(await one(`select count(*)::int from task_steps`) === 0 && await one(`select count(*)::int from reviews`) === 0, 'etapas e revisões de demonstração removidas')
  check(await one(`select count(*)::int from audit_log where actor_id in ('${uuid(1)}','${uuid(2)}','${uuid(3)}') or after->>'user_id' in ('${uuid(2)}','${uuid(3)}')`) === 0,
    'auditoria da demonstração removida')
  check(await one(`select count(*)::int from profiles where email = 'voce@empresa.com' and role = 'admin'`) === 1, 'admin real preservado')
  check(await one(`select count(*)::int from activity_templates`) === before.templates && await one(`select count(*)::int from settings`) === before.settings,
    'modelos e parâmetros intactos')
  const trg = await one(`select count(*)::int from pg_trigger where tgname in ('a_audit','audit_no_update','z_assignments_resync') and tgenabled = 'D'`)
  check(trg === 0, 'gatilhos de auditoria reativados depois da limpeza')

  // 3. Rodar de novo não faz nada
  await db.exec(read('supabase/maintenance/remove_demo_data.sql'))
  check(true, 'segunda execução é inofensiva')
}

await db.close()
process.exit(failed ? 1 : 0)
