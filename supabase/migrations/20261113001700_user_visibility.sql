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
