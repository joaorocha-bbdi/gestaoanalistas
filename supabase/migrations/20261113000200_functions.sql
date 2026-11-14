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
