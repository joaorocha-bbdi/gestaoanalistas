-- Gerado por scripts/bundle-sql.mjs. Não edite: edite as migrations.

-- >>> 20261113000100_schema.sql
-- =====================================================================
-- Rotina · esquema base
-- Fuso de referência: America/Sao_Paulo. Datas "de negócio" são `date`;
-- instantes (prazo, envio) são `timestamptz`.
-- =====================================================================

create extension if not exists pgcrypto;

create type public.user_role     as enum ('analista', 'admin');
create type public.frequency     as enum ('diaria', 'semanal', 'mensal');
create type public.task_status   as enum (
  'pendente', 'em_andamento', 'concluida_prazo', 'concluida_atraso',
  'bloqueada_gate', 'nao_feita', 'pausada'
);
create type public.review_status as enum ('nao_revisada', 'validada', 'contestada');

-- ---------------------------------------------------------------------
-- Perfis (1:1 com auth.users). Nunca apagamos: desativar = active=false.
-- ---------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete restrict,
  full_name   text not null,
  email       text not null,
  role        public.user_role not null default 'analista',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Parâmetros (chave/valor). Ex.: limites dos gates, dia→curva, rótulos.
-- ---------------------------------------------------------------------
create table public.settings (
  key          text primary key,
  value        jsonb not null,
  label        text not null,
  description  text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.profiles (id)
);

create table public.holidays (
  day    date primary key,
  label  text not null
);

-- ---------------------------------------------------------------------
-- Modelos de atividade.
-- `fields`, `gates` e `followup_fields` são definições versionadas junto
-- com o modelo (jsonb) e copiadas para cada tarefa em `template_snapshot`,
-- para que editar um modelo nunca reescreva o passado.
--
-- FieldDef: { key, label, type: number|text|textarea|select|link|sku_list|date|boolean|group,
--             required?, options?[], options_setting?, help?, note?, default_from?,
--             fields?[] (group), min_items?, item_label? }
-- GateDef:  { key, question, expected: 'sim'|'nao' }
--           question aceita {param} → valor de settings.gate_params.param
-- ---------------------------------------------------------------------
create table public.activity_templates (
  id               uuid primary key default gen_random_uuid(),
  code             text unique,
  name             text not null,
  description      text,
  instructions     jsonb not null default '[]'::jsonb,   -- array de passos (texto)
  frequency        public.frequency not null,
  weekdays         int[] not null default '{1,2,3,4,5}',  -- ISO: 1=seg … 7=dom
  cutoff_time      time not null default '12:00',
  target_qty       int check (target_qty is null or target_qty > 0),
  target_label     text,
  weight           numeric(6,2) not null default 1 check (weight > 0),
  valid_from       date,
  valid_to         date,
  paused           boolean not null default false,
  pause_reason     text,
  assign_all       boolean not null default true,
  shows_curve      boolean not null default false,
  fields           jsonb not null default '[]'::jsonb,
  gates            jsonb not null default '[]'::jsonb,
  followup_fields  jsonb not null default '[]'::jsonb,
  sort_order       int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (valid_to is null or valid_from is null or valid_to >= valid_from),
  check (jsonb_typeof(fields) = 'array' and jsonb_typeof(gates) = 'array')
);

create table public.template_assignments (
  template_id  uuid not null references public.activity_templates (id) on delete cascade,
  user_id      uuid not null references public.profiles (id),
  primary key (template_id, user_id)
);

-- ---------------------------------------------------------------------
-- Instâncias de tarefa. Uma por (modelo, analista, período) — garante
-- idempotência da geração.
-- period_key: diária '2026-11-13' · semanal '2026-W46' · mensal '2026-11'
-- ---------------------------------------------------------------------
create table public.task_instances (
  id                 uuid primary key default gen_random_uuid(),
  template_id        uuid not null references public.activity_templates (id),
  user_id            uuid not null references public.profiles (id),
  period_key         text not null,
  ref_date           date not null,          -- dia de vencimento (data local)
  period_start       date not null,
  period_end         date not null,
  due_at             timestamptz not null,
  curve              text,
  weight             numeric(6,2) not null,
  template_snapshot  jsonb not null,
  status             public.task_status not null default 'pendente',
  review_status      public.review_status not null default 'nao_revisada',
  needs_rework       boolean not null default false,
  payload            jsonb not null default '{}'::jsonb,
  gate_draft         jsonb not null default '{}'::jsonb,
  deviation          jsonb,
  followup           jsonb,
  followup_at        timestamptz,
  started_at         timestamptz,
  submitted_at       timestamptz,               -- último envio (qualquer resultado)
  completed_at       timestamptz,               -- primeira conclusão aceita
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (template_id, user_id, period_key)
);
create index task_instances_user_date on public.task_instances (user_id, ref_date);
create index task_instances_date      on public.task_instances (ref_date);
create index task_instances_status    on public.task_instances (status);

-- Cada tentativa de envio (inclusive as barradas pelo gate).
create table public.task_submissions (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.task_instances (id),
  user_id       uuid not null references public.profiles (id),
  submitted_at  timestamptz not null default now(),
  payload       jsonb not null,
  gate_passed   boolean not null,
  deviation     jsonb,
  result_status public.task_status not null
);
create index task_submissions_task on public.task_submissions (task_id);

create table public.gate_answers (
  id             bigint generated always as identity primary key,
  submission_id  uuid not null references public.task_submissions (id),
  gate_key       text not null,
  question       text not null,
  answer         text not null check (answer in ('sim', 'nao')),
  expected       text not null check (expected in ('sim', 'nao')),
  ok             boolean generated always as (answer = expected) stored
);
create index gate_answers_submission on public.gate_answers (submission_id);

create table public.reviews (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.task_instances (id),
  reviewer_id  uuid not null references public.profiles (id),
  status       public.review_status not null check (status <> 'nao_revisada'),
  reason       text,
  created_at   timestamptz not null default now(),
  check (status <> 'contestada' or coalesce(length(trim(reason)), 0) > 0)
);
create index reviews_task on public.reviews (task_id);

-- Auditoria: append-only (ver 0003).
create table public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor_id   uuid,
  action     text not null,         -- insert | update | delete | submit | review | ...
  entity     text not null,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  changed    text[]
);
create index audit_log_at on public.audit_log (at desc);
create index audit_log_entity on public.audit_log (entity, entity_id);

-- ---------------------------------------------------------------------
-- Helpers de acesso
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin' and active);
$$;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active);
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger profiles_touch  before update on public.profiles           for each row execute function public.touch_updated_at();
create trigger templates_touch before update on public.activity_templates for each row execute function public.touch_updated_at();
create trigger tasks_touch     before update on public.task_instances     for each row execute function public.touch_updated_at();

-- Novo usuário em auth.users → perfil. O papel só vem de app_metadata
-- (definido pelo service role); user_metadata é controlável pelo usuário.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1)),
    new.email,
    case when new.raw_app_meta_data ->> 'role' = 'admin' then 'admin'::user_role else 'analista'::user_role end
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Row Level Security
-- Analista: só lê o que é dele; não escreve direto em tabela nenhuma —
-- toda escrita passa por RPC security definer com validação.
-- ---------------------------------------------------------------------
alter table public.profiles             enable row level security;
alter table public.settings             enable row level security;
alter table public.holidays             enable row level security;
alter table public.activity_templates   enable row level security;
alter table public.template_assignments enable row level security;
alter table public.task_instances       enable row level security;
alter table public.task_submissions     enable row level security;
alter table public.gate_answers         enable row level security;
alter table public.reviews              enable row level security;
alter table public.audit_log            enable row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- settings / holidays: leitura para usuários ativos, escrita admin
create policy settings_select on public.settings for select to authenticated using (public.is_active_user());
create policy settings_write  on public.settings for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy holidays_select on public.holidays for select to authenticated using (public.is_active_user());
create policy holidays_write  on public.holidays for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- modelos: admin tudo; analista lê só os atribuídos a ele
create policy templates_select on public.activity_templates for select to authenticated
  using (
    public.is_admin()
    or (public.is_active_user() and (assign_all or exists (
      select 1 from public.template_assignments a
      where a.template_id = activity_templates.id and a.user_id = auth.uid())))
  );
create policy templates_write on public.activity_templates for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy assignments_select on public.template_assignments for select to authenticated
  using (public.is_admin() or user_id = auth.uid());
create policy assignments_write on public.template_assignments for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- tarefas
create policy tasks_select on public.task_instances for select to authenticated
  using (public.is_admin() or (user_id = auth.uid() and public.is_active_user()));

create policy submissions_select on public.task_submissions for select to authenticated
  using (public.is_admin() or (user_id = auth.uid() and public.is_active_user()));

create policy gate_answers_select on public.gate_answers for select to authenticated
  using (public.is_admin() or exists (
    select 1 from public.task_submissions s where s.id = submission_id and s.user_id = auth.uid()));

create policy reviews_select on public.reviews for select to authenticated
  using (public.is_admin() or exists (
    select 1 from public.task_instances t where t.id = task_id and t.user_id = auth.uid()));

-- auditoria: só admin lê; ninguém escreve via API
create policy audit_select on public.audit_log for select to authenticated using (public.is_admin());

-- Privilégios de tabela: anon não vê nada; authenticated só lê (RLS filtra),
-- escrita direta apenas onde há policy de admin.
revoke all on all tables in schema public from anon;
revoke insert, update, delete on public.task_instances, public.task_submissions,
  public.gate_answers, public.reviews, public.audit_log from authenticated;


-- >>> 20261113000200_functions.sql
-- =====================================================================
-- Rotina · regras de negócio no banco
-- Toda escrita de analista passa por estas funções (security definer).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Datas
-- ---------------------------------------------------------------------
create or replace function public.local_today()
returns date language sql stable as $$
  select (now() at time zone 'America/Sao_Paulo')::date;
$$;

-- Instante do prazo: dia local + horário local em America/Sao_Paulo.
create or replace function public.local_due(d date, t time)
returns timestamptz language sql immutable as $$
  select (d + t) at time zone 'America/Sao_Paulo';
$$;

create or replace function public.setting(p_key text)
returns jsonb language sql stable security definer set search_path = public as $$
  select value from settings where key = p_key;
$$;

create or replace function public.is_workday(d date)
returns boolean language sql stable security definer set search_path = public as $$
  select extract(isodow from d)::int = any (
           coalesce((select array(select jsonb_array_elements_text(value)::int)
                     from settings where key = 'dias_uteis'), '{1,2,3,4,5}'))
     and not exists (select 1 from holidays h where h.day = d);
$$;

create or replace function public.week_end(d date)
returns date language sql immutable as $$
  select date_trunc('week', d)::date + 6;
$$;

-- Vencimento semanal: último dia útil da semana até o maior dia configurado.
create or replace function public.weekly_due(wk date, weekdays int[])
returns date language sql stable as $$
  select max(g::date)
  from generate_series(wk, wk + (coalesce((select max(x) from unnest(weekdays) x), 5) - 1), interval '1 day') g
  where public.is_workday(g::date);
$$;

-- Vencimento mensal: último dia útil do mês.
create or replace function public.monthly_due(m date)
returns date language sql stable as $$
  select max(g::date)
  from generate_series(date_trunc('month', m)::date,
                       (date_trunc('month', m) + interval '1 month - 1 day')::date, interval '1 day') g
  where public.is_workday(g::date);
$$;

create or replace function public.curve_for(d date)
returns text language sql stable security definer set search_path = public as $$
  select value ->> extract(isodow from d)::int::text from settings where key = 'curva_por_dia';
$$;

-- Status de prazo de uma conclusão aceita.
create or replace function public.deadline_status(p_submitted timestamptz, p_due timestamptz)
returns public.task_status language sql immutable as $$
  select case when p_submitted <= p_due then 'concluida_prazo'::task_status
              else 'concluida_atraso'::task_status end;
$$;

