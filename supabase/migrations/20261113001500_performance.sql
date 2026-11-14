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

