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