-- Texto da pergunta com {parametros} substituídos.
create or replace function public.render_text(p_text text)
returns text language plpgsql stable security definer set search_path = public as $$
declare r record; res text := p_text;
begin
  for r in select key, value from jsonb_each_text(coalesce(setting('gate_params'), '{}')) loop
    res := replace(res, '{' || r.key || '}', r.value);
  end loop;
  res := replace(res, '{concorrente}', coalesce(setting('rotulo_concorrente') #>> '{}', 'concorrente'));
  return res;
end $$;

-- ---------------------------------------------------------------------
-- Validação de campos obrigatórios (espelhada em src/lib/fields.ts)
-- ---------------------------------------------------------------------
create or replace function public.is_blank(v jsonb)
returns boolean language sql immutable as $$
  select v is null
      or jsonb_typeof(v) = 'null'
      or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') = '')
      or (jsonb_typeof(v) = 'array'  and jsonb_array_length(v) = 0);
$$;

create or replace function public.missing_fields(p_defs jsonb, p_data jsonb, p_prefix text default '')
returns text[] language plpgsql immutable as $$
declare
  f jsonb; v jsonb; item jsonb; i int; min_items int; lbl text;
  res text[] := '{}';
begin
  for f in select * from jsonb_array_elements(coalesce(p_defs, '[]'::jsonb)) loop
    v   := coalesce(p_data, '{}'::jsonb) -> (f ->> 'key');
    lbl := p_prefix || (f ->> 'label');
    if f ->> 'type' = 'group' then
      min_items := coalesce((f ->> 'min_items')::int,
                            case when coalesce((f ->> 'required')::boolean, false) then 1 else 0 end);
      if v is null or jsonb_typeof(v) <> 'array' then
        if min_items > 0 then res := res || lbl; end if;
        continue;
      end if;
      if jsonb_array_length(v) < min_items then
        res := res || format('%s (mínimo %s, informado %s)', lbl, min_items, jsonb_array_length(v));
      end if;
      i := 0;
      for item in select * from jsonb_array_elements(v) loop
        i := i + 1;
        res := res || public.missing_fields(f -> 'fields', item,
                 format('%s %s · ', coalesce(f ->> 'item_label', f ->> 'label'), i));
      end loop;
    elsif coalesce((f ->> 'required')::boolean, false) and public.is_blank(v) then
      res := res || lbl;
    end if;
  end loop;
  return res;
end $$;

-- ---------------------------------------------------------------------
-- Geração de tarefas — idempotente (unique + on conflict do nothing).
-- Regras: modelo ativo, dentro da vigência, dia útil (dias_uteis + feriados),
-- analistas ativos atribuídos. Não cria tarefa cujo prazo já tinha passado
-- quando o modelo ou o analista foi criado (evita "não feita" injusta).
-- ---------------------------------------------------------------------
create or replace function public.generate_tasks(p_from date, p_to date)
returns int language plpgsql security definer set search_path = public as $$
declare d date; wk date; mo date; n int := 0; c int;
begin
  if p_to < p_from then return 0; end if;
  if p_to - p_from > 400 then raise exception 'Intervalo grande demais (máx. 400 dias).'; end if;

  -- Diárias
  for d in select g::date from generate_series(p_from, p_to, interval '1 day') g loop
    continue when not is_workday(d);
    insert into task_instances (template_id, user_id, period_key, ref_date, period_start, period_end,
                                due_at, curve, weight, template_snapshot)
    select t.id, u.id, to_char(d, 'YYYY-MM-DD'), d, d, d,
           local_due(d, t.cutoff_time),
           case when t.shows_curve then curve_for(d) end,
           t.weight, to_jsonb(t) - 'created_at' - 'updated_at'
    from activity_templates t
    join profiles u on u.role = 'analista' and u.active
    where t.frequency = 'diaria' and not t.paused
      and extract(isodow from d)::int = any (t.weekdays)
      and (t.valid_from is null or d >= t.valid_from)
      and (t.valid_to   is null or d <= t.valid_to)
      and (t.assign_all or exists (select 1 from template_assignments a
                                   where a.template_id = t.id and a.user_id = u.id))
      and local_due(d, t.cutoff_time) > greatest(t.created_at, u.created_at)
    on conflict (template_id, user_id, period_key) do nothing;
    get diagnostics c = row_count; n := n + c;
  end loop;

  -- Semanais (semana ISO, vence no último dia útil até o maior dia configurado)
  for wk in select g::date from generate_series(date_trunc('week', p_from)::date, p_to, interval '7 day') g loop
    insert into task_instances (template_id, user_id, period_key, ref_date, period_start, period_end,
                                due_at, curve, weight, template_snapshot)
    select t.id, u.id, to_char(wk, 'IYYY-"W"IW'), x.due, wk, wk + 6,
           local_due(x.due, t.cutoff_time), null, t.weight,
           to_jsonb(t) - 'created_at' - 'updated_at'
    from activity_templates t
    cross join lateral (select weekly_due(wk, t.weekdays) as due) x
    join profiles u on u.role = 'analista' and u.active
    where t.frequency = 'semanal' and not t.paused and x.due is not null
      and (t.valid_from is null or wk + 6 >= t.valid_from)
      and (t.valid_to   is null or wk     <= t.valid_to)
      and (t.assign_all or exists (select 1 from template_assignments a
                                   where a.template_id = t.id and a.user_id = u.id))
      and local_due(x.due, t.cutoff_time) > greatest(t.created_at, u.created_at)
    on conflict (template_id, user_id, period_key) do nothing;
    get diagnostics c = row_count; n := n + c;
  end loop;

  -- Mensais (vence no último dia útil do mês)
  for mo in select g::date from generate_series(date_trunc('month', p_from)::date, p_to, interval '1 month') g loop
    insert into task_instances (template_id, user_id, period_key, ref_date, period_start, period_end,
                                due_at, curve, weight, template_snapshot)
    select t.id, u.id, to_char(mo, 'YYYY-MM'), x.due, mo, (mo + interval '1 month - 1 day')::date,
           local_due(x.due, t.cutoff_time), null, t.weight,
           to_jsonb(t) - 'created_at' - 'updated_at'
    from activity_templates t
    cross join lateral (select monthly_due(mo) as due) x
    join profiles u on u.role = 'analista' and u.active
    where t.frequency = 'mensal' and not t.paused and x.due is not null
      and (t.valid_from is null or (mo + interval '1 month - 1 day')::date >= t.valid_from)
      and (t.valid_to   is null or mo <= t.valid_to)
      and (t.assign_all or exists (select 1 from template_assignments a
                                   where a.template_id = t.id and a.user_id = u.id))
      and local_due(x.due, t.cutoff_time) > greatest(t.created_at, u.created_at)
    on conflict (template_id, user_id, period_key) do nothing;
    get diagnostics c = row_count; n := n + c;
  end loop;

  return n;
end $$;

-- Vencidas sem conclusão → "não feita". Idempotente.
create or replace function public.mark_overdue()
returns int language plpgsql security definer set search_path = public as $$
declare c int;
begin
  perform set_config('app.audit_action', 'vencimento', true);
  update task_instances set status = 'nao_feita'
   where status in ('pendente', 'em_andamento', 'bloqueada_gate') and due_at < now();
  get diagnostics c = row_count;
  perform set_config('app.audit_action', '', true);
  return c;
end $$;

-- Chamado pelo app ao abrir (cobre falha do job agendado) e pelo pg_cron.
create or replace function public.refresh_tasks()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not is_active_user() then return; end if;
  perform generate_tasks(local_today(), week_end(local_today()));
  perform mark_overdue();
end $$;

-- Re-sincroniza tarefas futuras de um modelo após edição, pausa ou
-- mudança de atribuição. Só remove tarefas intocadas (sem rascunho/envio);
-- as já iniciadas viram "pausada" quando o modelo é pausado.
create or replace function public.resync_template(p_template uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t activity_templates;
begin
  select * into t from activity_templates where id = p_template;
  perform set_config('app.audit_action', 'ressincronizacao', true);

  delete from task_instances ti
   where ti.template_id = p_template and ti.ref_date >= local_today()
     and ti.status = 'pendente' and ti.started_at is null and ti.submitted_at is null
     and ti.payload = '{}'::jsonb
     and not exists (select 1 from task_submissions s where s.task_id = ti.id);

  if t.id is not null and t.paused then
    update task_instances set status = 'pausada'
     where template_id = p_template and ref_date >= local_today()
       and status in ('pendente', 'em_andamento', 'bloqueada_gate');
  elsif t.id is not null then
    update task_instances
       set status = case when started_at is null then 'pendente'::task_status else 'em_andamento'::task_status end
     where template_id = p_template and ref_date >= local_today() and status = 'pausada';
  end if;

  perform set_config('app.audit_action', '', true);
  perform generate_tasks(local_today(), week_end(local_today()));
end $$;

create or replace function public.trg_template_resync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then perform resync_template(old.template_id);
  else perform resync_template(new.template_id); end if;
  return null;
end $$;

create or replace function public.trg_template_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform resync_template(new.id);
  return null;
end $$;

create trigger z_templates_resync after insert or update on public.activity_templates
  for each row execute function public.trg_template_changed();
create trigger z_assignments_resync after insert or delete on public.template_assignments
  for each row execute function public.trg_template_resync();

-- Perfil desativado ou promovido a admin: tarefas abertas futuras saem do cálculo.
create or replace function public.trg_profile_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.active is distinct from old.active) or (new.role is distinct from old.role) then
    if not new.active or new.role <> 'analista' then
      perform set_config('app.audit_action', 'ressincronizacao', true);
      delete from task_instances ti
       where ti.user_id = new.id and ti.ref_date >= local_today() and ti.status = 'pendente'
         and ti.started_at is null and ti.submitted_at is null
         and not exists (select 1 from task_submissions s where s.task_id = ti.id);
      update task_instances set status = 'pausada'
       where user_id = new.id and ref_date >= local_today()
         and status in ('pendente', 'em_andamento', 'bloqueada_gate');
      perform set_config('app.audit_action', '', true);
    else
      update task_instances
         set status = case when started_at is null then 'pendente'::task_status else 'em_andamento'::task_status end
       where user_id = new.id and ref_date >= local_today() and status = 'pausada';
      perform generate_tasks(local_today(), week_end(local_today()));
    end if;
  end if;
  return null;
end $$;

create trigger z_profiles_changed after update on public.profiles
  for each row execute function public.trg_profile_changed();

-- ---------------------------------------------------------------------
-- Ações do analista
-- ---------------------------------------------------------------------
create or replace function public.load_own_task(p_task uuid)
returns public.task_instances language plpgsql security definer set search_path = public as $$
declare t task_instances;
begin
  select * into t from task_instances where id = p_task for update;
  if not found or t.user_id is distinct from auth.uid() then
    raise exception 'Atividade não encontrada.' using errcode = 'P0002';
  end if;
  if not is_active_user() then
    raise exception 'Usuário inativo.' using errcode = '42501';
  end if;
  if t.status = 'pausada' then
    raise exception 'Esta atividade está pausada e não aceita registros.' using errcode = '22023';
  end if;
  return t;
end $$;

create or replace function public.save_draft(p_task uuid, p_payload jsonb, p_gates jsonb default '{}', p_deviation jsonb default null)
returns public.task_instances language plpgsql security definer set search_path = public as $$
declare t task_instances;
begin
  t := load_own_task(p_task);
  if t.status in ('concluida_prazo', 'concluida_atraso') and not t.needs_rework then
    raise exception 'Atividade já concluída.' using errcode = '22023';
  end if;
  perform set_config('app.audit_action', 'rascunho', true);
  update task_instances
     set payload    = coalesce(p_payload, '{}'::jsonb),
         gate_draft = coalesce(p_gates, '{}'::jsonb),
         deviation  = p_deviation,
         status     = case when status = 'pendente' then 'em_andamento'::task_status else status end,
         started_at = coalesce(started_at, now())
   where id = p_task
  returning * into t;
  perform set_config('app.audit_action', '', true);
  return t;
end $$;

-- Envio. Se algum gate não tiver a resposta esperada, a atividade fica
-- "bloqueada pelo gate" e é obrigatório informar SKUs em desvio e ação.
-- Só com todos os gates satisfeitos e campos obrigatórios preenchidos
-- a atividade é concluída (no prazo ou com atraso, conforme o horário).
create or replace function public.submit_task(p_task uuid, p_payload jsonb, p_gates jsonb default '{}', p_deviation jsonb default null)
returns public.task_instances language plpgsql security definer set search_path = public as $$
declare
  t task_instances; g jsonb; ans text; passed boolean := true;
  missing text[]; sub_id uuid; new_status task_status; v_now timestamptz := now();
begin
  t := load_own_task(p_task);
  if t.status in ('concluida_prazo', 'concluida_atraso') and not t.needs_rework then
    raise exception 'Atividade já concluída. Só pode ser reenviada se for contestada na revisão.' using errcode = '22023';
  end if;
  p_payload := coalesce(p_payload, '{}'::jsonb);
  p_gates   := coalesce(p_gates, '{}'::jsonb);

  for g in select * from jsonb_array_elements(coalesce(t.template_snapshot -> 'gates', '[]'::jsonb)) loop
    ans := p_gates ->> (g ->> 'key');
    if ans is null or ans not in ('sim', 'nao') then
      raise exception 'Responda todas as perguntas de verificação antes de enviar.' using errcode = '22023';
    end if;
    if ans <> (g ->> 'expected') then passed := false; end if;
  end loop;

  if not passed then
    if p_deviation is null
       or jsonb_typeof(p_deviation -> 'skus') is distinct from 'array'
       or jsonb_array_length(p_deviation -> 'skus') = 0
       or coalesce(btrim(p_deviation ->> 'action'), '') = '' then
      raise exception 'Verificação não satisfeita: liste os SKUs em desvio e a ação tomada.' using errcode = '22023';
    end if;
    new_status := 'bloqueada_gate';
  else
    missing := missing_fields(t.template_snapshot -> 'fields', p_payload);
    if coalesce(array_length(missing, 1), 0) > 0 then
      raise exception 'Preencha os campos obrigatórios: %', array_to_string(missing, '; ') using errcode = '22023';
    end if;
    -- Reenvio após contestação mantém a pontualidade da conclusão original.
    new_status := case when t.needs_rework and t.status in ('concluida_prazo', 'concluida_atraso')
                       then t.status else deadline_status(v_now, t.due_at) end;
  end if;

  insert into task_submissions (task_id, user_id, submitted_at, payload, gate_passed, deviation, result_status)
  values (t.id, t.user_id, v_now, p_payload, passed, case when passed then null else p_deviation end, new_status)
  returning id into sub_id;

  insert into gate_answers (submission_id, gate_key, question, answer, expected)
  select sub_id, gd.value ->> 'key', render_text(gd.value ->> 'question'), p_gates ->> (gd.value ->> 'key'), gd.value ->> 'expected'
  from jsonb_array_elements(coalesce(t.template_snapshot -> 'gates', '[]'::jsonb)) gd;

  perform set_config('app.audit_action', case when passed then 'envio' else 'bloqueio_gate' end, true);
  update task_instances
     set payload       = p_payload,
         gate_draft    = p_gates,
         deviation     = case when passed then null else p_deviation end,
         status        = new_status,
         submitted_at  = v_now,
         started_at    = coalesce(started_at, v_now),
         completed_at  = case when passed then coalesce(completed_at, v_now) else completed_at end,
         review_status = case when passed and needs_rework then 'nao_revisada'::review_status else review_status end,
         needs_rework  = case when passed then false else needs_rework end
   where id = t.id
  returning * into t;
  perform set_config('app.audit_action', '', true);
  return t;
end $$;

-- Leitura posterior (ex.: resultado de testes do M3). Não altera status nem prazo.
create or replace function public.record_followup(p_task uuid, p_data jsonb)
returns public.task_instances language plpgsql security definer set search_path = public as $$
declare t task_instances;
begin
  t := load_own_task(p_task);
  if t.status not in ('concluida_prazo', 'concluida_atraso') then
    raise exception 'Conclua a execução antes de registrar a leitura.' using errcode = '22023';
  end if;
  perform set_config('app.audit_action', 'leitura', true);
  update task_instances set followup = p_data, followup_at = now() where id = p_task returning * into t;
  perform set_config('app.audit_action', '', true);
  return t;
end $$;

-- ---------------------------------------------------------------------
-- Ações do admin
-- ---------------------------------------------------------------------
create or replace function public.review_task(p_task uuid, p_status public.review_status, p_reason text default null)
returns public.task_instances language plpgsql security definer set search_path = public as $$
declare t task_instances;
begin
  if not is_admin() then raise exception 'Apenas admin pode revisar.' using errcode = '42501'; end if;
  if p_status = 'nao_revisada' then raise exception 'Escolha validar ou contestar.' using errcode = '22023'; end if;
  if p_status = 'contestada' and coalesce(btrim(p_reason), '') = '' then
    raise exception 'Informe o motivo da contestação.' using errcode = '22023';
  end if;
  select * into t from task_instances where id = p_task for update;
  if not found then raise exception 'Atividade não encontrada.' using errcode = 'P0002'; end if;
  if t.status not in ('concluida_prazo', 'concluida_atraso') then
    raise exception 'Só conclusões podem ser revisadas.' using errcode = '22023';
  end if;

  insert into reviews (task_id, reviewer_id, status, reason) values (p_task, auth.uid(), p_status, nullif(btrim(p_reason), ''));

  perform set_config('app.audit_action', 'revisao', true);
  update task_instances
     set review_status = p_status,
         needs_rework  = (p_status = 'contestada')
   where id = p_task
  returning * into t;
  perform set_config('app.audit_action', '', true);
  return t;
end $$;

-- ---------------------------------------------------------------------
-- Fatos por tarefa para métricas (security_invoker: respeita RLS).
-- Toda métrica do app é agregada a partir desta view — nada de contador.
-- ---------------------------------------------------------------------
create or replace view public.v_task_facts with (security_invoker = true) as
select
  t.id, t.user_id, p.full_name, t.template_id,
  t.template_snapshot ->> 'code'      as template_code,
  t.template_snapshot ->> 'name'      as template_name,
  t.template_snapshot ->> 'frequency' as frequency,
  t.period_key, t.ref_date, t.due_at, t.curve, t.weight,
  t.status, t.review_status, t.needs_rework, t.submitted_at, t.completed_at,
  (t.status <> 'pausada' and (t.due_at <= now() or t.status in ('concluida_prazo', 'concluida_atraso'))) as expected,
  t.status in ('concluida_prazo', 'concluida_atraso')                         as completed,
  t.status = 'concluida_prazo'                                                 as on_time,
  jsonb_array_length(coalesce(t.template_snapshot -> 'gates', '[]'::jsonb)) > 0 as has_gates,
  (select count(*) from task_submissions s where s.task_id = t.id)::int                      as submission_count,
  (select count(*) from task_submissions s where s.task_id = t.id and not s.gate_passed)::int as gate_block_count,
  exists (select 1 from reviews r where r.task_id = t.id)                              as reviewed,
  exists (select 1 from reviews r where r.task_id = t.id and r.status = 'contestada')  as contested,
  abs(hashtext(t.id::text)) % 100                                                      as sample_bucket
from task_instances t
join profiles p on p.id = t.user_id;

-- ---------------------------------------------------------------------
-- Privilégios de execução
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.is_admin(), public.is_active_user(), public.local_today(), public.setting(text),
  public.refresh_tasks(), public.save_draft(uuid, jsonb, jsonb, jsonb),
  public.submit_task(uuid, jsonb, jsonb, jsonb), public.record_followup(uuid, jsonb),
  public.review_task(uuid, public.review_status, text), public.render_text(text),
  public.missing_fields(jsonb, jsonb, text), public.is_blank(jsonb),
  public.deadline_status(timestamptz, timestamptz), public.local_due(date, time)
to authenticated;
-- generate_tasks / mark_overdue / resync_template: só via refresh_tasks, triggers e pg_cron.
grant select on public.v_task_facts to authenticated;


-- >>> 20261113000300_audit.sql
-- =====================================================================
-- Rotina · auditoria imutável
-- Captura toda alteração relevante via trigger. A ação vem de
-- app.audit_action (definida pelas RPCs: envio, bloqueio_gate, revisao…)
-- ou do tipo da operação (insert/update/delete).
-- =====================================================================

create or replace function public.audit_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  b jsonb; a jsonb; ch text[]; act text; eid text;
begin
  if tg_op in ('UPDATE', 'DELETE') then b := to_jsonb(old) - 'template_snapshot'; end if;
  if tg_op in ('INSERT', 'UPDATE') then a := to_jsonb(new) - 'template_snapshot'; end if;

  if tg_op = 'UPDATE' then
    select array_agg(e.key order by e.key) into ch
      from jsonb_each(a) e
     where e.key not in ('updated_at') and (b -> e.key) is distinct from e.value;
    if ch is null then return new; end if;
  end if;

  act := coalesce(nullif(current_setting('app.audit_action', true), ''), lower(tg_op));
  eid := coalesce(a ->> 'id', b ->> 'id', a ->> 'key', b ->> 'key', a ->> 'day', b ->> 'day',
                  coalesce(a ->> 'template_id', b ->> 'template_id') || ':' || coalesce(a ->> 'user_id', b ->> 'user_id'));

  insert into audit_log (actor_id, action, entity, entity_id, before, after, changed)
  values (auth.uid(), act, tg_table_name, eid, b, a, ch);

  return coalesce(new, old);
end $$;

-- Tarefas: geração (insert) não é auditada; envios, revisões e edições sim.
create trigger a_audit after update or delete on public.task_instances
  for each row execute function public.audit_trigger();
create trigger a_audit after insert on public.reviews
  for each row execute function public.audit_trigger();
create trigger a_audit after insert or update or delete on public.activity_templates
  for each row execute function public.audit_trigger();
create trigger a_audit after insert or delete on public.template_assignments
  for each row execute function public.audit_trigger();
create trigger a_audit after insert or update or delete on public.profiles
  for each row execute function public.audit_trigger();
create trigger a_audit after insert or update or delete on public.settings
  for each row execute function public.audit_trigger();
create trigger a_audit after insert or update or delete on public.holidays
  for each row execute function public.audit_trigger();

-- Imutabilidade: nem o dono das tabelas altera ou apaga registros de auditoria.
create or replace function public.audit_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'O log de auditoria é imutável.' using errcode = '42501';
end $$;

create trigger audit_no_update before update or delete on public.audit_log
  for each row execute function public.audit_immutable();
create trigger audit_no_truncate before truncate on public.audit_log
  for each statement execute function public.audit_immutable();

revoke insert, update, delete, truncate on public.audit_log from authenticated, anon;

-- Quem alterou o parâmetro
create or replace function public.settings_stamp()
returns trigger language plpgsql as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
create trigger settings_stamp before insert or update on public.settings
  for each row execute function public.settings_stamp();

revoke execute on function public.audit_trigger(), public.audit_immutable(), public.settings_stamp()
  from public, anon, authenticated;


-- >>> 20261113000400_seed_config.sql
-- =====================================================================
-- Rotina · parâmetros padrão e modelos de atividade iniciais
-- Textos aceitam {concorrente} e {limite_*} (ver settings).
-- =====================================================================

insert into public.settings (key, value, label, description) values
  ('gate_params',            '{"limite_venda": 80, "limite_folga": 0}', 'Limites das verificações',
   'Valores usados nas perguntas-gate da precificação diária.'),
  ('curva_por_dia',          '{"1":"A","2":"B","3":"C","4":"D","5":"E"}', 'Curva por dia da semana',
   'Qual curva cada dia útil precifica. Dia sem curva fica sem rotação.'),
  ('curvas',                 '["A","B","C","D","E"]', 'Curvas disponíveis', null),
  ('rotulo_concorrente',     '"BGT"', 'Concorrente de referência',
   'Nome exibido nas instruções e perguntas (ex.: BGT).'),
  ('dias_uteis',             '[1,2,3,4,5]', 'Dias de expediente', 'ISO: 1 = segunda … 7 = domingo.'),
  ('pesos_eficiencia',       '{"conclusao":40,"pontualidade":30,"qualidade":30}', 'Pesos do índice de eficiência',
   'Composição do índice 0–100. Os pesos são normalizados pela soma.'),
  ('amostragem_revisao',     '20', 'Amostra de revisão (%)',
   'Percentual de conclusões sorteadas de forma estável para revisão.'),
  ('status_pedido_opcoes',   '["Não iniciado","Em cotação","Pedido feito","Outro"]', 'Status do pedido de compra', null),
  ('status_importacao_opcoes','["Em produção","Embarcada","Em trânsito","Em desembaraço","Recebida","Outro"]', 'Status da importação', null),
  ('hub_url',                '"https://ceo61.github.io/bb-hub/"', 'Endereço do hub', null)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Modelos
-- ---------------------------------------------------------------------
insert into public.activity_templates
  (code, name, description, instructions, frequency, weekdays, cutoff_time, target_qty, target_label,
   weight, valid_from, valid_to, paused, pause_reason, shows_curve, fields, gates, followup_fields, sort_order)
values
-- D1 ------------------------------------------------------------------
('D1', 'Descontos Black Friday',
 'Conferir o que muda hoje na campanha e separar o que bate de frente com a {concorrente}.',
 '["Abrir o hub e clicar em “ver o que vai mudar hoje”.",
   "Conferir os produtos listados.",
   "Separar o range de produtos que vão bater de frente com a {concorrente} e os que não vão."]',
 'diaria', '{1,2,3,4,5}', '12:00', null, null,
 1, '2026-11-01', '2026-11-30', false, null, false,
 '[{"key":"colidem","label":"Produtos que colidem com a {concorrente}","type":"number","required":true},
   {"key":"nao_colidem","label":"Produtos que não colidem","type":"number","required":true},
   {"key":"observacoes","label":"Observações","type":"textarea"}]',
 '[]', '[]', 10),

