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
