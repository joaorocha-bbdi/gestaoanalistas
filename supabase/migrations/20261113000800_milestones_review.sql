-- =====================================================================
-- Rotina · marcos semanal e mensal, prazo só por data, aprovação de testes
--
-- 1. Sem horários: o prazo vale até o fim do dia de vencimento.
-- 2. A sequência passa a valer para qualquer frequência (diário, semanal,
--    mensal): marcos do mesmo período só liberam em ordem.
-- 3. Mensal: abre no dia 1 e fecha no último dia do mês.
-- 4. Aprovação por item: cada referência de um grupo "revisável" (ex.: testes
--    do mensal) é aprovada ou reprovada de forma independente pelo admin master;
--    o analista vê o retorno e pode reenviar a referência reprovada.
-- 5. Modelos semanal e mensal reescritos; sobras de carga de exemplo removidas.
--
-- Rodar UMA vez, depois da 20261113000700.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Prazo por data: o dia de vencimento vai até 23:59:59 (horário local)
-- ---------------------------------------------------------------------
alter table public.activity_templates alter column cutoff_time set default '23:59:59';
update public.activity_templates set cutoff_time = '23:59:59';

select set_config('app.audit_action', 'ressincronizacao', true);
update public.task_instances ti
   set due_at = public.local_due(ti.ref_date, '23:59:59')
 where ti.status in ('pendente', 'em_andamento', 'nao_feita', 'bloqueada_gate');
-- Tarefa marcada como "não feita" só por causa do horário antigo volta a ficar aberta.
update public.task_instances ti set status = 'pendente'
 where ti.status = 'nao_feita' and ti.due_at > now()
   and ti.started_at is null and ti.submitted_at is null
   and not exists (select 1 from public.task_steps s where s.task_id = ti.id);
select set_config('app.audit_action', '', true);

-- ---------------------------------------------------------------------
-- 2. Sequência para qualquer frequência (mesmo período, mesma frequência)
-- ---------------------------------------------------------------------
create or replace function public.task_lock_reason(p_task uuid)
returns text language sql stable security definer set search_path = public as $$
  select b.template_snapshot ->> 'name'
    from task_instances t
    join task_instances b on b.user_id = t.user_id and b.period_key = t.period_key and b.id <> t.id
   where t.id = p_task
     and coalesce((t.template_snapshot ->> 'sequential')::boolean, false)
     and coalesce((b.template_snapshot ->> 'sequential')::boolean, false)
     and t.template_snapshot ->> 'frequency' = b.template_snapshot ->> 'frequency'
     and coalesce((b.template_snapshot ->> 'sort_order')::int, 0) < coalesce((t.template_snapshot ->> 'sort_order')::int, 0)
     and b.status not in ('concluida_prazo', 'concluida_atraso', 'pausada')
   order by coalesce((b.template_snapshot ->> 'sort_order')::int, 0)
   limit 1;
