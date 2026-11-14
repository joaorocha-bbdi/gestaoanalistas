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
