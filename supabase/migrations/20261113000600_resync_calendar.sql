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
