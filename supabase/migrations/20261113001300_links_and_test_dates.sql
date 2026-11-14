-- =====================================================================
-- Rotina · Links das ferramentas e datas dos testes
--
-- 1. useful_links: cards com nome, link e descrição das ferramentas usadas
--    nas atividades. Todos os usuários ativos leem; só o gestor cria,
--    edita e remove (garantido por RLS).
-- 2. Testes do mensal: cada referência enviada para aprovação passa a ter
--    o motivo do teste, a data de início e a data final prevista. Esses
--    dados alimentam o menu "Testes" do analista.
-- =====================================================================

create table public.useful_links (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(btrim(name)) > 0),
  url          text not null check (url ~* '^https?://[^\s]+$'),
  description  text,
  sort_order   int  not null default 0,
  created_by   uuid references public.profiles (id) default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.useful_links enable row level security;
create policy links_select on public.useful_links for select to authenticated using (public.is_active_user());
create policy links_write  on public.useful_links for all    to authenticated
  using (public.is_admin()) with check (public.is_admin());
revoke all on public.useful_links from anon;

create trigger links_touch before update on public.useful_links
  for each row execute function public.touch_updated_at();
create trigger a_audit after insert or update or delete on public.useful_links
  for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------
-- Testes do mensal: referência, motivo, início e fim previsto
-- ---------------------------------------------------------------------
update public.activity_templates set
  fields = $j$[
    {"key":"testes","label":"Testes por referência","type":"group","item_label":"Referência","min_items":2,"reviewable":true,
     "help":"Informe as 2 referências, o motivo de cada teste e o período. O gestor aprova ou reprova cada referência de forma independente.",
     "fields":[
       {"key":"sku","label":"Referência testada","type":"text","mono":true,"required":true},
       {"key":"sugestao","label":"Motivo do teste","type":"textarea","required":true,
        "help":"O que será testado e por quê. Por exemplo: trocar o kit de fotos para ver se melhora a taxa de conversão."},
       {"key":"inicio","label":"Início do teste","type":"date","required":true},
       {"key":"fim_previsto","label":"Data final prevista","type":"date","required":true}
     ]}
  ]$j$::jsonb
where code = 'M3';

-- Tarefas de testes ainda não enviadas passam a pedir as datas.
select set_config('app.audit_action', 'ressincronizacao', true);
update public.task_instances ti
   set template_snapshot = to_jsonb(t) - 'created_at' - 'updated_at'
  from public.activity_templates t
 where ti.template_id = t.id and t.code = 'M3'
   and ti.status not in ('concluida_prazo', 'concluida_atraso');
select set_config('app.audit_action', '', true);
