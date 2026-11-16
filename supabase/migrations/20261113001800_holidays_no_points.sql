-- =====================================================================
-- Rotina · feriado não conta ponto
--
-- Um dia cadastrado como feriado é nulo nas métricas: nenhuma tarefa com
-- data de referência nesse dia entra em eficiência, conclusão, pontualidade,
-- qualidade ou sequência, esteja ela feita, atrasada ou não feita.
-- Vale também para feriados cadastrados depois do dia (a ressincronização
-- só apaga tarefas futuras; as passadas continuam no histórico, sem ponto).
-- Se o feriado for removido, as tarefas do dia voltam a contar.
-- =====================================================================

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
where not exists (select 1 from holidays h where h.day = t.ref_date);

grant select on public.v_task_facts to authenticated;
