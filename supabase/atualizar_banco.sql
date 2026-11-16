-- Gerado por scripts/bundle-update.mjs. Rode UMA vez no SQL Editor, num banco criado com o setup.sql antigo.
-- Tudo numa transação: se algo falhar, nada muda.
begin;

-- >>> 20261113000700_steps_sequence.sql
-- =====================================================================
-- Rotina · etapas progressivas e blocos em sequência
--
-- 1. Cada atividade tem etapas (as "instruções" do modelo). O analista marca
--    uma a uma, em ordem; cada marcação grava data, horário e usuário.
-- 2. Blocos "sequenciais" do mesmo dia só liberam depois que o anterior
--    estiver concluído (mesmo que atrasado). Garantido aqui, não na tela.
-- 3. O envio exige todas as etapas marcadas.
-- 4. Progresso (%) = (etapas marcadas + 1 se concluída) ÷ (etapas + 1):
--    só chega a 100% quando o bloco é enviado e aceito.
-- 5. Conteúdo dos modelos revisado (textos, etapas, campos, ordem e prazos).
--
-- Rodar UMA vez, depois das migrations anteriores.
-- =====================================================================

alter table public.activity_templates
  add column if not exists sequential boolean not null default false;

-- ---------------------------------------------------------------------
-- Etapas marcadas
-- ---------------------------------------------------------------------
create table public.task_steps (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.task_instances (id) on delete cascade,
  step_index  int  not null check (step_index >= 0),
  checked_at  timestamptz not null default now(),
  checked_by  uuid not null references public.profiles (id),
  unique (task_id, step_index)
);
create index task_steps_task on public.task_steps (task_id);

alter table public.task_steps enable row level security;

create policy task_steps_select on public.task_steps for select to authenticated
  using (public.is_admin() or exists (
    select 1 from public.task_instances t where t.id = task_id and t.user_id = auth.uid()));

revoke all on public.task_steps from anon;
revoke insert, update, delete on public.task_steps from authenticated;

create trigger a_audit after insert or delete on public.task_steps
  for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------
-- Bloqueio por sequência: devolve o nome do bloco que ainda precisa ser
-- concluído antes deste, ou null se está liberado.
-- ---------------------------------------------------------------------
create or replace function public.task_lock_reason(p_task uuid)
returns text language sql stable security definer set search_path = public as $$
  select b.template_snapshot ->> 'name'
    from task_instances t
    join task_instances b on b.user_id = t.user_id and b.ref_date = t.ref_date and b.id <> t.id
   where t.id = p_task
     and coalesce((t.template_snapshot ->> 'sequential')::boolean, false)
     and coalesce((b.template_snapshot ->> 'sequential')::boolean, false)
     and t.template_snapshot ->> 'frequency' = 'diaria'
     and b.template_snapshot ->> 'frequency' = 'diaria'
     and coalesce((b.template_snapshot ->> 'sort_order')::int, 0) < coalesce((t.template_snapshot ->> 'sort_order')::int, 0)
     and b.status not in ('concluida_prazo', 'concluida_atraso', 'pausada')
   order by coalesce((b.template_snapshot ->> 'sort_order')::int, 0)
   limit 1;
$$;

-- ---------------------------------------------------------------------
-- Marcar ou desmarcar etapa. Regras:
--  · bloco liberado e não concluído;
--  · marcar só a próxima, na ordem; desmarcar só a última marcada.
-- ---------------------------------------------------------------------
create or replace function public.set_step(p_task uuid, p_index int, p_checked boolean)
returns public.task_instances language plpgsql security definer set search_path = public as $$
declare t task_instances; v_total int; v_done int; v_lock text;
begin
  t := load_own_task(p_task);
  v_lock := task_lock_reason(t.id);
  if v_lock is not null then
    raise exception 'Conclua “%” antes de iniciar este bloco.', v_lock using errcode = '22023';
  end if;
  if t.status in ('concluida_prazo', 'concluida_atraso') then
    raise exception 'Atividade já concluída: as etapas não podem mais ser alteradas.' using errcode = '22023';
  end if;

  v_total := jsonb_array_length(coalesce(t.template_snapshot -> 'instructions', '[]'::jsonb));
  if p_index < 0 or p_index >= v_total then
    raise exception 'Etapa inexistente.' using errcode = '22023';
  end if;
  select count(*) into v_done from task_steps where task_id = t.id;

  if p_checked then
    if p_index <> v_done then
      raise exception 'Siga a ordem: marque primeiro a etapa %.', v_done + 1 using errcode = '22023';
    end if;
    perform set_config('app.audit_action', 'etapa_marcada', true);
    insert into task_steps (task_id, step_index, checked_by) values (t.id, p_index, auth.uid());
  else
    if p_index <> v_done - 1 then
      raise exception 'Só é possível desmarcar a última etapa marcada.' using errcode = '22023';
    end if;
    perform set_config('app.audit_action', 'etapa_desmarcada', true);
    delete from task_steps where task_id = t.id and step_index = p_index;
  end if;

  perform set_config('app.audit_action', 'etapa', true);
  update task_instances
     set status = case when status in ('pendente', 'nao_feita') then 'em_andamento'::task_status else status end,
         started_at = coalesce(started_at, now())
   where id = t.id
  returning * into t;
  perform set_config('app.audit_action', '', true);
  return t;
