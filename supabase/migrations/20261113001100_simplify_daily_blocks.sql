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
