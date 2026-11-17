-- =====================================================================
-- Rotina · zera os dados operacionais para começar do zero
--
-- APAGA
--   · todos os logins que NÃO são gestor (role = 'admin'), com perfil e acesso
--   · todas as tarefas e o que vem delas: etapas, envios, respostas das
--     verificações, revisões, revisões por item e solicitações de teste
--   · atribuições e exclusões de atividade por analista e dias desativados
--   · todo o log de auditoria
--
-- MANTÉM
--   · os gestores (admin) e o login deles
--   · modelos de atividade (diárias, semanais, mensais), parâmetros,
--     feriados e links úteis
--
-- É tudo ou nada (uma transação). Se não houver nenhum gestor ativo, nada é
-- apagado. Rodar com role postgres:
--   npx supabase db query --remote --file supabase/maintenance/reset_operacional.sql
-- =====================================================================
begin;

do $$
declare
  alvo uuid[];
begin
  if not exists (select 1 from public.profiles where role = 'admin' and active) then
    raise exception 'NADA FOI APAGADO: não existe gestor ativo; você perderia o acesso.';
  end if;

  select coalesce(array_agg(id), '{}') into alvo from public.profiles where role <> 'admin';

  -- Sem auditoria e sem regeneração automática durante a limpeza.
  alter table public.audit_log            disable trigger audit_no_update;
  alter table public.task_instances       disable trigger a_audit;
  alter table public.task_steps           disable trigger a_audit;
  alter table public.reviews              disable trigger a_audit;
  alter table public.task_item_reviews    disable trigger a_audit;
  alter table public.test_requests        disable trigger a_audit;
  alter table public.template_assignments disable trigger a_audit;
  alter table public.template_assignments disable trigger z_assignments_resync;
  alter table public.template_exclusions  disable trigger a_audit;
  alter table public.template_exclusions  disable trigger z_exclusions_resync;
  alter table public.profiles             disable trigger a_audit;

  delete from public.gate_answers;
  delete from public.task_submissions;
  delete from public.reviews;
  delete from public.task_item_reviews;
  delete from public.task_steps;
  delete from public.test_requests;
  delete from public.task_instances;
  delete from public.template_assignments;
  delete from public.template_exclusions;
  delete from public.user_days_off;

  update public.settings     set updated_by = null where updated_by = any (alvo);
  update public.useful_links set created_by = null where created_by = any (alvo);

  delete from public.profiles where id = any (alvo);
  delete from auth.users      where id = any (alvo);   -- identidades e sessões vão junto

  delete from public.audit_log;

  alter table public.profiles             enable trigger a_audit;
  alter table public.template_exclusions  enable trigger z_exclusions_resync;
  alter table public.template_exclusions  enable trigger a_audit;
  alter table public.template_assignments enable trigger z_assignments_resync;
  alter table public.template_assignments enable trigger a_audit;
  alter table public.test_requests        enable trigger a_audit;
  alter table public.task_item_reviews    enable trigger a_audit;
  alter table public.reviews              enable trigger a_audit;
  alter table public.task_steps           enable trigger a_audit;
  alter table public.task_instances       enable trigger a_audit;
  alter table public.audit_log            enable trigger audit_no_update;

  raise notice 'Removidos % logins não gestores e todos os registros operacionais.', cardinality(alvo);
end $$;

select (select count(*) from auth.users) logins,
       (select string_agg(email, ', ') from public.profiles) perfis,
       (select count(*) from public.task_instances) tarefas,
       (select count(*) from public.task_steps) etapas,
       (select count(*) from public.task_submissions) envios,
       (select count(*) from public.audit_log) auditoria,
       (select count(*) from public.activity_templates) modelos,
       (select count(*) from public.settings) parametros,
       (select count(*) from public.useful_links) links;

commit;