end $$;

-- ---------------------------------------------------------------------
-- save_draft e submit_task: respeitam sequência e etapas
-- ---------------------------------------------------------------------
create or replace function public.save_draft(p_task uuid, p_payload jsonb, p_gates jsonb default '{}', p_deviation jsonb default null)
returns public.task_instances language plpgsql security definer set search_path = public as $$
declare t task_instances; v_lock text;
begin
  t := load_own_task(p_task);
  v_lock := task_lock_reason(t.id);
  if v_lock is not null then
    raise exception 'Conclua “%” antes de iniciar este bloco.', v_lock using errcode = '22023';
  end if;
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

create or replace function public.submit_task(p_task uuid, p_payload jsonb, p_gates jsonb default '{}', p_deviation jsonb default null)
returns public.task_instances language plpgsql security definer set search_path = public as $$
declare
  t task_instances; g jsonb; ans text; passed boolean := true;
  missing text[]; sub_id uuid; new_status task_status; v_now timestamptz := now();
  v_lock text; v_total int; v_done int;
begin
  t := load_own_task(p_task);

  v_lock := task_lock_reason(t.id);
  if v_lock is not null then
    raise exception 'Conclua “%” antes de enviar este bloco.', v_lock using errcode = '22023';
  end if;
  if t.status in ('concluida_prazo', 'concluida_atraso') and not t.needs_rework then
    raise exception 'Atividade já concluída. Só pode ser reenviada se for contestada na revisão.' using errcode = '22023';
  end if;

  -- Etapas: todas marcadas (reenvio após contestação já passou por elas).
  if not t.needs_rework then
    v_total := jsonb_array_length(coalesce(t.template_snapshot -> 'instructions', '[]'::jsonb));
    select count(*) into v_done from task_steps where task_id = t.id;
    if v_done < v_total then
      raise exception 'Marque todas as etapas antes de enviar (% de % marcadas).', v_done, v_total using errcode = '22023';
    end if;
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

-- Permissões das funções novas (as antigas já estão corretas)
revoke execute on function public.task_lock_reason(uuid), public.set_step(uuid, int, boolean)
  from public, anon, authenticated;
