-- =====================================================================
-- Rotina · "admin master" passa a se chamar "gestor" em todos os textos
-- (modelos de atividade, tarefas e mensagens de erro do banco).
-- O valor interno do papel continua 'admin' (tipo user_role), exibido como "Gestor".
-- =====================================================================

create or replace function pg_temp.gestor(t text) returns text language sql immutable as $$
  select replace(replace(replace(replace(replace(replace(t,
    'o gestor e para o admin master', 'o gestor'),
    'Apenas admin master', 'Apenas o gestor'),
    'Apenas admin', 'Apenas o gestor'),
    'outra pessoa a admin', 'outra pessoa a gestor'),
    'O admin master', 'O gestor'),
    'admin master', 'gestor');
$$;

-- Modelos de atividade
update public.activity_templates set
  description     = pg_temp.gestor(description),
  instructions    = pg_temp.gestor(instructions::text)::jsonb,
  fields          = pg_temp.gestor(fields::text)::jsonb,
  followup_fields = pg_temp.gestor(followup_fields::text)::jsonb
where coalesce(description, '') ~* 'admin' or instructions::text ~* 'admin' or fields::text ~* 'admin';

-- Cópia do modelo guardada em cada tarefa (só o texto muda)
select set_config('app.audit_action', 'ressincronizacao', true);
update public.task_instances
   set template_snapshot = pg_temp.gestor(template_snapshot::text)::jsonb
 where template_snapshot::text ~* 'admin master';
select set_config('app.audit_action', '', true);

-- Mensagens das funções do banco
do $$
declare r record; def text;
begin
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and pg_get_functiondef(p.oid) ~ '(admin master|Apenas admin|outra pessoa a admin)'
  loop
    def := pg_temp.gestor(pg_get_functiondef(r.oid));
    execute def;
  end loop;
end $$;

comment on type public.user_role is 'Papel do usuário: analista ou admin (exibido como "Gestor").';
comment on column public.profiles.role is 'Papel: analista ou admin (Gestor). Pode ser editado aqui ou no painel; o login acompanha.';
