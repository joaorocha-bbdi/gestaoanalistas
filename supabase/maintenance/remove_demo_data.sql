-- =====================================================================
-- Rotina · remove os dados de demonstração (usuários @demo.rotina)
--
-- Apaga, de uma vez só, os usuários de demonstração e tudo o que é deles:
-- tarefas, etapas, envios, respostas das verificações, revisões, aprovações de
-- teste, atribuições e os registros de auditoria ligados a eles.
-- Não mexe nos modelos de atividade, nos parâmetros nem em outros usuários.
--
-- SEGURANÇA
--  · Antes de apagar, promove a gestor o usuário cujo e-mail você informar
--    abaixo. Se não houver nenhum admin real (fora de @demo.rotina), o script só
--    avisa e NÃO apaga nada: senão você perderia o acesso.
--  · É tudo ou nada: se algo falhar, nada é apagado.
--  · O log de auditoria é imutável; esta limpeza única é a exceção, e só remove
--    linhas ligadas aos usuários de demonstração.
--
-- Rodar no SQL Editor do Supabase (role postgres), uma vez.
-- =====================================================================
-- >>> EDITE A LINHA ABAIXO com o e-mail do SEU usuário (crie antes em
--     Authentication > Users > Add user, marcando "Auto Confirm User").
--     Esse usuário vira gestor. Os de @demo.rotina são apagados.
create temp table if not exists _rotina_cfg (admin_email text);
truncate _rotina_cfg;
insert into _rotina_cfg values ('SEU-EMAIL@empresa.com');

do $$
declare
  demo uuid[];
  demo_txt text[];
  v_email text := (select lower(btrim(admin_email)) from _rotina_cfg limit 1);
begin
  -- Promove o seu usuário a gestor (se o e-mail foi preenchido e o usuário existe).
  if v_email is not null and v_email <> 'seu-email@empresa.com' then
    if exists (select 1 from auth.users where lower(email) = v_email) then
      update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'
       where lower(email) = v_email;
      update public.profiles set role = 'admin', active = true where lower(email) = v_email;
      raise notice 'Gestor: %', v_email;
    else
      raise notice 'Usuário % não encontrado. Crie em Authentication > Users > Add user e rode de novo.', v_email;
    end if;
  end if;

  select coalesce(array_agg(id), '{}') into demo from public.profiles where email like '%@demo.rotina';
  if cardinality(demo) = 0 then
    raise notice 'Nenhum dado de demonstração encontrado. Nada a fazer.';
    return;
  end if;
  if not exists (select 1 from public.profiles where role = 'admin' and active and email not like '%@demo.rotina') then
    raise notice 'NADA FOI APAGADO: falta um gestor real (fora de @demo.rotina). Preencha o e-mail no topo deste arquivo e rode de novo.';
    return;
  end if;
  demo_txt := demo::text[];

  -- Auditoria e geração automática fora do caminho, só durante esta limpeza.
  alter table public.audit_log disable trigger audit_no_update;
  alter table public.task_instances disable trigger a_audit;
  alter table public.reviews disable trigger a_audit;
  alter table public.task_steps disable trigger a_audit;
  alter table public.task_item_reviews disable trigger a_audit;
  alter table public.template_assignments disable trigger a_audit;
  alter table public.template_assignments disable trigger z_assignments_resync;
  alter table public.profiles disable trigger a_audit;

  delete from public.template_assignments where user_id = any (demo);
  delete from public.gate_answers where submission_id in (select s.id from public.task_submissions s where s.user_id = any (demo));
  delete from public.task_submissions where user_id = any (demo);
  delete from public.reviews
   where reviewer_id = any (demo) or task_id in (select id from public.task_instances where user_id = any (demo));
  delete from public.task_item_reviews where reviewer_id = any (demo);
  delete from public.task_instances where user_id = any (demo);          -- leva junto etapas e aprovações de teste
  update public.settings set updated_by = null where updated_by = any (demo);

  delete from public.audit_log
   where actor_id = any (demo)
      or action = 'seed'
      or coalesce(after, before) ->> 'user_id'     = any (demo_txt)
      or coalesce(after, before) ->> 'checked_by'  = any (demo_txt)
      or coalesce(after, before) ->> 'reviewer_id' = any (demo_txt)
      or (entity = 'profiles' and coalesce(after, before) ->> 'id' = any (demo_txt));

  delete from public.profiles where id = any (demo);
  delete from auth.identities where user_id = any (demo);
  delete from auth.users where id = any (demo);

  alter table public.profiles enable trigger a_audit;
  alter table public.template_assignments enable trigger z_assignments_resync;
  alter table public.template_assignments enable trigger a_audit;
  alter table public.task_item_reviews enable trigger a_audit;
  alter table public.task_steps enable trigger a_audit;
  alter table public.reviews enable trigger a_audit;
  alter table public.task_instances enable trigger a_audit;
  alter table public.audit_log enable trigger audit_no_update;

  raise notice 'Removidos % usuários de demonstração e todos os dados deles.', cardinality(demo);
end $$;