grant execute on function public.set_step(uuid, int, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- View de fatos: + progresso por etapas e ordem na sequência
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
  abs(hashtext(t.id::text)) % 100                                                      as sample_bucket,
  jsonb_array_length(coalesce(t.template_snapshot -> 'instructions', '[]'::jsonb))::int as steps_total,
  (select count(*) from task_steps s where s.task_id = t.id)::int                      as steps_done,
  coalesce((t.template_snapshot ->> 'sort_order')::int, 0)                             as sort_order,
  coalesce((t.template_snapshot ->> 'sequential')::boolean, false)                     as sequential
from task_instances t
join profiles p on p.id = t.user_id;

grant select on public.v_task_facts to authenticated;

-- ---------------------------------------------------------------------
-- Rotação de curvas: seg A, ter B, qua C, qui e sex D
-- ---------------------------------------------------------------------
update public.settings
   set value = '{"1":"A","2":"B","3":"C","4":"D","5":"D"}'
 where key = 'curva_por_dia';

-- ---------------------------------------------------------------------
-- Modelos: textos revisados, etapas, campos, ordem e prazos
-- Sequência do dia: D1 → D2 → D3 → D5 (D4 segue pausada, fora da sequência).
-- ---------------------------------------------------------------------
update public.activity_templates set
  name = 'Descontos Black Friday',
  description = 'Conferir o que muda hoje na campanha e marcar os produtos que vamos bater de frente com a {concorrente}.',
  instructions = $j$[
    "Entrar no hub e clicar no botão “O que vai mudar hoje”.",
    "Conferir se todos os produtos estão corretos, seguindo as regras de precificação.",
    "Verificar, no portfólio da Black Friday, o que vamos bater de frente com a {concorrente} e marcar esses produtos."
  ]$j$::jsonb,
  cutoff_time = '10:00', sequential = true, sort_order = 10,
  fields = $j$[
    {"key":"colidem","label":"Produtos que batem de frente com a {concorrente}","type":"number","required":true},
    {"key":"nao_colidem","label":"Produtos que não batem de frente","type":"number","required":true},
    {"key":"skus_colidem","label":"Produtos marcados (SKUs)","type":"list","mono":true,"help":"Um SKU por linha. Deixe em branco se nenhum produto bater de frente."},
    {"key":"observacoes","label":"Observações","type":"textarea"}
  ]$j$::jsonb
where code = 'D1';

update public.activity_templates set
  name = 'Precificação diária',
  description = 'Precificar a curva do dia, conforme o dia da semana: segunda, curva A; terça, curva B; quarta, curva C; quinta e sexta, curva D.',
  instructions = $j$[
    "Abrir a curva do dia indicada no card.",
    "Precificar os produtos da curva, considerando tudo o que foi alinhado nas reuniões.",
    "Verificar o mapeamento da {concorrente} em cada produto precificado.",
    "Se o produto precificado não tiver o link para coleta de preço, coletar o link e cadastrá-lo, para acompanharmos melhor os preços da concorrente.",
    "Responder às verificações de venda e de folga e, se alguma estiver fora do esperado, listar os SKUs em desvio e a ação tomada."
  ]$j$::jsonb,
  cutoff_time = '12:00', sequential = true, sort_order = 20,
  fields = $j$[
    {"key":"curva","label":"Curva trabalhada","type":"select","options_setting":"curvas","default_from":"curva_do_dia","required":true},
    {"key":"qtd_precificados","label":"Produtos precificados","type":"number","required":true},
    {"key":"skus_link","label":"SKUs que precisaram de link da {concorrente}","type":"list","mono":true,"help":"Um SKU por linha. A quantidade é contada automaticamente."},
    {"key":"diretrizes","label":"Diretrizes de reunião aplicadas","type":"textarea","required":true}
  ]$j$::jsonb
where code = 'D2';

update public.activity_templates set
  name = 'Check em produtos com giro',
  description = 'Revisar 2 produtos com giro, por ordem de views, para entender como cada um converte. A análise vai direto para o gestor e para o admin master.',
  instructions = $j$[
    "Escolher 2 produtos que têm giro, por ordem de views.",
    "Ver como anda a taxa de conversão de cada um.",
    "Verificar se o kit de fotos precisa ser renovado e se a descrição precisa de alguma alteração.",
    "Verificar se as compatibilidades fazem sentido e estão corretas para cada produto.",
    "Verificar quais compatibilidades mais convertem e entender os dois produtos como um todo."
  ]$j$::jsonb,
  cutoff_time = '16:00', sequential = true, sort_order = 30, target_qty = 2, target_label = 'produtos',
  fields = $j$[
    {"key":"produtos","label":"Referências checadas no dia","type":"group","item_label":"Produto","min_items":2,
     "help":"Informe as 2 referências que você checou hoje. A análise de cada uma vai direto para o gestor e para o admin master.",
     "fields":[
       {"key":"sku","label":"Referência analisada (SKU)","type":"text","mono":true,"required":true},
       {"key":"conversao","label":"Taxa de conversão atual","type":"text","required":true},
       {"key":"renovar_fotos","label":"O kit de fotos precisa ser renovado?","type":"boolean","required":true},
       {"key":"alterar_descricao","label":"A descrição precisa de alguma alteração?","type":"boolean","required":true},
       {"key":"compat_ok","label":"As compatibilidades fazem sentido e estão corretas?","type":"boolean","required":true},
       {"key":"pontos_melhoria","label":"Pontos que precisam de melhoria","type":"textarea","required":true},
       {"key":"analise","label":"Análise do produto","type":"textarea","required":true,
        "help":"O que você encontrou, quais compatibilidades mais convertem e o que entendeu sobre o produto."}
     ]}
  ]$j$::jsonb
where code = 'D3';

update public.activity_templates set
  name = '5 produtos entupidos',
  description = 'Estoque parado: diagnosticar por que o produto não vende e traçar uma estratégia.',
  instructions = $j$[
    "Selecionar 5 produtos com estoque parado.",
    "Para cada um, registrar o diagnóstico e a estratégia."
  ]$j$::jsonb,
  sequential = false, sort_order = 35
where code = 'D4';

update public.activity_templates set
  name = 'Acompanhamento da concorrência',
  description = 'Verificar, na aba do hub, como a concorrência tem se comportado e identificar oportunidades de mercado.',
  instructions = $j$[
    "Abrir a aba de concorrência no hub.",
    "Verificar como a concorrência tem se comportado: se, dentro da sua categoria, o preço abaixou ou aumentou.",
    "Identificar oportunidades de mercado, visando à ação."
  ]$j$::jsonb,
  cutoff_time = '17:00', sequential = true, sort_order = 40,
  fields = $j$[
    {"key":"categoria","label":"Categoria analisada","type":"text","required":true},
    {"key":"movimento","label":"Movimento observado","type":"select","required":true,"options":["Abaixou","Manteve","Aumentou"]},
    {"key":"oportunidade","label":"Oportunidade identificada","type":"textarea","required":true},
    {"key":"acao","label":"Ação proposta","type":"textarea","required":true},
    {"key":"alteracoes","label":"Alterações feitas em referências (opcional)","type":"group","item_label":"Alteração","min_items":0,
     "help":"Se você alterou alguma referência, sinalize o que foi feito e por que foi mudado. Este campo é opcional.",
     "fields":[
       {"key":"sku","label":"Referência alterada (SKU)","type":"text","mono":true,"required":true},
       {"key":"feito","label":"O que foi feito","type":"textarea","required":true},
       {"key":"motivo","label":"Por que foi alterado","type":"textarea","required":true}
     ]}
  ]$j$::jsonb
where code = 'D5';

update public.activity_templates set
  description = 'Saber qual é o volume de pedido necessário e em que etapa está o pedido.',
  instructions = $j$[
    "Abrir o hub, na aba de importações: https://ceo61.github.io/bb-hub/?#importacoes",
    "Conferir o volume de pedido necessário.",
    "Confirmar se o pedido já foi feito, se está em cotação ou se ainda não foi iniciado."
  ]$j$::jsonb
where code = 'S1';

update public.activity_templates set
  description = 'Estar totalmente por dentro da importação, inclusive da data de chegada da carga.',
  instructions = $j$[
    "Acompanhar a importação de ponta a ponta e levantar o status atual.",
    "Confirmar a data prevista de chegada da carga."
  ]$j$::jsonb
where code = 'M1';

update public.activity_templates set
  description = 'Comparar o nosso ticket com o do mercado na categoria.',
  instructions = $j$[
    "Escolher a categoria.",
    "Levantar os preços praticados pelo mercado.",
    "Concluir se o nosso ticket está acima, abaixo ou igual ao do mercado."
  ]$j$::jsonb
where code = 'M2';

update public.activity_templates set
  description = 'Executar dois testes de estratégia no mês. Depois de concluir, registre a leitura do resultado em “Registrar leitura”.',
  instructions = $j$[
    "Definir a hipótese de cada teste.",
    "Aplicar a alteração (por exemplo, trocar o kit de fotos de 2 produtos de teclado).",
    "Registrar a métrica de antes e a data prevista de leitura."
  ]$j$::jsonb
where code = 'M3';

-- Tarefas de hoje em diante ainda intocadas passam a usar o modelo novo
-- (as já iniciadas ou concluídas mantêm a versão com que foram feitas).
select set_config('app.audit_action', 'ressincronizacao', true);
update public.task_instances ti
   set template_snapshot = to_jsonb(t) - 'created_at' - 'updated_at',
       due_at = public.local_due(ti.ref_date, t.cutoff_time),
       weight = t.weight,
       curve  = case when t.shows_curve then public.curve_for(ti.ref_date) end
  from public.activity_templates t
 where ti.template_id = t.id
   and ti.ref_date >= public.local_today()
   and ti.status in ('pendente', 'nao_feita')
   and ti.started_at is null and ti.submitted_at is null and ti.payload = '{}'::jsonb
   and not exists (select 1 from public.task_submissions s where s.task_id = ti.id);
select set_config('app.audit_action', '', true);


-- >>> 20261113000800_milestones_review.sql
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


-- >>> 20261113000900_only_requested_blocks.sql
-- =====================================================================
-- Rotina · só os blocos pedidos
-- Remove o modelo "5 produtos entupidos" (D4), que estava pausado e fora da
-- sequência. Ficam: diário (D1, D2, D3, D5), semanal (S1) e mensal (M1, M2, M3).
-- Só apaga se o modelo nunca gerou tarefa (preserva histórico, se houver).
-- =====================================================================
delete from public.template_assignments
 where template_id in (select id from public.activity_templates where code = 'D4');

delete from public.activity_templates t
 where t.code = 'D4'
   and not exists (select 1 from public.task_instances ti where ti.template_id = t.id);


-- >>> 20261113001000_user_admin_in_db.sql
-- =====================================================================
-- Rotina · usuários e papéis geridos direto no banco (sem Edge Function)
--
-- O papel de cada pessoa é a coluna public.profiles.role (tipo user_role:
-- 'analista' ou 'admin'). Pode ser alterado:
--   · no painel do admin master (Usuários e acessos), ou
--   · direto no banco (Table Editor > profiles > role / active).
-- Nos dois casos, o login (auth.users) acompanha automaticamente:
--   · role   → app_metadata.role
--   · active → bloqueia ou libera o login (banned_until), sem apagar histórico.
-- O admin master também cria logins e define senhas pelo painel.
-- Proteção: o último admin master ativo não pode ser rebaixado nem desativado.
-- =====================================================================

comment on type public.user_role is 'Papel do usuário: analista ou admin (admin master).';
comment on column public.profiles.role is 'Papel: analista ou admin. Pode ser editado aqui ou no painel; o login acompanha.';
comment on column public.profiles.active is 'false bloqueia o login sem apagar o histórico.';

-- ---------------------------------------------------------------------
-- Nunca ficar sem admin master
-- ---------------------------------------------------------------------
create or replace function public.guard_last_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and old.active and (new.role <> 'admin' or not new.active) then
    if not exists (select 1 from profiles where id <> old.id and role = 'admin' and active) then
      raise exception 'Este é o último admin master ativo. Promova outra pessoa a admin antes de rebaixar ou desativar esta.'
        using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

create trigger a_guard_last_admin before update of role, active on public.profiles
  for each row execute function public.guard_last_admin();

-- ---------------------------------------------------------------------
-- Papel e situação do perfil → login
-- ---------------------------------------------------------------------
create or replace function public.sync_profile_to_auth()
returns trigger language plpgsql security definer set search_path = public, auth as $$
begin
  if new.role is distinct from old.role or new.active is distinct from old.active then
    update auth.users
       set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', new.role::text),
           banned_until = case when new.active then null else now() + interval '100 years' end,
           updated_at = now()
     where id = new.id;
  end if;
  return null;
end $$;

create trigger z_sync_profile_to_auth after update of role, active on public.profiles
  for each row execute function public.sync_profile_to_auth();

-- ---------------------------------------------------------------------
-- Admin cria login (e-mail confirmado, senha inicial definida por ele)
-- ---------------------------------------------------------------------
create or replace function public.admin_create_user(p_email text, p_full_name text, p_role public.user_role, p_password text)
returns public.profiles language plpgsql security definer set search_path = public, extensions, auth as $$
declare v_id uuid := gen_random_uuid(); v_email text := lower(btrim(p_email)); p profiles;
begin
  if not is_admin() then raise exception 'Apenas admin master cria usuários.' using errcode = '42501'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.' using errcode = '22023'; end if;
  if coalesce(btrim(p_full_name), '') = '' then raise exception 'Informe o nome.' using errcode = '22023'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'A senha precisa de pelo menos 8 caracteres.' using errcode = '22023'; end if;
  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'Já existe um login com este e-mail.' using errcode = '22023';
  end if;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
          crypt(p_password, gen_salt('bf')), now(),
          jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'role', p_role::text),
          jsonb_build_object('full_name', btrim(p_full_name)), now(), now(), '', '', '', '');

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text,
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true), 'email', null, now(), now());

  -- O perfil nasce pelo gatilho on_auth_user_created; garante papel e nome.
  update profiles set role = p_role, full_name = btrim(p_full_name) where id = v_id returning * into p;
  perform generate_tasks(local_today(), week_end(local_today()));
  return p;