-- D2 ------------------------------------------------------------------
('D2', 'Precificação diária por curva',
 'Precificar a curva do dia e garantir que a {concorrente} está mapeada.',
 '["Abrir a curva do dia indicada no card.",
   "Precificar considerando tudo o que foi alinhado nas reuniões.",
   "Para cada produto, verificar o mapeamento da {concorrente}: eles têm o produto? Falta o link para rastrearmos o preço?",
   "Responder as verificações. Se alguma for SIM, listar os SKUs em desvio e a ação tomada."]',
 'diaria', '{1,2,3,4,5}', '11:00', null, null,
 2, null, null, false, null, true,
 '[{"key":"curva","label":"Curva trabalhada","type":"select","options_setting":"curvas","default_from":"curva_do_dia","required":true},
   {"key":"qtd_precificados","label":"Produtos precificados","type":"number","required":true},
   {"key":"skus_link","label":"SKUs que precisaram de link {concorrente}","type":"list","mono":true,"help":"Um SKU por linha. A quantidade é contada automaticamente."},
   {"key":"diretrizes","label":"Diretrizes de reunião aplicadas","type":"textarea","required":true}]',
 '[{"key":"venda_abaixo","question":"Há algum item com venda abaixo de {limite_venda}%?","expected":"nao"},
   {"key":"folga_abaixo","question":"Há algum item com folga abaixo de {limite_folga}?","expected":"nao"}]',
 '[]', 20),

-- D3 ------------------------------------------------------------------
('D3', 'Check de 2 produtos com giro',
 'Revisão completa de dois produtos que giram, entendendo por que convertem.',
 '["Escolher 2 produtos com giro.",
   "Para cada um, percorrer o checklist até o fim antes de passar ao próximo."]',
 'diaria', '{1,2,3,4,5}', '17:00', 2, 'produtos',
 1, null, null, false, null, false,
 '[{"key":"produtos","label":"Produtos","type":"group","item_label":"Produto","min_items":2,"fields":[
     {"key":"sku","label":"SKU","type":"text","mono":true,"required":true},
     {"key":"compatibilidades","label":"Compatibilidades verificadas","type":"boolean","required":true},
     {"key":"lixos","label":"Lixos removidos","type":"boolean","required":true,
      "note":"Candidato a integração: remover lixos depende de sistemas da tecnologia. Na v1 é verificação manual."},
     {"key":"variacoes","label":"Variações que mais e menos convertem","type":"textarea","required":true},
     {"key":"renovar_fotos","label":"Kit de fotos precisa ser renovado?","type":"boolean","required":true},
     {"key":"alterar_descricao","label":"Descrição precisa de alteração?","type":"boolean","required":true},
     {"key":"botoes_coesos","label":"Nomes dos botões de SKU estão coesos","type":"boolean","required":true},
     {"key":"pdp_revisada","label":"PDP completa revisada","type":"boolean","required":true},
     {"key":"por_que_converte","label":"Por que o produto converte bem","type":"text","required":true},
     {"key":"observacoes","label":"Observações","type":"textarea"}]}]',
 '[]', '[]', 30),

-- D4 ------------------------------------------------------------------
('D4', '5 produtos entupidos',
 'Estoque parado: diagnosticar por que não vende e traçar estratégia.',
 '["Selecionar 5 produtos com estoque parado.",
   "Para cada um, registrar o diagnóstico e a estratégia."]',
 'diaria', '{1,2,3,4,5}', '17:00', 5, 'produtos',
 1, null, null, true, 'Segurar para a próxima onda.', false,
 '[{"key":"produtos","label":"Produtos","type":"group","item_label":"Produto","min_items":5,"fields":[
     {"key":"sku","label":"SKU","type":"text","mono":true,"required":true},
     {"key":"motivo","label":"Motivo de não vender","type":"select","required":true,
      "options":["Falta de compatibilidade","Falta de fotos","Preço ruim","Outro"]},
     {"key":"diagnostico","label":"Diagnóstico","type":"textarea","required":true},
     {"key":"estrategia","label":"Estratégia traçada","type":"textarea","required":true}]}]',
 '[]', '[]', 40),

-- D5 ------------------------------------------------------------------
('D5', 'Acompanhamento da concorrência',
 'Ler o movimento de preço da concorrência na categoria e transformar em ação.',
 '["Abrir a aba de concorrência no hub.",
   "Verificar se a concorrência abaixou, manteve ou aumentou preço na categoria.",
   "Identificar oportunidades de mercado e associar uma ação a cada uma."]',
 'diaria', '{1,2,3,4,5}', '16:00', null, null,
 1, null, null, false, null, false,
 '[{"key":"categoria","label":"Categoria analisada","type":"text","required":true},
   {"key":"movimento","label":"Movimento observado","type":"select","required":true,"options":["Abaixou","Manteve","Aumentou"]},
   {"key":"oportunidade","label":"Oportunidade identificada","type":"textarea","required":true},
   {"key":"acao","label":"Ação proposta","type":"textarea","required":true}]',
 '[]', '[]', 50),

-- S1 ------------------------------------------------------------------
('S1', 'Acompanhamento do pedido de compra',
 'Saber o volume necessário e em que pé está o pedido.',
 '["Abrir o hub na aba importações: https://ceo61.github.io/bb-hub/?#importacoes",
   "Conferir o volume de pedido necessário.",
   "Confirmar se o pedido já foi feito, se está em cotação ou parado."]',
 'semanal', '{5}', '17:00', null, null,
 1, null, null, false, null, false,
 '[{"key":"status_pedido","label":"Status do pedido","type":"select","options_setting":"status_pedido_opcoes","required":true},
   {"key":"volume","label":"Volume necessário","type":"number","required":true},
   {"key":"observacoes","label":"Observações","type":"textarea"}]',
 '[]', '[]', 60),

-- M1 ------------------------------------------------------------------
('M1', 'Acompanhamento da importação',
 'Estar totalmente por dentro da importação, inclusive da data de chegada da carga.',
 '["Levantar o status atual da importação.", "Confirmar a data prevista de chegada da carga."]',
 'mensal', '{1,2,3,4,5}', '17:00', null, null,
 1, null, null, false, null, false,
 '[{"key":"status_importacao","label":"Status da importação","type":"select","options_setting":"status_importacao_opcoes","required":true},
   {"key":"chegada","label":"Data prevista de chegada","type":"date","required":true},
   {"key":"observacoes","label":"Observações","type":"textarea"}]',
 '[]', '[]', 70),

-- M2 ------------------------------------------------------------------
('M2', 'Pesquisa de mercado da categoria',
 'Comparar nosso ticket com o mercado na categoria.',
 '["Escolher a categoria.", "Levantar preços praticados pelo mercado.", "Concluir se nosso ticket está acima, abaixo ou igual."]',
 'mensal', '{1,2,3,4,5}', '17:00', null, null,
 1, null, null, false, null, false,
 '[{"key":"categoria","label":"Categoria","type":"text","required":true},
   {"key":"ticket","label":"Nosso ticket em relação ao mercado","type":"select","required":true,"options":["Maior","Igual","Menor"]},
   {"key":"evidencias","label":"Evidências e links","type":"list","required":true,"help":"Um link ou evidência por linha."},
   {"key":"observacoes","label":"Observações","type":"textarea"}]',
 '[]', '[]', 80),

