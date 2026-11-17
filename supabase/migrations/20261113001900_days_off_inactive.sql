-- =====================================================================
-- Rotina · dia desativado por analista e usuário inativo fora das métricas
--
-- 1. user_days_off: o gestor desativa um dia para um analista (ex.: hoje a
--    pessoa vai fazer outras atividades). As atividades DIÁRIAS desse dia
--    não aceitam registros e não contam nas métricas, estejam feitas ou não.
--    Semanais e mensais seguem normais (a pessoa pode fazê-las em outro dia).
--    Reativado o dia (linha apagada), as tarefas voltam a contar.
-- 2. Usuário desativado (profiles.active = false) sai de TODAS as métricas,
--    inclusive o histórico. Reativado, o histórico volta a contar.
-- =====================================================================

create table if not exists public.user_days_off (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  day         date not null,
  reason      text,
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (user_id, day)
);
comment on table public.user_days_off is 'Dias desativados por analista: as atividades diárias do dia não contam nem aceitam registros.';

alter table public.user_days_off enable row level security;
create policy days_off_select on public.user_days_off for select to authenticated
  using ((select public.is_admin()) or (user_id = (select auth.uid()) and (select public.is_active_user())));
create policy days_off_write on public.user_days_off for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
revoke all on public.user_days_off from anon;
grant select, insert, update, delete on public.user_days_off to authenticated;

create trigger a_audit after insert or update or delete on public.user_days_off
  for each row execute function public.audit_trigger();

-- O dia está desativado para a tarefa? (só vale para as diárias)
create or replace function public.task_day_off(p_user uuid, p_day date, p_frequency text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_frequency = 'diaria'
     and exists (select 1 from user_days_off d where d.user_id = p_user and d.day = p_day);
$$;
grant execute on function public.task_day_off(uuid, date, text) to authenticated;

-- Registros (etapas, rascunho, envio, acompanhamento, reenvio) barrados no dia desativado.
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
  if task_day_off(t.user_id, t.ref_date, t.template_snapshot ->> 'frequency') then
    raise exception 'Este dia foi desativado pelo gestor: as atividades diárias dele não contam.' using errcode = '22023';
  end if;
  return t;
end $$;
revoke execute on function public.load_own_task(uuid) from public, anon, authenticated;

-- Métricas: fora feriados, dias desativados (diárias) e usuários inativos.
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
join profiles p on p.id = t.user_id
where p.active
  and not exists (select 1 from holidays h where h.day = t.ref_date)
  and not (t.template_snapshot ->> 'frequency' = 'diaria'
           and exists (select 1 from user_days_off d where d.user_id = t.user_id and d.day = t.ref_date));

grant select on public.v_task_facts to authenticated;