$$;
revoke execute on function public.task_lock_reason(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Mensal: vence no último dia do mês (calendário)
-- ---------------------------------------------------------------------
create or replace function public.monthly_due(m date)
returns date language sql stable as $$
  select (date_trunc('month', m) + interval '1 month - 1 day')::date;
$$;

-- ---------------------------------------------------------------------
-- 4. Aprovação por item
-- ---------------------------------------------------------------------
create table public.task_item_reviews (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.task_instances (id) on delete cascade,
  group_key    text not null,
  item_index   int  not null check (item_index >= 0),
  status       text not null check (status in ('aprovada', 'reprovada', 'reenviada')),
  reason       text,
  reviewer_id  uuid not null references public.profiles (id),   -- quem decidiu (ou reenviou)
  created_at   timestamptz not null default clock_timestamp(),
  check (status <> 'reprovada' or coalesce(length(btrim(reason)), 0) > 0)
);
create index task_item_reviews_task on public.task_item_reviews (task_id, group_key, item_index, created_at desc);

alter table public.task_item_reviews enable row level security;
create policy item_reviews_select on public.task_item_reviews for select to authenticated
  using (public.is_admin() or exists (
    select 1 from public.task_instances t where t.id = task_id and t.user_id = auth.uid()));
revoke all on public.task_item_reviews from anon;
revoke insert, update, delete on public.task_item_reviews from authenticated;

create trigger a_audit after insert on public.task_item_reviews
  for each row execute function public.audit_trigger();

-- Situação atual de um item: 'pendente' (sem decisão ou reenviado), 'aprovada' ou 'reprovada'.
create or replace function public.item_review_state(p_task uuid, p_group text, p_index int)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((
    select case r.status when 'reenviada' then 'pendente' else r.status end
      from task_item_reviews r
     where r.task_id = p_task and r.group_key = p_group and r.item_index = p_index
     order by r.created_at desc, r.id desc limit 1), 'pendente');
$$;
revoke execute on function public.item_review_state(uuid, text, int) from public, anon, authenticated;

-- Admin: aprova ou reprova UMA referência (reprovação exige o motivo).
create or replace function public.review_item(p_task uuid, p_group text, p_index int, p_status text, p_reason text default null)
returns public.task_item_reviews language plpgsql security definer set search_path = public as $$
declare t task_instances; fdef jsonb; n int; r task_item_reviews;
begin
  if not is_admin() then raise exception 'Apenas admin pode avaliar.' using errcode = '42501'; end if;
  if p_status not in ('aprovada', 'reprovada') then
    raise exception 'Escolha aprovar ou reprovar.' using errcode = '22023';
  end if;
  if p_status = 'reprovada' and coalesce(btrim(p_reason), '') = '' then
    raise exception 'Informe o motivo da reprovação, para o analista saber o que ajustar.' using errcode = '22023';
  end if;

  select * into t from task_instances where id = p_task for update;
  if not found then raise exception 'Atividade não encontrada.' using errcode = 'P0002'; end if;
  if t.status not in ('concluida_prazo', 'concluida_atraso') then
    raise exception 'O analista ainda não enviou esta atividade.' using errcode = '22023';
  end if;

  select f into fdef from jsonb_array_elements(coalesce(t.template_snapshot -> 'fields', '[]'::jsonb)) f
   where f ->> 'key' = p_group and coalesce((f ->> 'reviewable')::boolean, false) limit 1;
  if fdef is null then raise exception 'Este campo não passa por aprovação.' using errcode = '22023'; end if;

  n := coalesce(jsonb_array_length(t.payload -> p_group), 0);
  if p_index < 0 or p_index >= n then raise exception 'Referência inexistente.' using errcode = '22023'; end if;
  if item_review_state(p_task, p_group, p_index) <> 'pendente' then
    raise exception 'Esta referência já foi avaliada.' using errcode = '22023';
  end if;

  perform set_config('app.audit_action', case p_status when 'aprovada' then 'item_aprovado' else 'item_reprovado' end, true);
  insert into task_item_reviews (task_id, group_key, item_index, status, reason, reviewer_id)
  values (p_task, p_group, p_index, p_status, nullif(btrim(p_reason), ''), auth.uid())
  returning * into r;
  perform set_config('app.audit_action', '', true);
  return r;
end $$;

-- Analista: corrige e reenvia uma referência que foi reprovada.
create or replace function public.resubmit_item(p_task uuid, p_group text, p_index int, p_item jsonb)
returns public.task_instances language plpgsql security definer set search_path = public as $$
declare t task_instances; fdef jsonb; missing text[];
begin
  t := load_own_task(p_task);
  select f into fdef from jsonb_array_elements(coalesce(t.template_snapshot -> 'fields', '[]'::jsonb)) f
   where f ->> 'key' = p_group and coalesce((f ->> 'reviewable')::boolean, false) limit 1;
  if fdef is null then raise exception 'Este campo não passa por aprovação.' using errcode = '22023'; end if;
  if p_index < 0 or p_index >= coalesce(jsonb_array_length(t.payload -> p_group), 0) then
    raise exception 'Referência inexistente.' using errcode = '22023';
  end if;
  if item_review_state(p_task, p_group, p_index) <> 'reprovada' then
    raise exception 'Só dá para reenviar uma referência reprovada.' using errcode = '22023';
  end if;
  missing := missing_fields(fdef -> 'fields', p_item, coalesce(fdef ->> 'item_label', fdef ->> 'label') || ' · ');
  if coalesce(array_length(missing, 1), 0) > 0 then
    raise exception 'Preencha os campos obrigatórios: %', array_to_string(missing, '; ') using errcode = '22023';
  end if;

  perform set_config('app.audit_action', 'item_reenviado', true);
  insert into task_item_reviews (task_id, group_key, item_index, status, reviewer_id)
  values (p_task, p_group, p_index, 'reenviada', auth.uid());
  update task_instances
     set payload = jsonb_set(payload, array[p_group, p_index::text], p_item, false),
         submitted_at = now()
   where id = p_task
  returning * into t;
  perform set_config('app.audit_action', '', true);
  return t;
end $$;

revoke execute on function public.review_item(uuid, text, int, text, text), public.resubmit_item(uuid, text, int, jsonb)
  from public, anon, authenticated;
grant execute on function public.review_item(uuid, text, int, text, text), public.resubmit_item(uuid, text, int, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------
-- 5. Modelos semanal e mensal
-- ---------------------------------------------------------------------
update public.activity_templates set
  name = 'Acompanhamento do pedido de compras',
  description = 'Ficar a par do pedido de compras (andamento, se já foi cotado e se já foi feito) e cuidar, no hub, do volume de pedido necessário.',
  instructions = $j$[
    "Abrir o hub, na aba de importações: https://ceo61.github.io/bb-hub/?#importacoes",
    "Conferir, no hub, o volume de pedido necessário.",
    "Acompanhar o pedido de compras: qual é o andamento, se já foi cotado e se já foi feito."
  ]$j$::jsonb,
  sequential = true, sort_order = 60,
  fields = $j$[
    {"key":"status_pedido","label":"Andamento do pedido","type":"select","options_setting":"status_pedido_opcoes","required":true},
    {"key":"volume","label":"Volume de pedido necessário","type":"number","required":true},
    {"key":"observacoes","label":"Observações","type":"textarea"}
  ]$j$::jsonb
where code = 'S1';

update public.activity_templates set
  name = 'Acompanhamento da importação',
  description = 'Ficar totalmente por dentro da importação: qual é o estágio atual e quando está prevista a chegada da carga.',
  instructions = $j$[
    "Acompanhar a importação de ponta a ponta, ficando totalmente por dentro dela.",
    "Levantar o estágio atual da importação.",
    "Confirmar a previsão de chegada da carga."
  ]$j$::jsonb,
  sequential = true, sort_order = 70,
  fields = $j$[
    {"key":"estagio","label":"Estágio da importação","type":"text","required":true},
    {"key":"chegada","label":"Previsão de chegada","type":"date","required":true},
    {"key":"observacoes","label":"Observações","type":"textarea"}
  ]$j$::jsonb
where code = 'M1';

update public.activity_templates set
  name = 'Pesquisa de mercado da categoria',
  description = 'Entender como anda a categoria e se estamos operando com um ticket maior, menor ou igual ao do mercado.',
  instructions = $j$[
    "Escolher a categoria.",
    "Fazer a pesquisa de mercado, levantando os preços praticados.",
    "Concluir se estamos operando com um ticket maior, menor ou igual ao do mercado."
  ]$j$::jsonb,
  sequential = true, sort_order = 80,
  fields = $j$[
    {"key":"categoria","label":"Categoria","type":"text","required":true},
    {"key":"ticket","label":"Nosso ticket em relação ao mercado","type":"select","required":true,"options":["Maior","Menor","Igual"]},
    {"key":"evidencias","label":"Evidências e links","type":"list","required":true,"help":"Um link ou evidência por linha."},
    {"key":"observacoes","label":"Observações","type":"textarea"}
  ]$j$::jsonb
where code = 'M2';

update public.activity_templates set
  name = 'Testes de estratégia por categoria',
  description = 'Executar 2 testes de acordo com a estratégia definida para a categoria (por exemplo, mudar o kit de fotos de 2 produtos de teclado para ver se melhora a taxa de conversão). A sugestão de cada teste passa pela aprovação do admin master.',
  instructions = $j$[
    "Consultar a estratégia definida para a categoria.",
    "Escolher as 2 referências que serão testadas.",
    "Escrever a sugestão de teste de cada referência e enviar para a aprovação do admin master."
  ]$j$::jsonb,
  sequential = true, sort_order = 90, target_qty = 2, target_label = 'testes',
  followup_fields = '[]'::jsonb,
  fields = $j$[
    {"key":"testes","label":"Testes por referência","type":"group","item_label":"Referência","min_items":2,"reviewable":true,
     "help":"Informe as 2 referências e a sugestão de teste de cada uma. O admin master aprova ou reprova cada referência de forma independente.",
     "fields":[
       {"key":"sku","label":"Referência testada (SKU)","type":"text","mono":true,"required":true},
       {"key":"sugestao","label":"Sugestão de teste","type":"textarea","required":true,
        "help":"Por exemplo: trocar o kit de fotos para ver se melhora a taxa de conversão."}
     ]}
  ]$j$::jsonb
where code = 'M3';

-- Lista de estágios de importação era uma sugestão minha, não um pedido: removida.
delete from public.settings where key = 'status_importacao_opcoes';
-- Feriados também eram só um exemplo: o admin cadastra os da empresa em Parâmetros.
delete from public.holidays where (day, label) in (
  ('2026-11-02', 'Finados'), ('2026-11-20', 'Dia da Consciência Negra'), ('2026-12-25', 'Natal'),
  ('2027-01-01', 'Confraternização Universal'), ('2027-02-15', 'Carnaval'), ('2027-02-16', 'Carnaval'),
  ('2027-03-26', 'Sexta-feira Santa'), ('2027-04-21', 'Tiradentes'), ('2027-05-01', 'Dia do Trabalho'));

-- Tarefas ainda intocadas passam a usar os modelos novos.
select set_config('app.audit_action', 'ressincronizacao', true);
update public.task_instances ti
   set template_snapshot = to_jsonb(t) - 'created_at' - 'updated_at',
       due_at = public.local_due(ti.ref_date, '23:59:59'),
       weight = t.weight
  from public.activity_templates t
 where ti.template_id = t.id
   and ti.ref_date >= public.local_today()
   and ti.status in ('pendente', 'nao_feita')
   and ti.started_at is null and ti.submitted_at is null and ti.payload = '{}'::jsonb
   and not exists (select 1 from public.task_submissions s where s.task_id = ti.id);
select set_config('app.audit_action', '', true);