-- M3 ------------------------------------------------------------------
('M3', 'Dois testes de estratégia por categoria',
 'Executar dois testes no mês e registrar a leitura do resultado quando sair.',
 '["Definir a hipótese de cada teste.",
   "Aplicar a alteração (ex.: trocar o kit de fotos de 2 produtos de teclado).",
   "Registrar a métrica de antes e a data prevista de leitura.",
   "Quando a leitura sair, registrar métrica depois e conclusão em “Registrar leitura”."]',
 'mensal', '{1,2,3,4,5}', '17:00', 2, 'testes',
 1, null, null, false, null, false,
 '[{"key":"testes","label":"Testes","type":"group","item_label":"Teste","min_items":2,"fields":[
     {"key":"hipotese","label":"Hipótese","type":"textarea","required":true},
     {"key":"alvo","label":"Produto ou categoria","type":"text","required":true},
     {"key":"alteracao","label":"O que foi alterado","type":"textarea","required":true},
     {"key":"metrica_antes","label":"Métrica antes","type":"text","required":true},
     {"key":"inicio","label":"Data de início","type":"date","required":true},
     {"key":"leitura_prevista","label":"Data de leitura","type":"date","required":true}]}]',
 '[]',
 '[{"key":"leituras","label":"Leituras","type":"group","item_label":"Teste","fields":[
     {"key":"metrica_depois","label":"Métrica depois","type":"text"},
     {"key":"conclusao","label":"Conclusão","type":"textarea"}]}]',
 90)
on conflict (code) do nothing;

-- Feriados nacionais (edite em Parâmetros).
insert into public.holidays (day, label) values
  ('2026-11-02', 'Finados'),
  ('2026-11-20', 'Dia da Consciência Negra'),
  ('2026-12-25', 'Natal'),
  ('2027-01-01', 'Confraternização Universal'),
  ('2027-02-15', 'Carnaval'),
  ('2027-02-16', 'Carnaval'),
  ('2027-03-26', 'Sexta-feira Santa'),
  ('2027-04-21', 'Tiradentes'),
  ('2027-05-01', 'Dia do Trabalho')
on conflict (day) do nothing;


-- >>> 20261113000500_cron.sql
-- =====================================================================
-- Rotina · agendamento (pg_cron, horários em UTC)
-- 03:05 UTC = 00:05 em São Paulo: gera as tarefas da semana corrente.
-- A cada 15 min: marca vencidas como "não feita".
-- Se pg_cron não estiver disponível, o app cobre via refresh_tasks() ao abrir.
-- =====================================================================
do $do$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('rotina-gerar-tarefas', '5 3 * * *',
    $c$select public.generate_tasks(public.local_today(), public.week_end(public.local_today())); select public.mark_overdue();$c$);
  perform cron.schedule('rotina-vencidas', '*/15 * * * *', $c$select public.mark_overdue();$c$);
exception when others then
  raise notice 'pg_cron indisponível (%). Ative em Database > Extensions e rode este arquivo de novo.', sqlerrm;
end
$do$;


-- >>> 20261113000600_resync_calendar.sql
-- =====================================================================
-- Rotina · mudanças de calendário refletem nas tarefas futuras
-- Novo feriado, dias de expediente ou rotação de curva: tarefas futuras
-- ainda intocadas são recriadas com a regra nova. Iniciadas ficam como estão.
-- =====================================================================
create or replace function public.resync_future()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.audit_action', 'ressincronizacao', true);
  delete from task_instances ti
   where ti.ref_date >= local_today() and ti.status = 'pendente'
     and ti.started_at is null and ti.submitted_at is null and ti.payload = '{}'::jsonb
     and not exists (select 1 from task_submissions s where s.task_id = ti.id);
  perform set_config('app.audit_action', '', true);
  perform generate_tasks(local_today(), week_end(local_today()));
end $$;

create or replace function public.trg_calendar_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'settings' then
    if coalesce(new.key, old.key) not in ('dias_uteis', 'curva_por_dia') then return null; end if;
  end if;
  perform resync_future();
  return null;
end $$;

create trigger z_holidays_resync after insert or update or delete on public.holidays
  for each row execute function public.trg_calendar_changed();
create trigger z_settings_resync after update on public.settings
  for each row execute function public.trg_calendar_changed();

revoke execute on function public.resync_future(), public.trg_calendar_changed() from public, anon, authenticated;


-- >>> 20261113000700_steps_sequence.sql
-- =====================================================================
-- Rotina · etapas progressivas e blocos em sequência
--
-- 1. Cada atividade tem etapas (as "instruções" do modelo). O analista marca
--    uma a uma, em ordem; cada marcação grava data, horário e usuário.
-- 2. Blocos "sequenciais" do mesmo dia só liberam depois que o anterior
--    estiver concluído (mesmo que atrasado). Garantido aqui, não na tela.
-- 3. O envio exige todas as etapas marcadas.
-- 4. Progresso (%) = (etapas marcadas + 1 se concluída) ÷ (etapas + 1):
--    só chega a 100% quando o bloco é enviado e aceito.
-- 5. Conteúdo dos modelos revisado (textos, etapas, campos, ordem e prazos).
--
-- Rodar UMA vez, depois das migrations anteriores.
-- =====================================================================

alter table public.activity_templates
  add column if not exists sequential boolean not null default false;

-- ---------------------------------------------------------------------
-- Etapas marcadas
-- ---------------------------------------------------------------------
create table public.task_steps (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.task_instances (id) on delete cascade,
  step_index  int  not null check (step_index >= 0),
  checked_at  timestamptz not null default now(),
  checked_by  uuid not null references public.profiles (id),
  unique (task_id, step_index)
);
create index task_steps_task on public.task_steps (task_id);

alter table public.task_steps enable row level security;

create policy task_steps_select on public.task_steps for select to authenticated
  using (public.is_admin() or exists (
    select 1 from public.task_instances t where t.id = task_id and t.user_id = auth.uid()));

revoke all on public.task_steps from anon;
revoke insert, update, delete on public.task_steps from authenticated;

create trigger a_audit after insert or delete on public.task_steps
  for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------
-- Bloqueio por sequência: devolve o nome do bloco que ainda precisa ser
-- concluído antes deste, ou null se está liberado.
-- ---------------------------------------------------------------------
create or replace function public.task_lock_reason(p_task uuid)
returns text language sql stable security definer set search_path = public as $$
  select b.template_snapshot ->> 'name'
    from task_instances t
    join task_instances b on b.user_id = t.user_id and b.ref_date = t.ref_date and b.id <> t.id
   where t.id = p_task
     and coalesce((t.template_snapshot ->> 'sequential')::boolean, false)
     and coalesce((b.template_snapshot ->> 'sequential')::boolean, false)
     and t.template_snapshot ->> 'frequency' = 'diaria'
     and b.template_snapshot ->> 'frequency' = 'diaria'
     and coalesce((b.template_snapshot ->> 'sort_order')::int, 0) < coalesce((t.template_snapshot ->> 'sort_order')::int, 0)
     and b.status not in ('concluida_prazo', 'concluida_atraso', 'pausada')
   order by coalesce((b.template_snapshot ->> 'sort_order')::int, 0)
   limit 1;
$$;

-- ---------------------------------------------------------------------
-- Marcar ou desmarcar etapa. Regras:
--  · bloco liberado e não concluído;
--  · marcar só a próxima, na ordem; desmarcar só a última marcada.
-- ---------------------------------------------------------------------
create or replace function public.set_step(p_task uuid, p_index int, p_checked boolean)
returns public.task_instances language plpgsql security definer set search_path = public as $$
declare t task_instances; v_total int; v_done int; v_lock text;
begin
  t := load_own_task(p_task);
  v_lock := task_lock_reason(t.id);
  if v_lock is not null then
    raise exception 'Conclua “%” antes de iniciar este bloco.', v_lock using errcode = '22023';
  end if;
  if t.status in ('concluida_prazo', 'concluida_atraso') then
    raise exception 'Atividade já concluída: as etapas não podem mais ser alteradas.' using errcode = '22023';
  end if;

  v_total := jsonb_array_length(coalesce(t.template_snapshot -> 'instructions', '[]'::jsonb));
  if p_index < 0 or p_index >= v_total then
    raise exception 'Etapa inexistente.' using errcode = '22023';
  end if;
  select count(*) into v_done from task_steps where task_id = t.id;

  if p_checked then
    if p_index <> v_done then
      raise exception 'Siga a ordem: marque primeiro a etapa %.', v_done + 1 using errcode = '22023';
    end if;
    perform set_config('app.audit_action', 'etapa_marcada', true);
    insert into task_steps (task_id, step_index, checked_by) values (t.id, p_index, auth.uid());
  else
    if p_index <> v_done - 1 then
      raise exception 'Só é possível desmarcar a última etapa marcada.' using errcode = '22023';
    end if;
    perform set_config('app.audit_action', 'etapa_desmarcada', true);
    delete from task_steps where task_id = t.id and step_index = p_index;
  end if;

  perform set_config('app.audit_action', 'etapa', true);
  update task_instances
     set status = case when status in ('pendente', 'nao_feita') then 'em_andamento'::task_status else status end,
         started_at = coalesce(started_at, now())
   where id = t.id
  returning * into t;
  perform set_config('app.audit_action', '', true);
  return t;
end $$;

-- ---------------------------------------------------------------------
-- save_draft e submit_task: respeitam sequência e etapas
-- ---------------------------------------------------------------------
create or replace function public.save_draft(p_task uuid, p_payload jsonb, p_gates jsonb default '{}', p_deviation jsonb default null)
returns public.task_instances language plpgsql security definer set search_path = public as $$
declare t task_instances; v_lock text;
begin
  t := load_own_task(p_task);
  v_lock := task_lock_reason(t.id);
  if v_lock is not null then
    raise exception 'Conclua “%” antes de iniciar este bloco.', v_lock using errcode = '22023';
  end if;
  if t.status in ('concluida_prazo', 'concluida_atraso') and not t.needs_rework then
    raise exception 'Atividade já concluída.' using errcode = '22023';
  end if;
  perform set_config('app.audit_action', 'rascunho', true);
  update task_instances
     set payload    = coalesce(p_payload, '{}'::jsonb),
         gate_draft = coalesce(p_gates, '{}'::jsonb),
         deviation  = p_deviation,
         status     = case when status = 'pendente' then 'em_andamento'::task_status else status end,
         started_at = coalesce(started_at, now())
   where id = p_task
  returning * into t;
  perform set_config('app.audit_action', '', true);
  return t;
end $$;

create or replace function public.submit_task(p_task uuid, p_payload jsonb, p_gates jsonb default '{}', p_deviation jsonb default null)
returns public.task_instances language plpgsql security definer set search_path = public as $$
declare
  t task_instances; g jsonb; ans text; passed boolean := true;
  missing text[]; sub_id uuid; new_status task_status; v_now timestamptz := now();
  v_lock text; v_total int; v_done int;
begin
  t := load_own_task(p_task);

  v_lock := task_lock_reason(t.id);
  if v_lock is not null then
    raise exception 'Conclua “%” antes de enviar este bloco.', v_lock using errcode = '22023';
  end if;
  if t.status in ('concluida_prazo', 'concluida_atraso') and not t.needs_rework then
    raise exception 'Atividade já concluída. Só pode ser reenviada se for contestada na revisão.' using errcode = '22023';
  end if;

  -- Etapas: todas marcadas (reenvio após contestação já passou por elas).
  if not t.needs_rework then
    v_total := jsonb_array_length(coalesce(t.template_snapshot -> 'instructions', '[]'::jsonb));
    select count(*) into v_done from task_steps where task_id = t.id;
    if v_done < v_total then
      raise exception 'Marque todas as etapas antes de enviar (% de % marcadas).', v_done, v_total using errcode = '22023';
    end if;
  end if;

  p_payload := coalesce(p_payload, '{}'::jsonb);
  p_gates   := coalesce(p_gates, '{}'::jsonb);

  for g in select * from jsonb_array_elements(coalesce(t.template_snapshot -> 'gates', '[]'::jsonb)) loop
    ans := p_gates ->> (g ->> 'key');
    if ans is null or ans not in ('sim', 'nao') then
      raise exception 'Responda todas as perguntas de verificação antes de enviar.' using errcode = '22023';
    end if;
    if ans <> (g ->> 'expected') then passed := false; end if;
  end loop;

  if not passed then
    if p_deviation is null
       or jsonb_typeof(p_deviation -> 'skus') is distinct from 'array'
       or jsonb_array_length(p_deviation -> 'skus') = 0
       or coalesce(btrim(p_deviation ->> 'action'), '') = '' then
      raise exception 'Verificação não satisfeita: liste os SKUs em desvio e a ação tomada.' using errcode = '22023';
    end if;
    new_status := 'bloqueada_gate';
  else
    missing := missing_fields(t.template_snapshot -> 'fields', p_payload);
    if coalesce(array_length(missing, 1), 0) > 0 then
      raise exception 'Preencha os campos obrigatórios: %', array_to_string(missing, '; ') using errcode = '22023';
    end if;
    new_status := case when t.needs_rework and t.status in ('concluida_prazo', 'concluida_atraso')
                       then t.status else deadline_status(v_now, t.due_at) end;
  end if;

  insert into task_submissions (task_id, user_id, submitted_at, payload, gate_passed, deviation, result_status)
  values (t.id, t.user_id, v_now, p_payload, passed, case when passed then null else p_deviation end, new_status)
  returning id into sub_id;

  insert into gate_answers (submission_id, gate_key, question, answer, expected)
  select sub_id, gd.value ->> 'key', render_text(gd.value ->> 'question'), p_gates ->> (gd.value ->> 'key'), gd.value ->> 'expected'
  from jsonb_array_elements(coalesce(t.template_snapshot -> 'gates', '[]'::jsonb)) gd;

  perform set_config('app.audit_action', case when passed then 'envio' else 'bloqueio_gate' end, true);
  update task_instances
     set payload       = p_payload,
         gate_draft    = p_gates,
         deviation     = case when passed then null else p_deviation end,
         status        = new_status,
         submitted_at  = v_now,
         started_at    = coalesce(started_at, v_now),
         completed_at  = case when passed then coalesce(completed_at, v_now) else completed_at end,
         review_status = case when passed and needs_rework then 'nao_revisada'::review_status else review_status end,
         needs_rework  = case when passed then false else needs_rework end
   where id = t.id
  returning * into t;
  perform set_config('app.audit_action', '', true);
  return t;
end $$;

-- Permissões das funções novas (as antigas já estão corretas)
revoke execute on function public.task_lock_reason(uuid), public.set_step(uuid, int, boolean)
  from public, anon, authenticated;