end $$;

-- ---------------------------------------------------------------------
-- Admin define uma nova senha para alguém (sem expor a senha na auditoria)
-- ---------------------------------------------------------------------
create or replace function public.admin_set_password(p_user uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions, auth as $$
begin
  if not is_admin() then raise exception 'Apenas admin master redefine senhas.' using errcode = '42501'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'A senha precisa de pelo menos 8 caracteres.' using errcode = '22023'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where id = p_user;
  if not found then raise exception 'Usuário não encontrado.' using errcode = 'P0002'; end if;
  insert into audit_log (actor_id, action, entity, entity_id) values (auth.uid(), 'senha_redefinida', 'profiles', p_user::text);
end $$;

revoke execute on function public.guard_last_admin(), public.sync_profile_to_auth(),
  public.admin_create_user(text, text, public.user_role, text), public.admin_set_password(uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_create_user(text, text, public.user_role, text), public.admin_set_password(uuid, text)
  to authenticated;


-- >>> 20261113001100_simplify_daily_blocks.sql
-- =====================================================================
-- Rotina · blocos diários mais enxutos
-- · Descontos Black Friday: sem os campos de produtos que batem de frente
--   com a BGT e de produtos marcados (fica só "Observações", opcional).
-- · Precificação diária: sem campos a preencher e sem verificações; o
--   bloco se conclui pelas etapas.
-- · Campos de referência e quantidade aceitam letras e números (texto).
-- Tarefas de hoje em diante ainda não concluídas passam a usar o modelo novo.
-- =====================================================================

update public.activity_templates set
  fields = $j$[
    {"key":"observacoes","label":"Observações","type":"textarea"}
  ]$j$::jsonb
where code = 'D1';

update public.activity_templates set
  instructions = $j$[
    "Abrir a curva do dia indicada no card.",
    "Precificar os produtos da curva, considerando tudo o que foi alinhado nas reuniões.",
    "Verificar o mapeamento da {concorrente} em cada produto precificado.",
    "Se o produto precificado não tiver o link para coleta de preço, coletar o link e cadastrá-lo, para acompanharmos melhor os preços da concorrente."
  ]$j$::jsonb,
  fields = '[]'::jsonb,
  gates  = '[]'::jsonb
where code = 'D2';

-- Volume do pedido como texto (aceita "500 un", "2 caixas" etc.)
update public.activity_templates set
  fields = $j$[
    {"key":"status_pedido","label":"Andamento do pedido","type":"select","options_setting":"status_pedido_opcoes","required":true},
    {"key":"volume","label":"Volume de pedido necessário","type":"text","required":true},
    {"key":"observacoes","label":"Observações","type":"textarea"}
  ]$j$::jsonb
where code = 'S1';

-- Reaplica o modelo nas tarefas abertas de hoje em diante (as concluídas mantêm a versão usada).
select set_config('app.audit_action', 'ressincronizacao', true);
update public.task_instances ti
   set template_snapshot = to_jsonb(t) - 'created_at' - 'updated_at',
       gate_draft = case when t.code = 'D2' then '{}'::jsonb else ti.gate_draft end,
       deviation  = case when t.code = 'D2' then null else ti.deviation end
  from public.activity_templates t
 where ti.template_id = t.id
   and t.code in ('D1', 'D2', 'S1')
   and ti.ref_date >= public.local_today()
   and ti.status not in ('concluida_prazo', 'concluida_atraso');

-- Etapas marcadas além do novo total (D2 passou de 5 para 4 etapas) saem.
delete from public.task_steps s
 using public.task_instances ti
 where s.task_id = ti.id
   and ti.ref_date >= public.local_today()
   and ti.status not in ('concluida_prazo', 'concluida_atraso')
   and s.step_index >= jsonb_array_length(coalesce(ti.template_snapshot -> 'instructions', '[]'::jsonb));
select set_config('app.audit_action', '', true);


-- >>> 20261113001200_gestor_wording.sql
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


-- >>> 20261113001300_links_and_test_dates.sql
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


-- >>> 20261113001400_test_requests.sql
-- =====================================================================
-- Rotina · solicitações de teste (bloco opcional do analista)
--
-- O analista pode, a qualquer momento e sem obrigação, pedir um teste para
-- uma referência: o que testar, por quê, início e data final prevista.
-- O gestor aprova ou reprova (reprovação exige justificativa). O analista
-- vê a decisão e pode corrigir e reenviar uma solicitação reprovada.
-- Escrita só pelas funções abaixo; leitura: o próprio analista ou o gestor.
-- =====================================================================

create table public.test_requests (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id),
  sku            text not null check (length(btrim(sku)) > 0),
  analysis       text not null check (length(btrim(analysis)) > 0),     -- o que deve ser testado
  explanation    text not null check (length(btrim(explanation)) > 0),  -- por quê
  start_date     date not null,
  end_date       date not null,
  status         text not null default 'pendente' check (status in ('pendente', 'aprovada', 'reprovada')),
  review_reason  text,
  reviewed_by    uuid references public.profiles (id),
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (end_date >= start_date),
  check (status <> 'reprovada' or coalesce(length(btrim(review_reason)), 0) > 0)
);
create index test_requests_user on public.test_requests (user_id, created_at desc);
create index test_requests_status on public.test_requests (status);

alter table public.test_requests enable row level security;
create policy test_requests_select on public.test_requests for select to authenticated
  using (public.is_admin() or (user_id = auth.uid() and public.is_active_user()));
revoke all on public.test_requests from anon;
revoke insert, update, delete on public.test_requests from authenticated;

create trigger test_requests_touch before update on public.test_requests
  for each row execute function public.touch_updated_at();
create trigger a_audit after insert or update on public.test_requests
  for each row execute function public.audit_trigger();

create or replace function public.validate_test_request(p_sku text, p_analysis text, p_explanation text, p_start date, p_end date)
returns void language plpgsql immutable as $$
begin
  if coalesce(btrim(p_sku), '') = '' then raise exception 'Informe a referência.' using errcode = '22023'; end if;
  if coalesce(btrim(p_analysis), '') = '' then raise exception 'Descreva o que deve ser testado.' using errcode = '22023'; end if;
  if coalesce(btrim(p_explanation), '') = '' then raise exception 'Explique por que fazer este teste.' using errcode = '22023'; end if;
  if p_start is null or p_end is null then raise exception 'Informe o início e a data final prevista.' using errcode = '22023'; end if;
  if p_end < p_start then raise exception 'A data final precisa ser igual ou depois do início.' using errcode = '22023'; end if;
end $$;

-- Analista: nova solicitação
create or replace function public.create_test_request(p_sku text, p_analysis text, p_explanation text, p_start date, p_end date)
returns public.test_requests language plpgsql security definer set search_path = public as $$
declare r test_requests;
begin
  if not is_active_user() then raise exception 'Usuário inativo.' using errcode = '42501'; end if;
  perform validate_test_request(p_sku, p_analysis, p_explanation, p_start, p_end);
  perform set_config('app.audit_action', 'teste_solicitado', true);
  insert into test_requests (user_id, sku, analysis, explanation, start_date, end_date)
  values (auth.uid(), btrim(p_sku), btrim(p_analysis), btrim(p_explanation), p_start, p_end)
  returning * into r;
  perform set_config('app.audit_action', '', true);
  return r;
end $$;

-- Analista: corrige e reenvia uma solicitação reprovada
create or replace function public.resubmit_test_request(p_id uuid, p_sku text, p_analysis text, p_explanation text, p_start date, p_end date)
returns public.test_requests language plpgsql security definer set search_path = public as $$
declare r test_requests;
begin
  select * into r from test_requests where id = p_id for update;
  if not found or r.user_id is distinct from auth.uid() then
    raise exception 'Solicitação não encontrada.' using errcode = 'P0002';
  end if;
  if r.status <> 'reprovada' then raise exception 'Só dá para reenviar uma solicitação reprovada.' using errcode = '22023'; end if;
  perform validate_test_request(p_sku, p_analysis, p_explanation, p_start, p_end);
  perform set_config('app.audit_action', 'teste_reenviado', true);
  update test_requests
     set sku = btrim(p_sku), analysis = btrim(p_analysis), explanation = btrim(p_explanation),
         start_date = p_start, end_date = p_end, status = 'pendente',
         review_reason = null, reviewed_by = null, reviewed_at = null
   where id = p_id
  returning * into r;
  perform set_config('app.audit_action', '', true);
  return r;
end $$;

-- Gestor: aprova ou reprova (reprovar exige justificativa)
create or replace function public.review_test_request(p_id uuid, p_status text, p_reason text default null)
returns public.test_requests language plpgsql security definer set search_path = public as $$
declare r test_requests;
begin
  if not is_admin() then raise exception 'Apenas o gestor aprova ou reprova testes.' using errcode = '42501'; end if;
  if p_status not in ('aprovada', 'reprovada') then raise exception 'Escolha aprovar ou reprovar.' using errcode = '22023'; end if;
  if p_status = 'reprovada' and coalesce(btrim(p_reason), '') = '' then
    raise exception 'Informe a justificativa da reprovação, para o analista saber o motivo.' using errcode = '22023';
  end if;
  select * into r from test_requests where id = p_id for update;
  if not found then raise exception 'Solicitação não encontrada.' using errcode = 'P0002'; end if;
  if r.status <> 'pendente' then raise exception 'Esta solicitação já foi avaliada.' using errcode = '22023'; end if;
  perform set_config('app.audit_action', case p_status when 'aprovada' then 'teste_aprovado' else 'teste_reprovado' end, true);
  update test_requests
     set status = p_status, review_reason = nullif(btrim(p_reason), ''), reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_id
  returning * into r;
  perform set_config('app.audit_action', '', true);
  return r;
end $$;

revoke execute on function public.validate_test_request(text, text, text, date, date),
  public.create_test_request(text, text, text, date, date),
  public.resubmit_test_request(uuid, text, text, text, date, date),
  public.review_test_request(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.create_test_request(text, text, text, date, date),
  public.resubmit_test_request(uuid, text, text, text, date, date),
  public.review_test_request(uuid, text, text)
  to authenticated;


-- >>> 20261113001500_performance.sql
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



-- >>> 20261113001600_workdays_only.sql
-- =====================================================================
-- Rotina · atividades só em dia de expediente (segunda a sexta)
--
-- 1. Etapas, rascunhos e envios só são aceitos em dia útil (Parâmetros >
--    dias de expediente, padrão segunda a sexta, menos feriados).
-- 2. O marco mensal vence no último dia útil do mês (nunca num fim de semana).
-- A tela do analista recomeça toda segunda: pendências de semanas anteriores
-- deixam de aparecer para ele e ficam só no acompanhamento do gestor.
-- =====================================================================

-- 1. Bloqueio fora do expediente (vale para set_step, save_draft, submit_task,
--    record_followup e resubmit_item, que passam por esta função).
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
  if not is_workday(local_today()) then
    raise exception 'Sem expediente hoje: as atividades valem de segunda a sexta.' using errcode = '22023';
  end if;
  if t.status = 'pausada' then
    raise exception 'Esta atividade está pausada e não aceita registros.' using errcode = '22023';
  end if;
  return t;
end $$;
revoke execute on function public.load_own_task(uuid) from public, anon, authenticated;

-- 2. Mensal: último dia útil do mês
create or replace function public.monthly_due(m date)
returns date language sql stable as $$
  select max(g::date)
  from generate_series(date_trunc('month', m)::date,
                       (date_trunc('month', m) + interval '1 month - 1 day')::date, interval '1 day') g
  where public.is_workday(g::date);
$$;

select set_config('app.audit_action', 'ressincronizacao', true);
update public.task_instances ti
   set ref_date = public.monthly_due(ti.period_start),
       due_at   = public.local_due(public.monthly_due(ti.period_start), '23:59:59')
 where ti.template_snapshot ->> 'frequency' = 'mensal'
   and ti.status in ('pendente', 'em_andamento', 'bloqueada_gate')
   and public.monthly_due(ti.period_start) is not null
   and ti.ref_date <> public.monthly_due(ti.period_start);
select set_config('app.audit_action', '', true);


-- >>> 20261113001700_user_visibility.sql
-- =====================================================================
-- Rotina · o gestor escolhe quais atividades aparecem para cada analista
--
-- 1. profiles.frequencies: frequências que o analista recebe (diária,
--    semanal, mensal). Padrão: todas. Ex.: só '{diaria}' = só as diárias.
-- 2. template_exclusions: tira um modelo "para todos" de um analista
--    específico, sem mexer nos demais.
-- 3. template_applies(modelo, analista) concentra a regra; a geração de
--    tarefas e as ressincronizações passam a usá-la.
-- 4. Ao mudar a visibilidade, tarefas futuras intocadas somem; as já
--    iniciadas ficam "pausadas" (e voltam se a atividade for reativada).
-- =====================================================================

alter table public.profiles
  add column if not exists frequencies public.frequency[] not null default '{diaria,semanal,mensal}';
comment on column public.profiles.frequencies is 'Frequências de atividade que o analista recebe (diaria, semanal, mensal).';

create table if not exists public.template_exclusions (
  template_id  uuid not null references public.activity_templates (id) on delete cascade,
  user_id      uuid not null references public.profiles (id),
  created_at   timestamptz not null default now(),
  primary key (template_id, user_id)
);
alter table public.template_exclusions enable row level security;
create policy exclusions_select on public.template_exclusions for select to authenticated
  using ((select public.is_admin()) or user_id = (select auth.uid()));
create policy exclusions_write on public.template_exclusions for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
revoke all on public.template_exclusions from anon;

create trigger a_audit after insert or delete on public.template_exclusions
  for each row execute function public.audit_trigger();

-- Regra única: o modelo vale para o analista?
create or replace function public.template_applies(p_template uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from activity_templates t join profiles u on u.id = p_user
     where t.id = p_template
       and t.frequency = any (u.frequencies)
       and (t.assign_all or exists (select 1 from template_assignments a
                                     where a.template_id = t.id and a.user_id = u.id))
       and not exists (select 1 from template_exclusions e
                        where e.template_id = t.id and e.user_id = u.id))
$$;

-- Geração de tarefas (igual à anterior, com a regra de visibilidade)
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
      and template_applies(t.id, u.id)
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
      and template_applies(t.id, u.id)
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
      and template_applies(t.id, u.id)
      and local_due(x.due, t.cutoff_time) > greatest(t.created_at, u.created_at)
    on conflict (template_id, user_id, period_key) do nothing;
    get diagnostics c = row_count; n := n + c;
  end loop;

  return n;
end $$;

-- Re-sincroniza as tarefas futuras de um analista após mudar o que ele vê.
create or replace function public.resync_user(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.audit_action', 'ressincronizacao', true);

  delete from task_instances ti
   where ti.user_id = p_user and ti.ref_date >= local_today()
     and ti.status = 'pendente' and ti.started_at is null and ti.submitted_at is null
     and ti.payload = '{}'::jsonb
     and not exists (select 1 from task_submissions s where s.task_id = ti.id)
     and not template_applies(ti.template_id, p_user);

  update task_instances set status = 'pausada'
   where user_id = p_user and ref_date >= local_today()
     and status in ('pendente', 'em_andamento', 'bloqueada_gate')
     and not template_applies(template_id, p_user);

  update task_instances ti
     set status = case when ti.started_at is null then 'pendente'::task_status else 'em_andamento'::task_status end
   where ti.user_id = p_user and ti.ref_date >= local_today() and ti.status = 'pausada'
     and template_applies(ti.template_id, p_user)
     and exists (select 1 from activity_templates t where t.id = ti.template_id and not t.paused)
     and exists (select 1 from profiles u where u.id = p_user and u.active and u.role = 'analista');

  perform set_config('app.audit_action', '', true);
  perform generate_tasks(local_today(), week_end(local_today()));
end $$;

-- Reativar um modelo não reativa tarefas de quem não deve vê-lo.
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
     where template_id = p_template and ref_date >= local_today() and status = 'pausada'
       and template_applies(template_id, user_id);
  end if;

  perform set_config('app.audit_action', '', true);
  perform generate_tasks(local_today(), week_end(local_today()));
end $$;

-- Perfil: desativar/promover tira as tarefas; reativar ou mudar frequências ressincroniza.
create or replace function public.trg_profile_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if ((new.active is distinct from old.active) or (new.role is distinct from old.role))
     and (not new.active or new.role <> 'analista') then
    perform set_config('app.audit_action', 'ressincronizacao', true);
    delete from task_instances ti
     where ti.user_id = new.id and ti.ref_date >= local_today() and ti.status = 'pendente'
       and ti.started_at is null and ti.submitted_at is null
       and not exists (select 1 from task_submissions s where s.task_id = ti.id);
    update task_instances set status = 'pausada'
     where user_id = new.id and ref_date >= local_today()
       and status in ('pendente', 'em_andamento', 'bloqueada_gate');
    perform set_config('app.audit_action', '', true);
  elsif (new.active is distinct from old.active) or (new.role is distinct from old.role)
     or (new.frequencies is distinct from old.frequencies) then
    perform resync_user(new.id);
  end if;
  return null;
end $$;

create or replace function public.trg_exclusion_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then perform resync_user(old.user_id);
  else perform resync_user(new.user_id); end if;
  return null;
end $$;

create trigger z_exclusions_resync after insert or delete on public.template_exclusions
  for each row execute function public.trg_exclusion_changed();

revoke execute on function public.template_applies(uuid, uuid), public.resync_user(uuid),
  public.trg_exclusion_changed() from public, anon, authenticated;


-- >>> 20261113001800_holidays_no_points.sql
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


commit;
