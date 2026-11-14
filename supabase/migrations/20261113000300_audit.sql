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