grant execute on function public.set_step(uuid, int, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- View de fatos: + progresso por etapas e ordem na sequência
-- ---------------------------------------------------------------------
create or replace view public.v_task_facts with (security_invoker = true) as
select
  t.id, t.user_id, p.full_name, t.template_id,
  t.template_snapshot ->> 'code'      as template_code,
  t.template_snapshot ->> 'name'      as template_name,
  t.template_snapshot ->> 'frequency' as frequency,
  t.period_key, t.ref_date, t.due_at, t.curve, t.weight,
  t.status, t.review_status, t.needs_rework, t.submitted_at, t.completed_at,
  (t.status <> 'pausada' and (t.due_at <= now() or t.status in ('concluida_prazo', 'concluida_atraso'))) as expected,
  t.status in ('concluida_prazo', 'concluida_atraso')                         as completed,
  t.status = 'concluida_prazo'                                                 as on_time,
  jsonb_array_length(coalesce(t.template_snapshot -> 'gates', '[]'::jsonb)) > 0 as has_gates,
  (select count(*) from task_submissions s where s.task_id = t.id)::int                      as submission_count,
  (select count(*) from task_submissions s where s.task_id = t.id and not s.gate_passed)::int as gate_block_count,
  exists (select 1 from reviews r where r.task_id = t.id)                              as reviewed,
  exists (select 1 from reviews r where r.task_id = t.id and r.status = 'contestada')  as contested,
  abs(hashtext(t.id::text)) % 100                                                      as sample_bucket,
  jsonb_array_length(coalesce(t.template_snapshot -> 'instructions', '[]'::jsonb))::int as steps_total,
  (select count(*) from task_steps s where s.task_id = t.id)::int                      as steps_done,
  coalesce((t.template_snapshot ->> 'sort_order')::int, 0)                             as sort_order,
  coalesce((t.template_snapshot ->> 'sequential')::boolean, false)                     as sequential
from task_instances t
join profiles p on p.id = t.user_id;

grant select on public.v_task_facts to authenticated;

-- ---------------------------------------------------------------------
-- Rotação de curvas: seg A, ter B, qua C, qui e sex D
-- ---------------------------------------------------------------------
update public.settings
   set value = '{"1":"A","2":"B","3":"C","4":"D","5":"D"}'
 where key = 'curva_por_dia';

-- ---------------------------------------------------------------------
-- Modelos: textos revisados, etapas, campos, ordem e prazos
-- Sequência do dia: D1 → D2 → D3 → D5 (D4 segue pausada, fora da sequência).
-- ---------------------------------------------------------------------
update public.activity_templates set
  name = 'Descontos Black Friday',
  description = 'Conferir o que muda hoje na campanha e marcar os produtos que vamos bater de frente com a {concorrente}.',
  instructions = $j$[
    "Entrar no hub e clicar no botão “O que vai mudar hoje”.",
    "Conferir se todos os produtos estão corretos, seguindo as regras de precificação.",
    "Verificar, no portfólio da Black Friday, o que vamos bater de frente com a {concorrente} e marcar esses produtos."
  ]$j$::jsonb,
  cutoff_time = '10:00', sequential = true, sort_order = 10,
  fields = $j$[
    {"key":"colidem","label":"Produtos que batem de frente com a {concorrente}","type":"number","required":true},
    {"key":"nao_colidem","label":"Produtos que não batem de frente","type":"number","required":true},
    {"key":"skus_colidem","label":"Produtos marcados (SKUs)","type":"list","mono":true,"help":"Um SKU por linha. Deixe em branco se nenhum produto bater de frente."},
    {"key":"observacoes","label":"Observações","type":"textarea"}
  ]$j$::jsonb
where code = 'D1';

update public.activity_templates set
  name = 'Precificação diária',
  description = 'Precificar a curva do dia, conforme o dia da semana: segunda, curva A; terça, curva B; quarta, curva C; quinta e sexta, curva D.',
  instructions = $j$[
    "Abrir a curva do dia indicada no card.",
    "Precificar os produtos da curva, considerando tudo o que foi alinhado nas reuniões.",
    "Verificar o mapeamento da {concorrente} em cada produto precificado.",
    "Se o produto precificado não tiver o link para coleta de preço, coletar o link e cadastrá-lo, para acompanharmos melhor os preços da concorrente.",
    "Responder às verificações de venda e de folga e, se alguma estiver fora do esperado, listar os SKUs em desvio e a ação tomada."
  ]$j$::jsonb,
  cutoff_time = '12:00', sequential = true, sort_order = 20,
  fields = $j$[
    {"key":"curva","label":"Curva trabalhada","type":"select","options_setting":"curvas","default_from":"curva_do_dia","required":true},
    {"key":"qtd_precificados","label":"Produtos precificados","type":"number","required":true},
    {"key":"skus_link","label":"SKUs que precisaram de link da {concorrente}","type":"list","mono":true,"help":"Um SKU por linha. A quantidade é contada automaticamente."},
    {"key":"diretrizes","label":"Diretrizes de reunião aplicadas","type":"textarea","required":true}
  ]$j$::jsonb
where code = 'D2';

update public.activity_templates set
  name = 'Check em produtos com giro',
  description = 'Revisar 2 produtos com giro, por ordem de views, para entender como cada um converte. A análise vai direto para o gestor e para o admin master.',
  instructions = $j$[
    "Escolher 2 produtos que têm giro, por ordem de views.",
    "Ver como anda a taxa de conversão de cada um.",
    "Verificar se o kit de fotos precisa ser renovado e se a descrição precisa de alguma alteração.",
    "Verificar se as compatibilidades fazem sentido e estão corretas para cada produto.",
    "Verificar quais compatibilidades mais convertem e entender os dois produtos como um todo."
  ]$j$::jsonb,
  cutoff_time = '16:00', sequential = true, sort_order = 30, target_qty = 2, target_label = 'produtos',
  fields = $j$[
    {"key":"produtos","label":"Referências checadas no dia","type":"group","item_label":"Produto","min_items":2,
     "help":"Informe as 2 referências que você checou hoje. A análise de cada uma vai direto para o gestor e para o admin master.",
     "fields":[
       {"key":"sku","label":"Referência analisada (SKU)","type":"text","mono":true,"required":true},
       {"key":"conversao","label":"Taxa de conversão atual","type":"text","required":true},
       {"key":"renovar_fotos","label":"O kit de fotos precisa ser renovado?","type":"boolean","required":true},
       {"key":"alterar_descricao","label":"A descrição precisa de alguma alteração?","type":"boolean","required":true},
       {"key":"compat_ok","label":"As compatibilidades fazem sentido e estão corretas?","type":"boolean","required":true},
       {"key":"pontos_melhoria","label":"Pontos que precisam de melhoria","type":"textarea","required":true},
       {"key":"analise","label":"Análise do produto","type":"textarea","required":true,
        "help":"O que você encontrou, quais compatibilidades mais convertem e o que entendeu sobre o produto."}
     ]}
  ]$j$::jsonb
where code = 'D3';

update public.activity_templates set
  name = '5 produtos entupidos',
  description = 'Estoque parado: diagnosticar por que o produto não vende e traçar uma estratégia.',
  instructions = $j$[
    "Selecionar 5 produtos com estoque parado.",
    "Para cada um, registrar o diagnóstico e a estratégia."
  ]$j$::jsonb,
  sequential = false, sort_order = 35
where code = 'D4';

update public.activity_templates set
  name = 'Acompanhamento da concorrência',
  description = 'Verificar, na aba do hub, como a concorrência tem se comportado e identificar oportunidades de mercado.',
  instructions = $j$[
    "Abrir a aba de concorrência no hub.",
    "Verificar como a concorrência tem se comportado: se, dentro da sua categoria, o preço abaixou ou aumentou.",
    "Identificar oportunidades de mercado, visando à ação."
  ]$j$::jsonb,
  cutoff_time = '17:00', sequential = true, sort_order = 40,
  fields = $j$[
    {"key":"categoria","label":"Categoria analisada","type":"text","required":true},
    {"key":"movimento","label":"Movimento observado","type":"select","required":true,"options":["Abaixou","Manteve","Aumentou"]},
    {"key":"oportunidade","label":"Oportunidade identificada","type":"textarea","required":true},
    {"key":"acao","label":"Ação proposta","type":"textarea","required":true},
    {"key":"alteracoes","label":"Alterações feitas em referências (opcional)","type":"group","item_label":"Alteração","min_items":0,
     "help":"Se você alterou alguma referência, sinalize o que foi feito e por que foi mudado. Este campo é opcional.",
     "fields":[
       {"key":"sku","label":"Referência alterada (SKU)","type":"text","mono":true,"required":true},
       {"key":"feito","label":"O que foi feito","type":"textarea","required":true},
       {"key":"motivo","label":"Por que foi alterado","type":"textarea","required":true}
     ]}
  ]$j$::jsonb
where code = 'D5';

update public.activity_templates set
  description = 'Saber qual é o volume de pedido necessário e em que etapa está o pedido.',
  instructions = $j$[
    "Abrir o hub, na aba de importações: https://ceo61.github.io/bb-hub/?#importacoes",
    "Conferir o volume de pedido necessário.",
    "Confirmar se o pedido já foi feito, se está em cotação ou se ainda não foi iniciado."
  ]$j$::jsonb
where code = 'S1';

update public.activity_templates set
  description = 'Estar totalmente por dentro da importação, inclusive da data de chegada da carga.',
  instructions = $j$[
    "Acompanhar a importação de ponta a ponta e levantar o status atual.",
    "Confirmar a data prevista de chegada da carga."
  ]$j$::jsonb
where code = 'M1';

update public.activity_templates set
  description = 'Comparar o nosso ticket com o do mercado na categoria.',
  instructions = $j$[
    "Escolher a categoria.",
    "Levantar os preços praticados pelo mercado.",
    "Concluir se o nosso ticket está acima, abaixo ou igual ao do mercado."
  ]$j$::jsonb
where code = 'M2';

update public.activity_templates set
  description = 'Executar dois testes de estratégia no mês. Depois de concluir, registre a leitura do resultado em “Registrar leitura”.',
  instructions = $j$[
    "Definir a hipótese de cada teste.",
    "Aplicar a alteração (por exemplo, trocar o kit de fotos de 2 produtos de teclado).",
    "Registrar a métrica de antes e a data prevista de leitura."
  ]$j$::jsonb
where code = 'M3';

-- Tarefas de hoje em diante ainda intocadas passam a usar o modelo novo
-- (as já iniciadas ou concluídas mantêm a versão com que foram feitas).
select set_config('app.audit_action', 'ressincronizacao', true);
update public.task_instances ti
   set template_snapshot = to_jsonb(t) - 'created_at' - 'updated_at',
       due_at = public.local_due(ti.ref_date, t.cutoff_time),
       weight = t.weight,
       curve  = case when t.shows_curve then public.curve_for(ti.ref_date) end
  from public.activity_templates t
 where ti.template_id = t.id
   and ti.ref_date >= public.local_today()
   and ti.status in ('pendente', 'nao_feita')
   and ti.started_at is null and ti.submitted_at is null and ti.payload = '{}'::jsonb
   and not exists (select 1 from public.task_submissions s where s.task_id = ti.id);
select set_config('app.audit_action', '', true);


-- >>> 20261113000800_milestones_review.sql
-- =====================================================================
-- Rotina · marcos semanal e mensal, prazo só por data, aprovação de testes
--
-- 1. Sem horários: o prazo vale até o fim do dia de vencimento.
-- 2. A sequência passa a valer para qualquer frequência (diário, semanal,
--    mensal): marcos do mesmo período só liberam em ordem.
-- 3. Mensal: abre no dia 1 e fecha no último dia do mês.
-- 4. Aprovação por item: cada referência de um grupo "revisável" (ex.: testes
--    do mensal) é aprovada ou reprovada de forma independente pelo admin master;
--    o analista vê o retorno e pode reenviar a referência reprovada.
-- 5. Modelos semanal e mensal reescritos; sobras de carga de exemplo removidas.
--
-- Rodar UMA vez, depois da 20261113000700.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Prazo por data: o dia de vencimento vai até 23:59:59 (horário local)
-- ---------------------------------------------------------------------
alter table public.activity_templates alter column cutoff_time set default '23:59:59';
update public.activity_templates set cutoff_time = '23:59:59';

select set_config('app.audit_action', 'ressincronizacao', true);
update public.task_instances ti
   set due_at = public.local_due(ti.ref_date, '23:59:59')
 where ti.status in ('pendente', 'em_andamento', 'nao_feita', 'bloqueada_gate');
-- Tarefa marcada como "não feita" só por causa do horário antigo volta a ficar aberta.
update public.task_instances ti set status = 'pendente'
 where ti.status = 'nao_feita' and ti.due_at > now()
   and ti.started_at is null and ti.submitted_at is null
   and not exists (select 1 from public.task_steps s where s.task_id = ti.id);
select set_config('app.audit_action', '', true);

-- ---------------------------------------------------------------------
-- 2. Sequência para qualquer frequência (mesmo período, mesma frequência)
-- ---------------------------------------------------------------------
create or replace function public.task_lock_reason(p_task uuid)
returns text language sql stable security definer set search_path = public as $$
  select b.template_snapshot ->> 'name'
    from task_instances t
    join task_instances b on b.user_id = t.user_id and b.period_key = t.period_key and b.id <> t.id
   where t.id = p_task
     and coalesce((t.template_snapshot ->> 'sequential')::boolean, false)
     and coalesce((b.template_snapshot ->> 'sequential')::boolean, false)
     and t.template_snapshot ->> 'frequency' = b.template_snapshot ->> 'frequency'
     and coalesce((b.template_snapshot ->> 'sort_order')::int, 0) < coalesce((t.template_snapshot ->> 'sort_order')::int, 0)
     and b.status not in ('concluida_prazo', 'concluida_atraso', 'pausada')
   order by coalesce((b.template_snapshot ->> 'sort_order')::int, 0)
   limit 1;
$$;
revoke execute on function public.task_lock_reason(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Mensal: vence no último dia do mês (calendário)
-- ---------------------------------------------------------------------
create or replace function public.monthly_due(m date)
returns date language sql stable as $$
  select (date_trunc('month', m) + interval '1 month - 1 day')::date;
$$;

-- ---------------------------------------------------------------------
-- 4. Aprovação por item
-- ---------------------------------------------------------------------
create table public.task_item_reviews (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.task_instances (id) on delete cascade,
  group_key    text not null,
  item_index   int  not null check (item_index >= 0),
  status       text not null check (status in ('aprovada', 'reprovada', 'reenviada')),
  reason       text,
  reviewer_id  uuid not null references public.profiles (id),   -- quem decidiu (ou reenviou)
  created_at   timestamptz not null default clock_timestamp(),
  check (status <> 'reprovada' or coalesce(length(btrim(reason)), 0) > 0)
);
create index task_item_reviews_task on public.task_item_reviews (task_id, group_key, item_index, created_at desc);

alter table public.task_item_reviews enable row level security;
create policy item_reviews_select on public.task_item_reviews for select to authenticated
  using (public.is_admin() or exists (
    select 1 from public.task_instances t where t.id = task_id and t.user_id = auth.uid()));
revoke all on public.task_item_reviews from anon;
revoke insert, update, delete on public.task_item_reviews from authenticated;

create trigger a_audit after insert on public.task_item_reviews
  for each row execute function public.audit_trigger();

-- Situação atual de um item: 'pendente' (sem decisão ou reenviado), 'aprovada' ou 'reprovada'.
create or replace function public.item_review_state(p_task uuid, p_group text, p_index int)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((
    select case r.status when 'reenviada' then 'pendente' else r.status end
      from task_item_reviews r
     where r.task_id = p_task and r.group_key = p_group and r.item_index = p_index
     order by r.created_at desc, r.id desc limit 1), 'pendente');
$$;
revoke execute on function public.item_review_state(uuid, text, int) from public, anon, authenticated;

-- Admin: aprova ou reprova UMA referência (reprovação exige o motivo).
create or replace function public.review_item(p_task uuid, p_group text, p_index int, p_status text, p_reason text default null)
returns public.task_item_reviews language plpgsql security definer set search_path = public as $$
declare t task_instances; fdef jsonb; n int; r task_item_reviews;
begin
  if not is_admin() then raise exception 'Apenas admin pode avaliar.' using errcode = '42501'; end if;
  if p_status not in ('aprovada', 'reprovada') then
    raise exception 'Escolha aprovar ou reprovar.' using errcode = '22023';
  end if;
  if p_status = 'reprovada' and coalesce(btrim(p_reason), '') = '' then
    raise exception 'Informe o motivo da reprovação, para o analista saber o que ajustar.' using errcode = '22023';
  end if;

  select * into t from task_instances where id = p_task for update;
  if not found then raise exception 'Atividade não encontrada.' using errcode = 'P0002'; end if;
  if t.status not in ('concluida_prazo', 'concluida_atraso') then
    raise exception 'O analista ainda não enviou esta atividade.' using errcode = '22023';
  end if;

  select f into fdef from jsonb_array_elements(coalesce(t.template_snapshot -> 'fields', '[]'::jsonb)) f
   where f ->> 'key' = p_group and coalesce((f ->> 'reviewable')::boolean, false) limit 1;
  if fdef is null then raise exception 'Este campo não passa por aprovação.' using errcode = '22023'; end if;

  n := coalesce(jsonb_array_length(t.payload -> p_group), 0);
  if p_index < 0 or p_index >= n then raise exception 'Referência inexistente.' using errcode = '22023'; end if;
  if item_review_state(p_task, p_group, p_index) <> 'pendente' then
    raise exception 'Esta referência já foi avaliada.' using errcode = '22023';
  end if;

  perform set_config('app.audit_action', case p_status when 'aprovada' then 'item_aprovado' else 'item_reprovado' end, true);
  insert into task_item_reviews (task_id, group_key, item_index, status, reason, reviewer_id)
  values (p_task, p_group, p_index, p_status, nullif(btrim(p_reason), ''), auth.uid())
  returning * into r;
  perform set_config('app.audit_action', '', true);
  return r;
end $$;

-- Analista: corrige e reenvia uma referência que foi reprovada.
create or replace function public.resubmit_item(p_task uuid, p_group text, p_index int, p_item jsonb)
returns public.task_instances language plpgsql security definer set search_path = public as $$
declare t task_instances; fdef jsonb; missing text[];
begin
  t := load_own_task(p_task);
  select f into fdef from jsonb_array_elements(coalesce(t.template_snapshot -> 'fields', '[]'::jsonb)) f
   where f ->> 'key' = p_group and coalesce((f ->> 'reviewable')::boolean, false) limit 1;
  if fdef is null then raise exception 'Este campo não passa por aprovação.' using errcode = '22023'; end if;
  if p_index < 0 or p_index >= coalesce(jsonb_array_length(t.payload -> p_group), 0) then
    raise exception 'Referência inexistente.' using errcode = '22023';
  end if;
  if item_review_state(p_task, p_group, p_index) <> 'reprovada' then
    raise exception 'Só dá para reenviar uma referência reprovada.' using errcode = '22023';
  end if;
  missing := missing_fields(fdef -> 'fields', p_item, coalesce(fdef ->> 'item_label', fdef ->> 'label') || ' · ');
  if coalesce(array_length(missing, 1), 0) > 0 then
    raise exception 'Preencha os campos obrigatórios: %', array_to_string(missing, '; ') using errcode = '22023';
  end if;

  perform set_config('app.audit_action', 'item_reenviado', true);
  insert into task_item_reviews (task_id, group_key, item_index, status, reviewer_id)
  values (p_task, p_group, p_index, 'reenviada', auth.uid());
  update task_instances
     set payload = jsonb_set(payload, array[p_group, p_index::text], p_item, false),
         submitted_at = now()
   where id = p_task
  returning * into t;
  perform set_config('app.audit_action', '', true);
  return t;
end $$;

revoke execute on function public.review_item(uuid, text, int, text, text), public.resubmit_item(uuid, text, int, jsonb)
  from public, anon, authenticated;
grant execute on function public.review_item(uuid, text, int, text, text), public.resubmit_item(uuid, text, int, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------
-- 5. Modelos semanal e mensal
-- ---------------------------------------------------------------------
update public.activity_templates set
  name = 'Acompanhamento do pedido de compras',
  description = 'Ficar a par do pedido de compras (andamento, se já foi cotado e se já foi feito) e cuidar, no hub, do volume de pedido necessário.',
  instructions = $j$[
    "Abrir o hub, na aba de importações: https://ceo61.github.io/bb-hub/?#importacoes",
    "Conferir, no hub, o volume de pedido necessário.",
    "Acompanhar o pedido de compras: qual é o andamento, se já foi cotado e se já foi feito."
  ]$j$::jsonb,
  sequential = true, sort_order = 60,
  fields = $j$[
    {"key":"status_pedido","label":"Andamento do pedido","type":"select","options_setting":"status_pedido_opcoes","required":true},
    {"key":"volume","label":"Volume de pedido necessário","type":"number","required":true},
    {"key":"observacoes","label":"Observações","type":"textarea"}
  ]$j$::jsonb
where code = 'S1';

update public.activity_templates set
  name = 'Acompanhamento da importação',
  description = 'Ficar totalmente por dentro da importação: qual é o estágio atual e quando está prevista a chegada da carga.',
  instructions = $j$[
    "Acompanhar a importação de ponta a ponta, ficando totalmente por dentro dela.",
    "Levantar o estágio atual da importação.",
    "Confirmar a previsão de chegada da carga."
  ]$j$::jsonb,
  sequential = true, sort_order = 70,
  fields = $j$[
    {"key":"estagio","label":"Estágio da importação","type":"text","required":true},
    {"key":"chegada","label":"Previsão de chegada","type":"date","required":true},
    {"key":"observacoes","label":"Observações","type":"textarea"}
  ]$j$::jsonb
where code = 'M1';

update public.activity_templates set
  name = 'Pesquisa de mercado da categoria',
  description = 'Entender como anda a categoria e se estamos operando com um ticket maior, menor ou igual ao do mercado.',
  instructions = $j$[
    "Escolher a categoria.",
    "Fazer a pesquisa de mercado, levantando os preços praticados.",
    "Concluir se estamos operando com um ticket maior, menor ou igual ao do mercado."
  ]$j$::jsonb,
  sequential = true, sort_order = 80,
  fields = $j$[
    {"key":"categoria","label":"Categoria","type":"text","required":true},
    {"key":"ticket","label":"Nosso ticket em relação ao mercado","type":"select","required":true,"options":["Maior","Menor","Igual"]},
    {"key":"evidencias","label":"Evidências e links","type":"list","required":true,"help":"Um link ou evidência por linha."},
    {"key":"observacoes","label":"Observações","type":"textarea"}
  ]$j$::jsonb
where code = 'M2';

update public.activity_templates set
  name = 'Testes de estratégia por categoria',
  description = 'Executar 2 testes de acordo com a estratégia definida para a categoria (por exemplo, mudar o kit de fotos de 2 produtos de teclado para ver se melhora a taxa de conversão). A sugestão de cada teste passa pela aprovação do admin master.',
  instructions = $j$[
    "Consultar a estratégia definida para a categoria.",
    "Escolher as 2 referências que serão testadas.",
    "Escrever a sugestão de teste de cada referência e enviar para a aprovação do admin master."
  ]$j$::jsonb,
  sequential = true, sort_order = 90, target_qty = 2, target_label = 'testes',
  followup_fields = '[]'::jsonb,
  fields = $j$[
    {"key":"testes","label":"Testes por referência","type":"group","item_label":"Referência","min_items":2,"reviewable":true,
     "help":"Informe as 2 referências e a sugestão de teste de cada uma. O admin master aprova ou reprova cada referência de forma independente.",
     "fields":[
       {"key":"sku","label":"Referência testada (SKU)","type":"text","mono":true,"required":true},
       {"key":"sugestao","label":"Sugestão de teste","type":"textarea","required":true,
        "help":"Por exemplo: trocar o kit de fotos para ver se melhora a taxa de conversão."}
     ]}
  ]$j$::jsonb
where code = 'M3';

-- Lista de estágios de importação era uma sugestão minha, não um pedido: removida.
delete from public.settings where key = 'status_importacao_opcoes';
-- Feriados também eram só um exemplo: o admin cadastra os da empresa em Parâmetros.
delete from public.holidays where (day, label) in (
  ('2026-11-02', 'Finados'), ('2026-11-20', 'Dia da Consciência Negra'), ('2026-12-25', 'Natal'),
  ('2027-01-01', 'Confraternização Universal'), ('2027-02-15', 'Carnaval'), ('2027-02-16', 'Carnaval'),
  ('2027-03-26', 'Sexta-feira Santa'), ('2027-04-21', 'Tiradentes'), ('2027-05-01', 'Dia do Trabalho'));

-- Tarefas ainda intocadas passam a usar os modelos novos.
select set_config('app.audit_action', 'ressincronizacao', true);
update public.task_instances ti
   set template_snapshot = to_jsonb(t) - 'created_at' - 'updated_at',
       due_at = public.local_due(ti.ref_date, '23:59:59'),
       weight = t.weight
  from public.activity_templates t
 where ti.template_id = t.id
   and ti.ref_date >= public.local_today()
   and ti.status in ('pendente', 'nao_feita')
   and ti.started_at is null and ti.submitted_at is null and ti.payload = '{}'::jsonb
   and not exists (select 1 from public.task_submissions s where s.task_id = ti.id);
select set_config('app.audit_action', '', true);


-- >>> 20261113000900_only_requested_blocks.sql
-- =====================================================================
-- Rotina · só os blocos pedidos
-- Remove o modelo "5 produtos entupidos" (D4), que estava pausado e fora da
-- sequência. Ficam: diário (D1, D2, D3, D5), semanal (S1) e mensal (M1, M2, M3).
-- Só apaga se o modelo nunca gerou tarefa (preserva histórico, se houver).
-- =====================================================================
delete from public.template_assignments
 where template_id in (select id from public.activity_templates where code = 'D4');

delete from public.activity_templates t
 where t.code = 'D4'
   and not exists (select 1 from public.task_instances ti where ti.template_id = t.id);


-- >>> 20261113001000_user_admin_in_db.sql
-- =====================================================================
-- Rotina · usuários e papéis geridos direto no banco (sem Edge Function)
--
-- O papel de cada pessoa é a coluna public.profiles.role (tipo user_role:
-- 'analista' ou 'admin'). Pode ser alterado:
--   · no painel do admin master (Usuários e acessos), ou
--   · direto no banco (Table Editor > profiles > role / active).
-- Nos dois casos, o login (auth.users) acompanha automaticamente:
--   · role   → app_metadata.role
--   · active → bloqueia ou libera o login (banned_until), sem apagar histórico.
-- O admin master também cria logins e define senhas pelo painel.
-- Proteção: o último admin master ativo não pode ser rebaixado nem desativado.
-- =====================================================================

comment on type public.user_role is 'Papel do usuário: analista ou admin (admin master).';
comment on column public.profiles.role is 'Papel: analista ou admin. Pode ser editado aqui ou no painel; o login acompanha.';
comment on column public.profiles.active is 'false bloqueia o login sem apagar o histórico.';

-- ---------------------------------------------------------------------
-- Nunca ficar sem admin master
-- ---------------------------------------------------------------------
create or replace function public.guard_last_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and old.active and (new.role <> 'admin' or not new.active) then
    if not exists (select 1 from profiles where id <> old.id and role = 'admin' and active) then
      raise exception 'Este é o último admin master ativo. Promova outra pessoa a admin antes de rebaixar ou desativar esta.'
        using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

create trigger a_guard_last_admin before update of role, active on public.profiles
  for each row execute function public.guard_last_admin();

-- ---------------------------------------------------------------------
-- Papel e situação do perfil → login
-- ---------------------------------------------------------------------
create or replace function public.sync_profile_to_auth()
returns trigger language plpgsql security definer set search_path = public, auth as $$
begin
  if new.role is distinct from old.role or new.active is distinct from old.active then
    update auth.users
       set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', new.role::text),
           banned_until = case when new.active then null else now() + interval '100 years' end,
           updated_at = now()
     where id = new.id;
  end if;
  return null;
end $$;

create trigger z_sync_profile_to_auth after update of role, active on public.profiles
  for each row execute function public.sync_profile_to_auth();

-- ---------------------------------------------------------------------
-- Admin cria login (e-mail confirmado, senha inicial definida por ele)
-- ---------------------------------------------------------------------
create or replace function public.admin_create_user(p_email text, p_full_name text, p_role public.user_role, p_password text)
returns public.profiles language plpgsql security definer set search_path = public, extensions, auth as $$
declare v_id uuid := gen_random_uuid(); v_email text := lower(btrim(p_email)); p profiles;
begin
  if not is_admin() then raise exception 'Apenas admin master cria usuários.' using errcode = '42501'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.' using errcode = '22023'; end if;
  if coalesce(btrim(p_full_name), '') = '' then raise exception 'Informe o nome.' using errcode = '22023'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'A senha precisa de pelo menos 8 caracteres.' using errcode = '22023'; end if;
  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'Já existe um login com este e-mail.' using errcode = '22023';
  end if;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
          crypt(p_password, gen_salt('bf')), now(),
          jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'role', p_role::text),
          jsonb_build_object('full_name', btrim(p_full_name)), now(), now(), '', '', '', '');

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text,
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true), 'email', null, now(), now());

  -- O perfil nasce pelo gatilho on_auth_user_created; garante papel e nome.
  update profiles set role = p_role, full_name = btrim(p_full_name) where id = v_id returning * into p;
  perform generate_tasks(local_today(), week_end(local_today()));
  return p;
end $$;

-- ---------------------------------------------------------------------
-- Admin define uma nova senha para alguém (sem expor a senha na auditoria)
-- ---------------------------------------------------------------------
create or replace function public.admin_set_password(p_user uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions, auth as $$
begin
  if not is_admin() then raise exception 'Apenas admin master redefine senhas.' using errcode = '42501'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'A senha precisa de pelo menos 8 caracteres.' using errcode = '22023'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where id = p_user;
  if not found then raise exception 'Usuário não encontrado.' using errcode = 'P0002'; end if;
  insert into audit_log (actor_id, action, entity, entity_id) values (auth.uid(), 'senha_redefinida', 'profiles', p_user::text);
end $$;

revoke execute on function public.guard_last_admin(), public.sync_profile_to_auth(),
  public.admin_create_user(text, text, public.user_role, text), public.admin_set_password(uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_create_user(text, text, public.user_role, text), public.admin_set_password(uuid, text)
  to authenticated;


-- >>> 20261113001100_simplify_daily_blocks.sql
-- =====================================================================
-- Rotina · blocos diários mais enxutos
-- · Descontos Black Friday: sem os campos de produtos que batem de frente
--   com a BGT e de produtos marcados (fica só "Observações", opcional).
-- · Precificação diária: sem campos a preencher e sem verificações; o
--   bloco se conclui pelas etapas.
-- · Campos de referência e quantidade aceitam letras e números (texto).
-- Tarefas de hoje em diante ainda não concluídas passam a usar o modelo novo.
-- =====================================================================

update public.activity_templates set
  fields = $j$[
    {"key":"observacoes","label":"Observações","type":"textarea"}
  ]$j$::jsonb
where code = 'D1';

update public.activity_templates set
  instructions = $j$[
    "Abrir a curva do dia indicada no card.",
    "Precificar os produtos da curva, considerando tudo o que foi alinhado nas reuniões.",
    "Verificar o mapeamento da {concorrente} em cada produto precificado.",
    "Se o produto precificado não tiver o link para coleta de preço, coletar o link e cadastrá-lo, para acompanharmos melhor os preços da concorrente."
  ]$j$::jsonb,
  fields = '[]'::jsonb,
  gates  = '[]'::jsonb
where code = 'D2';

-- Volume do pedido como texto (aceita "500 un", "2 caixas" etc.)
update public.activity_templates set
  fields = $j$[
    {"key":"status_pedido","label":"Andamento do pedido","type":"select","options_setting":"status_pedido_opcoes","required":true},
    {"key":"volume","label":"Volume de pedido necessário","type":"text","required":true},
    {"key":"observacoes","label":"Observações","type":"textarea"}
  ]$j$::jsonb
where code = 'S1';

-- Reaplica o modelo nas tarefas abertas de hoje em diante (as concluídas mantêm a versão usada).
select set_config('app.audit_action', 'ressincronizacao', true);
update public.task_instances ti
   set template_snapshot = to_jsonb(t) - 'created_at' - 'updated_at',
       gate_draft = case when t.code = 'D2' then '{}'::jsonb else ti.gate_draft end,
       deviation  = case when t.code = 'D2' then null else ti.deviation end
  from public.activity_templates t
 where ti.template_id = t.id
   and t.code in ('D1', 'D2', 'S1')
   and ti.ref_date >= public.local_today()
   and ti.status not in ('concluida_prazo', 'concluida_atraso');

-- Etapas marcadas além do novo total (D2 passou de 5 para 4 etapas) saem.
delete from public.task_steps s
 using public.task_instances ti
 where s.task_id = ti.id
   and ti.ref_date >= public.local_today()
   and ti.status not in ('concluida_prazo', 'concluida_atraso')
   and s.step_index >= jsonb_array_length(coalesce(ti.template_snapshot -> 'instructions', '[]'::jsonb));
select set_config('app.audit_action', '', true);


-- >>> 20261113001200_gestor_wording.sql
-- =====================================================================
-- Rotina · "admin master" passa a se chamar "gestor" em todos os textos
-- (modelos de atividade, tarefas e mensagens de erro do banco).
-- O valor interno do papel continua 'admin' (tipo user_role), exibido como "Gestor".
-- =====================================================================

create or replace function pg_temp.gestor(t text) returns text language sql immutable as $$
  select replace(replace(replace(replace(replace(replace(t,
    'o gestor e para o admin master', 'o gestor'),
    'Apenas admin master', 'Apenas o gestor'),
    'Apenas admin', 'Apenas o gestor'),
    'outra pessoa a admin', 'outra pessoa a gestor'),
    'O admin master', 'O gestor'),
    'admin master', 'gestor');
$$;

-- Modelos de atividade
update public.activity_templates set
  description     = pg_temp.gestor(description),
  instructions    = pg_temp.gestor(instructions::text)::jsonb,
  fields          = pg_temp.gestor(fields::text)::jsonb,
  followup_fields = pg_temp.gestor(followup_fields::text)::jsonb
where coalesce(description, '') ~* 'admin' or instructions::text ~* 'admin' or fields::text ~* 'admin';

-- Cópia do modelo guardada em cada tarefa (só o texto muda)
select set_config('app.audit_action', 'ressincronizacao', true);
update public.task_instances
   set template_snapshot = pg_temp.gestor(template_snapshot::text)::jsonb
 where template_snapshot::text ~* 'admin master';
select set_config('app.audit_action', '', true);

-- Mensagens das funções do banco
do $$
declare r record; def text;
begin
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and pg_get_functiondef(p.oid) ~ '(admin master|Apenas admin|outra pessoa a admin)'
  loop
    def := pg_temp.gestor(pg_get_functiondef(r.oid));
    execute def;
  end loop;
end $$;

comment on type public.user_role is 'Papel do usuário: analista ou admin (exibido como "Gestor").';
comment on column public.profiles.role is 'Papel: analista ou admin (Gestor). Pode ser editado aqui ou no painel; o login acompanha.';


-- >>> 20261113001300_links_and_test_dates.sql
-- =====================================================================
-- Rotina · Links das ferramentas e datas dos testes
--
-- 1. useful_links: cards com nome, link e descrição das ferramentas usadas
--    nas atividades. Todos os usuários ativos leem; só o gestor cria,
--    edita e remove (garantido por RLS).
-- 2. Testes do mensal: cada referência enviada para aprovação passa a ter
--    o motivo do teste, a data de início e a data final prevista. Esses
--    dados alimentam o menu "Testes" do analista.
-- =====================================================================

create table public.useful_links (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(btrim(name)) > 0),
  url          text not null check (url ~* '^https?://[^\s]+$'),
  description  text,
  sort_order   int  not null default 0,
  created_by   uuid references public.profiles (id) default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.useful_links enable row level security;
create policy links_select on public.useful_links for select to authenticated using (public.is_active_user());
create policy links_write  on public.useful_links for all    to authenticated
  using (public.is_admin()) with check (public.is_admin());
revoke all on public.useful_links from anon;

create trigger links_touch before update on public.useful_links
  for each row execute function public.touch_updated_at();
create trigger a_audit after insert or update or delete on public.useful_links
  for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------
-- Testes do mensal: referência, motivo, início e fim previsto
-- ---------------------------------------------------------------------
update public.activity_templates set
  fields = $j$[
    {"key":"testes","label":"Testes por referência","type":"group","item_label":"Referência","min_items":2,"reviewable":true,
     "help":"Informe as 2 referências, o motivo de cada teste e o período. O gestor aprova ou reprova cada referência de forma independente.",
     "fields":[
       {"key":"sku","label":"Referência testada","type":"text","mono":true,"required":true},
       {"key":"sugestao","label":"Motivo do teste","type":"textarea","required":true,
        "help":"O que será testado e por quê. Por exemplo: trocar o kit de fotos para ver se melhora a taxa de conversão."},
       {"key":"inicio","label":"Início do teste","type":"date","required":true},
       {"key":"fim_previsto","label":"Data final prevista","type":"date","required":true}
     ]}
  ]$j$::jsonb
where code = 'M3';

-- Tarefas de testes ainda não enviadas passam a pedir as datas.
select set_config('app.audit_action', 'ressincronizacao', true);
update public.task_instances ti
   set template_snapshot = to_jsonb(t) - 'created_at' - 'updated_at'
  from public.activity_templates t
 where ti.template_id = t.id and t.code = 'M3'
   and ti.status not in ('concluida_prazo', 'concluida_atraso');
select set_config('app.audit_action', '', true);


-- >>> 20261113001400_test_requests.sql
-- =====================================================================
-- Rotina · solicitações de teste (bloco opcional do analista)
--
-- O analista pode, a qualquer momento e sem obrigação, pedir um teste para
-- uma referência: o que testar, por quê, início e data final prevista.
-- O gestor aprova ou reprova (reprovação exige justificativa). O analista
-- vê a decisão e pode corrigir e reenviar uma solicitação reprovada.
-- Escrita só pelas funções abaixo; leitura: o próprio analista ou o gestor.
-- =====================================================================

create table public.test_requests (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id),
  sku            text not null check (length(btrim(sku)) > 0),
  analysis       text not null check (length(btrim(analysis)) > 0),     -- o que deve ser testado
  explanation    text not null check (length(btrim(explanation)) > 0),  -- por quê
  start_date     date not null,
  end_date       date not null,
  status         text not null default 'pendente' check (status in ('pendente', 'aprovada', 'reprovada')),
  review_reason  text,
  reviewed_by    uuid references public.profiles (id),
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (end_date >= start_date),
  check (status <> 'reprovada' or coalesce(length(btrim(review_reason)), 0) > 0)
);
create index test_requests_user on public.test_requests (user_id, created_at desc);
create index test_requests_status on public.test_requests (status);

alter table public.test_requests enable row level security;
create policy test_requests_select on public.test_requests for select to authenticated
  using (public.is_admin() or (user_id = auth.uid() and public.is_active_user()));
revoke all on public.test_requests from anon;
revoke insert, update, delete on public.test_requests from authenticated;

create trigger test_requests_touch before update on public.test_requests
  for each row execute function public.touch_updated_at();
create trigger a_audit after insert or update on public.test_requests
  for each row execute function public.audit_trigger();

create or replace function public.validate_test_request(p_sku text, p_analysis text, p_explanation text, p_start date, p_end date)
returns void language plpgsql immutable as $$
begin
  if coalesce(btrim(p_sku), '') = '' then raise exception 'Informe a referência.' using errcode = '22023'; end if;
  if coalesce(btrim(p_analysis), '') = '' then raise exception 'Descreva o que deve ser testado.' using errcode = '22023'; end if;
  if coalesce(btrim(p_explanation), '') = '' then raise exception 'Explique por que fazer este teste.' using errcode = '22023'; end if;
  if p_start is null or p_end is null then raise exception 'Informe o início e a data final prevista.' using errcode = '22023'; end if;
  if p_end < p_start then raise exception 'A data final precisa ser igual ou depois do início.' using errcode = '22023'; end if;
end $$;

-- Analista: nova solicitação
create or replace function public.create_test_request(p_sku text, p_analysis text, p_explanation text, p_start date, p_end date)
returns public.test_requests language plpgsql security definer set search_path = public as $$
declare r test_requests;
begin
  if not is_active_user() then raise exception 'Usuário inativo.' using errcode = '42501'; end if;
  perform validate_test_request(p_sku, p_analysis, p_explanation, p_start, p_end);
  perform set_config('app.audit_action', 'teste_solicitado', true);
  insert into test_requests (user_id, sku, analysis, explanation, start_date, end_date)
  values (auth.uid(), btrim(p_sku), btrim(p_analysis), btrim(p_explanation), p_start, p_end)
  returning * into r;
  perform set_config('app.audit_action', '', true);
  return r;
end $$;

-- Analista: corrige e reenvia uma solicitação reprovada
create or replace function public.resubmit_test_request(p_id uuid, p_sku text, p_analysis text, p_explanation text, p_start date, p_end date)
returns public.test_requests language plpgsql security definer set search_path = public as $$
declare r test_requests;
begin
  select * into r from test_requests where id = p_id for update;
  if not found or r.user_id is distinct from auth.uid() then
    raise exception 'Solicitação não encontrada.' using errcode = 'P0002';
  end if;
  if r.status <> 'reprovada' then raise exception 'Só dá para reenviar uma solicitação reprovada.' using errcode = '22023'; end if;
  perform validate_test_request(p_sku, p_analysis, p_explanation, p_start, p_end);
  perform set_config('app.audit_action', 'teste_reenviado', true);
  update test_requests
     set sku = btrim(p_sku), analysis = btrim(p_analysis), explanation = btrim(p_explanation),
         start_date = p_start, end_date = p_end, status = 'pendente',
         review_reason = null, reviewed_by = null, reviewed_at = null
   where id = p_id
  returning * into r;
  perform set_config('app.audit_action', '', true);
  return r;
end $$;

-- Gestor: aprova ou reprova (reprovar exige justificativa)
create or replace function public.review_test_request(p_id uuid, p_status text, p_reason text default null)
returns public.test_requests language plpgsql security definer set search_path = public as $$
declare r test_requests;
begin
  if not is_admin() then raise exception 'Apenas o gestor aprova ou reprova testes.' using errcode = '42501'; end if;
  if p_status not in ('aprovada', 'reprovada') then raise exception 'Escolha aprovar ou reprovar.' using errcode = '22023'; end if;
  if p_status = 'reprovada' and coalesce(btrim(p_reason), '') = '' then
    raise exception 'Informe a justificativa da reprovação, para o analista saber o motivo.' using errcode = '22023';
  end if;
  select * into r from test_requests where id = p_id for update;
  if not found then raise exception 'Solicitação não encontrada.' using errcode = 'P0002'; end if;
  if r.status <> 'pendente' then raise exception 'Esta solicitação já foi avaliada.' using errcode = '22023'; end if;
  perform set_config('app.audit_action', case p_status when 'aprovada' then 'teste_aprovado' else 'teste_reprovado' end, true);
  update test_requests
     set status = p_status, review_reason = nullif(btrim(p_reason), ''), reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_id
  returning * into r;
  perform set_config('app.audit_action', '', true);
  return r;
end $$;

revoke execute on function public.validate_test_request(text, text, text, date, date),
  public.create_test_request(text, text, text, date, date),
  public.resubmit_test_request(uuid, text, text, text, date, date),
  public.review_test_request(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.create_test_request(text, text, text, date, date),
  public.resubmit_test_request(uuid, text, text, text, date, date),
  public.review_test_request(uuid, text, text)
  to authenticated;


-- >>> 20261113001500_performance.sql
-- =====================================================================
-- Rotina · desempenho
--
-- 1. Regras de acesso (RLS): auth.uid(), is_admin() e is_active_user() passam
--    a ser avaliados UMA vez por consulta (subselect = "initPlan"), e não uma
--    vez por linha. Mesmas regras, mesmo resultado; só mais rápido.
-- 2. Índices para os filtros mais usados (sequência por período, envios por
--    analista, revisões por revisor).
-- 3. dashboard_today(): tudo o que a tela "Hoje" precisa numa única chamada
--    (tarefas do período, pendências, etapas, aprovações e solicitações).
-- =====================================================================

-- 1. RLS -----------------------------------------------------------------
alter policy profiles_select on public.profiles
  using (id = (select auth.uid()) or (select public.is_admin()));
alter policy profiles_admin_update on public.profiles
  using ((select public.is_admin())) with check ((select public.is_admin()));

alter policy settings_select on public.settings using ((select public.is_active_user()));
alter policy settings_write  on public.settings using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy holidays_select on public.holidays using ((select public.is_active_user()));
alter policy holidays_write  on public.holidays using ((select public.is_admin())) with check ((select public.is_admin()));

alter policy templates_select on public.activity_templates
  using (
    (select public.is_admin())
    or ((select public.is_active_user()) and (assign_all or exists (
      select 1 from public.template_assignments a
       where a.template_id = activity_templates.id and a.user_id = (select auth.uid()))))
  );
alter policy templates_write on public.activity_templates
  using ((select public.is_admin())) with check ((select public.is_admin()));

alter policy assignments_select on public.template_assignments
  using ((select public.is_admin()) or user_id = (select auth.uid()));
alter policy assignments_write on public.template_assignments
  using ((select public.is_admin())) with check ((select public.is_admin()));

alter policy tasks_select on public.task_instances
  using ((select public.is_admin()) or (user_id = (select auth.uid()) and (select public.is_active_user())));
alter policy submissions_select on public.task_submissions
  using ((select public.is_admin()) or (user_id = (select auth.uid()) and (select public.is_active_user())));
alter policy gate_answers_select on public.gate_answers
  using ((select public.is_admin()) or exists (
    select 1 from public.task_submissions s where s.id = submission_id and s.user_id = (select auth.uid())));
alter policy reviews_select on public.reviews
  using ((select public.is_admin()) or exists (
    select 1 from public.task_instances t where t.id = task_id and t.user_id = (select auth.uid())));
alter policy audit_select on public.audit_log using ((select public.is_admin()));

alter policy task_steps_select on public.task_steps
  using ((select public.is_admin()) or exists (
    select 1 from public.task_instances t where t.id = task_id and t.user_id = (select auth.uid())));
alter policy item_reviews_select on public.task_item_reviews
  using ((select public.is_admin()) or exists (
    select 1 from public.task_instances t where t.id = task_id and t.user_id = (select auth.uid())));

alter policy links_select on public.useful_links using ((select public.is_active_user()));
alter policy links_write  on public.useful_links using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy test_requests_select on public.test_requests
  using ((select public.is_admin()) or (user_id = (select auth.uid()) and (select public.is_active_user())));

-- 2. Índices ---------------------------------------------------------------
create index if not exists task_instances_user_period on public.task_instances (user_id, period_key);
create index if not exists task_instances_user_period_range on public.task_instances (user_id, period_start, period_end);
create index if not exists task_instances_template on public.task_instances (template_id);
create index if not exists task_submissions_user on public.task_submissions (user_id);
create index if not exists reviews_reviewer on public.reviews (reviewer_id);
create index if not exists task_item_reviews_reviewer on public.task_item_reviews (reviewer_id);

-- 3. Tela "Hoje" numa chamada só ------------------------------------------
-- security invoker: roda com as permissões de quem chama (RLS vale normalmente).
create or replace function public.dashboard_today(p_today date, p_since date)
returns jsonb language sql stable security invoker set search_path = public as $$
  with mine as (
    select t.* from task_instances t
     where t.user_id = auth.uid()
       and ((t.period_start <= p_today and t.period_end >= p_today)
         or (t.ref_date >= p_since and t.ref_date < p_today
             and (t.status in ('pendente', 'em_andamento', 'bloqueada_gate', 'nao_feita') or t.needs_rework)))
  )
  select jsonb_build_object(
    'tasks',         coalesce((select jsonb_agg(to_jsonb(m) order by m.due_at) from mine m), '[]'::jsonb),
    'steps',         coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'task_id', s.task_id, 'step_index', s.step_index,
                                                     'checked_at', s.checked_at, 'checked_by', s.checked_by,
                                                     'user', jsonb_build_object('full_name', p.full_name)) order by s.step_index)
                               from task_steps s left join profiles p on p.id = s.checked_by
                              where s.task_id in (select id from mine)), '[]'::jsonb),
    'item_reviews',  coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc)
                               from task_item_reviews r where r.task_id in (select id from mine)), '[]'::jsonb),
    'test_requests', coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc)
                               from test_requests q where q.user_id = auth.uid()), '[]'::jsonb)
  );
$$;

revoke execute on function public.dashboard_today(date, date) from public, anon;
grant execute on function public.dashboard_today(date, date) to authenticated;



-- >>> 20261113001600_workdays_only.sql
-- =====================================================================
-- Rotina · atividades só em dia de expediente (segunda a sexta)
--
-- 1. Etapas, rascunhos e envios só são aceitos em dia útil (Parâmetros >
--    dias de expediente, padrão segunda a sexta, menos feriados).
-- 2. O marco mensal vence no último dia útil do mês (nunca num fim de semana).
-- A tela do analista recomeça toda segunda: pendências de semanas anteriores
-- deixam de aparecer para ele e ficam só no acompanhamento do gestor.
-- =====================================================================

-- 1. Bloqueio fora do expediente (vale para set_step, save_draft, submit_task,
--    record_followup e resubmit_item, que passam por esta função).
create or replace function public.load_own_task(p_task uuid)
returns public.task_instances language plpgsql security definer set search_path = public as $$
declare t task_instances;
begin
  select * into t from task_instances where id = p_task for update;
  if not found or t.user_id is distinct from auth.uid() then
    raise exception 'Atividade não encontrada.' using errcode = 'P0002';
  end if;
  if not is_active_user() then
    raise exception 'Usuário inativo.' using errcode = '42501';
  end if;
  if not is_workday(local_today()) then
    raise exception 'Sem expediente hoje: as atividades valem de segunda a sexta.' using errcode = '22023';
  end if;
  if t.status = 'pausada' then
    raise exception 'Esta atividade está pausada e não aceita registros.' using errcode = '22023';
  end if;
  return t;
end $$;
revoke execute on function public.load_own_task(uuid) from public, anon, authenticated;

-- 2. Mensal: último dia útil do mês
create or replace function public.monthly_due(m date)
returns date language sql stable as $$
  select max(g::date)
  from generate_series(date_trunc('month', m)::date,
                       (date_trunc('month', m) + interval '1 month - 1 day')::date, interval '1 day') g
  where public.is_workday(g::date);
$$;

select set_config('app.audit_action', 'ressincronizacao', true);
update public.task_instances ti
   set ref_date = public.monthly_due(ti.period_start),
       due_at   = public.local_due(public.monthly_due(ti.period_start), '23:59:59')
 where ti.template_snapshot ->> 'frequency' = 'mensal'
   and ti.status in ('pendente', 'em_andamento', 'bloqueada_gate')
   and public.monthly_due(ti.period_start) is not null
   and ti.ref_date <> public.monthly_due(ti.period_start);
select set_config('app.audit_action', '', true);


-- >>> 20261113001700_user_visibility.sql
-- =====================================================================
-- Rotina · o gestor escolhe quais atividades aparecem para cada analista
--
-- 1. profiles.frequencies: frequências que o analista recebe (diária,
--    semanal, mensal). Padrão: todas. Ex.: só '{diaria}' = só as diárias.
-- 2. template_exclusions: tira um modelo "para todos" de um analista
--    específico, sem mexer nos demais.
-- 3. template_applies(modelo, analista) concentra a regra; a geração de
--    tarefas e as ressincronizações passam a usá-la.
-- 4. Ao mudar a visibilidade, tarefas futuras intocadas somem; as já
--    iniciadas ficam "pausadas" (e voltam se a atividade for reativada).
-- =====================================================================

alter table public.profiles
  add column if not exists frequencies public.frequency[] not null default '{diaria,semanal,mensal}';
comment on column public.profiles.frequencies is 'Frequências de atividade que o analista recebe (diaria, semanal, mensal).';

create table if not exists public.template_exclusions (
  template_id  uuid not null references public.activity_templates (id) on delete cascade,
  user_id      uuid not null references public.profiles (id),
  created_at   timestamptz not null default now(),
  primary key (template_id, user_id)
);
alter table public.template_exclusions enable row level security;
create policy exclusions_select on public.template_exclusions for select to authenticated
  using ((select public.is_admin()) or user_id = (select auth.uid()));
create policy exclusions_write on public.template_exclusions for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
revoke all on public.template_exclusions from anon;

create trigger a_audit after insert or delete on public.template_exclusions
  for each row execute function public.audit_trigger();

-- Regra única: o modelo vale para o analista?
create or replace function public.template_applies(p_template uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from activity_templates t join profiles u on u.id = p_user
     where t.id = p_template
       and t.frequency = any (u.frequencies)
       and (t.assign_all or exists (select 1 from template_assignments a
                                     where a.template_id = t.id and a.user_id = u.id))
       and not exists (select 1 from template_exclusions e
                        where e.template_id = t.id and e.user_id = u.id))
$$;

-- Geração de tarefas (igual à anterior, com a regra de visibilidade)
create or replace function public.generate_tasks(p_from date, p_to date)
returns int language plpgsql security definer set search_path = public as $$
declare d date; wk date; mo date; n int := 0; c int;
begin
  if p_to < p_from then return 0; end if;
  if p_to - p_from > 400 then raise exception 'Intervalo grande demais (máx. 400 dias).'; end if;

  -- Diárias
  for d in select g::date from generate_series(p_from, p_to, interval '1 day') g loop
    continue when not is_workday(d);
    insert into task_instances (template_id, user_id, period_key, ref_date, period_start, period_end,
                                due_at, curve, weight, template_snapshot)
    select t.id, u.id, to_char(d, 'YYYY-MM-DD'), d, d, d,
           local_due(d, t.cutoff_time),
           case when t.shows_curve then curve_for(d) end,
           t.weight, to_jsonb(t) - 'created_at' - 'updated_at'
    from activity_templates t
    join profiles u on u.role = 'analista' and u.active
    where t.frequency = 'diaria' and not t.paused
      and extract(isodow from d)::int = any (t.weekdays)
      and (t.valid_from is null or d >= t.valid_from)
      and (t.valid_to   is null or d <= t.valid_to)
      and template_applies(t.id, u.id)
      and local_due(d, t.cutoff_time) > greatest(t.created_at, u.created_at)
    on conflict (template_id, user_id, period_key) do nothing;
    get diagnostics c = row_count; n := n + c;
  end loop;

  -- Semanais (semana ISO, vence no último dia útil até o maior dia configurado)
  for wk in select g::date from generate_series(date_trunc('week', p_from)::date, p_to, interval '7 day') g loop
    insert into task_instances (template_id, user_id, period_key, ref_date, period_start, period_end,
                                due_at, curve, weight, template_snapshot)
    select t.id, u.id, to_char(wk, 'IYYY-"W"IW'), x.due, wk, wk + 6,
           local_due(x.due, t.cutoff_time), null, t.weight,
           to_jsonb(t) - 'created_at' - 'updated_at'
    from activity_templates t
    cross join lateral (select weekly_due(wk, t.weekdays) as due) x
    join profiles u on u.role = 'analista' and u.active
    where t.frequency = 'semanal' and not t.paused and x.due is not null
      and (t.valid_from is null or wk + 6 >= t.valid_from)
      and (t.valid_to   is null or wk     <= t.valid_to)
      and template_applies(t.id, u.id)
      and local_due(x.due, t.cutoff_time) > greatest(t.created_at, u.created_at)
    on conflict (template_id, user_id, period_key) do nothing;
    get diagnostics c = row_count; n := n + c;
  end loop;

  -- Mensais (vence no último dia útil do mês)
  for mo in select g::date from generate_series(date_trunc('month', p_from)::date, p_to, interval '1 month') g loop
    insert into task_instances (template_id, user_id, period_key, ref_date, period_start, period_end,
                                due_at, curve, weight, template_snapshot)
    select t.id, u.id, to_char(mo, 'YYYY-MM'), x.due, mo, (mo + interval '1 month - 1 day')::date,
           local_due(x.due, t.cutoff_time), null, t.weight,
           to_jsonb(t) - 'created_at' - 'updated_at'
    from activity_templates t
    cross join lateral (select monthly_due(mo) as due) x
    join profiles u on u.role = 'analista' and u.active
    where t.frequency = 'mensal' and not t.paused and x.due is not null
      and (t.valid_from is null or (mo + interval '1 month - 1 day')::date >= t.valid_from)
      and (t.valid_to   is null or mo <= t.valid_to)
      and template_applies(t.id, u.id)
      and local_due(x.due, t.cutoff_time) > greatest(t.created_at, u.created_at)
    on conflict (template_id, user_id, period_key) do nothing;
    get diagnostics c = row_count; n := n + c;
  end loop;

  return n;
end $$;

-- Re-sincroniza as tarefas futuras de um analista após mudar o que ele vê.
create or replace function public.resync_user(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.audit_action', 'ressincronizacao', true);

  delete from task_instances ti
   where ti.user_id = p_user and ti.ref_date >= local_today()
     and ti.status = 'pendente' and ti.started_at is null and ti.submitted_at is null
     and ti.payload = '{}'::jsonb
     and not exists (select 1 from task_submissions s where s.task_id = ti.id)
     and not template_applies(ti.template_id, p_user);

  update task_instances set status = 'pausada'
   where user_id = p_user and ref_date >= local_today()
     and status in ('pendente', 'em_andamento', 'bloqueada_gate')
     and not template_applies(template_id, p_user);

  update task_instances ti
     set status = case when ti.started_at is null then 'pendente'::task_status else 'em_andamento'::task_status end
   where ti.user_id = p_user and ti.ref_date >= local_today() and ti.status = 'pausada'
     and template_applies(ti.template_id, p_user)
     and exists (select 1 from activity_templates t where t.id = ti.template_id and not t.paused)
     and exists (select 1 from profiles u where u.id = p_user and u.active and u.role = 'analista');

  perform set_config('app.audit_action', '', true);
  perform generate_tasks(local_today(), week_end(local_today()));
end $$;

-- Reativar um modelo não reativa tarefas de quem não deve vê-lo.
create or replace function public.resync_template(p_template uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t activity_templates;
begin
  select * into t from activity_templates where id = p_template;
  perform set_config('app.audit_action', 'ressincronizacao', true);

  delete from task_instances ti
   where ti.template_id = p_template and ti.ref_date >= local_today()
     and ti.status = 'pendente' and ti.started_at is null and ti.submitted_at is null
     and ti.payload = '{}'::jsonb
     and not exists (select 1 from task_submissions s where s.task_id = ti.id);

  if t.id is not null and t.paused then
    update task_instances set status = 'pausada'
     where template_id = p_template and ref_date >= local_today()
       and status in ('pendente', 'em_andamento', 'bloqueada_gate');
  elsif t.id is not null then
    update task_instances
       set status = case when started_at is null then 'pendente'::task_status else 'em_andamento'::task_status end
     where template_id = p_template and ref_date >= local_today() and status = 'pausada'
       and template_applies(template_id, user_id);
  end if;

  perform set_config('app.audit_action', '', true);
  perform generate_tasks(local_today(), week_end(local_today()));
end $$;

-- Perfil: desativar/promover tira as tarefas; reativar ou mudar frequências ressincroniza.
create or replace function public.trg_profile_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if ((new.active is distinct from old.active) or (new.role is distinct from old.role))
     and (not new.active or new.role <> 'analista') then
    perform set_config('app.audit_action', 'ressincronizacao', true);
    delete from task_instances ti
     where ti.user_id = new.id and ti.ref_date >= local_today() and ti.status = 'pendente'
       and ti.started_at is null and ti.submitted_at is null
       and not exists (select 1 from task_submissions s where s.task_id = ti.id);
    update task_instances set status = 'pausada'
     where user_id = new.id and ref_date >= local_today()
       and status in ('pendente', 'em_andamento', 'bloqueada_gate');
    perform set_config('app.audit_action', '', true);
  elsif (new.active is distinct from old.active) or (new.role is distinct from old.role)
     or (new.frequencies is distinct from old.frequencies) then
    perform resync_user(new.id);
  end if;
  return null;
end $$;

create or replace function public.trg_exclusion_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then perform resync_user(old.user_id);
  else perform resync_user(new.user_id); end if;
  return null;
end $$;

create trigger z_exclusions_resync after insert or delete on public.template_exclusions
  for each row execute function public.trg_exclusion_changed();

revoke execute on function public.template_applies(uuid, uuid), public.resync_user(uuid),
  public.trg_exclusion_changed() from public, anon, authenticated;
