-- =====================================================================
-- Testes de banco (pgTAP): isolamento entre analistas, gate de conclusão,
-- status de prazo, revisão, pausa e auditoria.
-- Rodar: npx supabase test db   (local)  ·  ou colar no SQL Editor.
-- Tudo roda numa transação e é desfeito no final.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(91);

-- Os testes rodam em qualquer dia: durante o teste, todos os dias contam como expediente.
update settings set value = '[1,2,3,4,5,6,7]' where key = 'dias_uteis';

-- Fixtures ------------------------------------------------------------
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at) values
  ('aaaaaaaa-0000-4000-a000-000000000001', 'a@teste.local',   'authenticated', 'authenticated', '{}', '{"full_name":"Analista A"}', now() - interval '30 days'),
  ('aaaaaaaa-0000-4000-a000-000000000002', 'b@teste.local',   'authenticated', 'authenticated', '{}', '{"full_name":"Analista B"}', now() - interval '30 days'),
  ('aaaaaaaa-0000-4000-a000-000000000009', 'adm@teste.local', 'authenticated', 'authenticated', '{"role":"admin"}', '{"full_name":"Admin"}', now() - interval '30 days');

select is((select role::text from profiles where email = 'adm@teste.local'), 'admin', 'papel admin vem de app_metadata');
select is((select role::text from profiles where email = 'a@teste.local'), 'analista', 'novo usuário nasce analista');

-- Tarefas de teste com gate (snapshot próprio, independente do seed)
with tpl as (select id from activity_templates where code = 'D2')
insert into task_instances (id, template_id, user_id, period_key, ref_date, period_start, period_end, due_at, weight, template_snapshot)
select x.id, tpl.id, x.uid, x.pk, local_today(), local_today(), local_today(), x.due, 2,
       jsonb_build_object('code', 'TST', 'name', 'Teste',
         'fields', '[{"key":"qtd","label":"Quantidade","type":"number","required":true},
                     {"key":"itens","label":"Itens","type":"group","item_label":"Item","min_items":2,
                      "fields":[{"key":"sku","label":"SKU","type":"text","required":true}]}]'::jsonb,
         'gates',  '[{"key":"g1","question":"Há item abaixo de {limite_venda}%?","expected":"nao"}]'::jsonb)
from tpl, (values
  ('bbbbbbbb-0000-4000-a000-000000000001'::uuid, 'aaaaaaaa-0000-4000-a000-000000000001'::uuid, 'tst-a-prazo',  now() + interval '2 hours'),
  ('bbbbbbbb-0000-4000-a000-000000000002'::uuid, 'aaaaaaaa-0000-4000-a000-000000000001'::uuid, 'tst-a-atraso', now() - interval '2 hours'),
  ('bbbbbbbb-0000-4000-a000-000000000003'::uuid, 'aaaaaaaa-0000-4000-a000-000000000002'::uuid, 'tst-b',        now() + interval '2 hours')
) x(id, uid, pk, due);

-- Blocos em sequência (analista A): bloco 1 com 2 etapas, bloco 2 com 1 etapa
-- (mesmo período = mesma chave; modelos diferentes por causa da unicidade modelo+analista+período)
insert into task_instances (id, template_id, user_id, period_key, ref_date, period_start, period_end, due_at, weight, template_snapshot)
select x.id, (select id from activity_templates where code = x.tcode), 'aaaaaaaa-0000-4000-a000-000000000001',
       x.pk, local_today(), local_today(), local_today(), now() + interval '3 hours', 1,
       jsonb_build_object('code', x.tcode, 'name', x.nm, 'frequency', x.freq, 'sequential', true, 'sort_order', x.ord,
         'instructions', x.steps, 'fields', '[]'::jsonb, 'gates', '[]'::jsonb)
from (values
  ('cccccccc-0000-4000-a000-000000000001'::uuid, 'D1', 'dia-teste', 'diaria', 'Bloco 1', 10, '["Etapa um","Etapa dois"]'::jsonb),
  ('cccccccc-0000-4000-a000-000000000002'::uuid, 'D2', 'dia-teste', 'diaria', 'Bloco 2', 20, '["Etapa única"]'::jsonb),
  ('cccccccc-0000-4000-a000-000000000011'::uuid, 'M1', 'mes-teste', 'mensal', 'Marco 1', 10, '["Etapa única"]'::jsonb),
  ('cccccccc-0000-4000-a000-000000000012'::uuid, 'M2', 'mes-teste', 'mensal', 'Marco 2', 20, '["Etapa única"]'::jsonb)
) x(id, tcode, pk, freq, nm, ord, steps);

-- Testes do mensal já enviados (2 referências), para a aprovação por item
insert into task_instances (id, template_id, user_id, period_key, ref_date, period_start, period_end, due_at, weight, status,
                            payload, template_snapshot)
values ('dddddddd-0000-4000-a000-000000000001', (select id from activity_templates where code = 'M3'),
        'aaaaaaaa-0000-4000-a000-000000000001', 'teste-itens', local_today(), local_today(), local_today(), now() + interval '3 days', 1,
        'concluida_prazo',
        '{"testes":[{"sku":"BB-1","sugestao":"Trocar o kit de fotos"},{"sku":"BB-2","sugestao":"Mudar o título"}]}'::jsonb,
        '{"code":"M3","name":"Testes","frequency":"mensal","fields":[{"key":"testes","label":"Testes","type":"group","item_label":"Referência","min_items":2,"reviewable":true,"fields":[{"key":"sku","label":"SKU","type":"text","required":true},{"key":"sugestao","label":"Sugestão","type":"textarea","required":true}]}],"gates":[],"instructions":[]}'::jsonb);

-- Funções puras --------------------------------------------------------
select is(deadline_status('2026-11-13 10:59-03', '2026-11-13 11:00-03'), 'concluida_prazo'::task_status, 'antes do prazo = no prazo');
select is(deadline_status('2026-11-13 11:00-03', '2026-11-13 11:00-03'), 'concluida_prazo'::task_status, 'no minuto do prazo = no prazo');
select is(deadline_status('2026-11-13 11:01-03', '2026-11-13 11:00-03'), 'concluida_atraso'::task_status, 'depois do prazo = atraso');
select is(local_due('2026-11-13', '11:00'), '2026-11-13 14:00+00'::timestamptz, 'prazo local convertido de America/Sao_Paulo');

-- Como analista A ------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000001","role":"authenticated"}', true);

select is((select count(*)::int from task_instances where user_id = 'aaaaaaaa-0000-4000-a000-000000000002'), 0,
  'A não lê tarefas de B');
select is((select count(*)::int from profiles where id <> 'aaaaaaaa-0000-4000-a000-000000000001'), 0,
  'A não lê perfis de outros');
select is((select count(*)::int from v_task_facts where user_id <> 'aaaaaaaa-0000-4000-a000-000000000001'), 0,
  'view de métricas respeita RLS');
select is((select count(*)::int from audit_log), 0, 'A não lê auditoria');

select throws_ok($$update task_instances set status = 'concluida_prazo' where id = 'bbbbbbbb-0000-4000-a000-000000000001'$$,
  '42501', null, 'A não altera status direto na tabela');
select throws_ok($$select submit_task('bbbbbbbb-0000-4000-a000-000000000003', '{}', '{}', null)$$,
  'P0002', null, 'A não envia tarefa de B');

select throws_ok($$select submit_task('bbbbbbbb-0000-4000-a000-000000000001', '{"qtd":1}', '{}', null)$$,
  '22023', null, 'gate sem resposta impede envio');
select throws_ok($$select submit_task('bbbbbbbb-0000-4000-a000-000000000001', '{"qtd":1}', '{"g1":"sim"}', null)$$,
  '22023', null, 'gate SIM sem desvio e ação impede envio');
select is((select status::text from submit_task('bbbbbbbb-0000-4000-a000-000000000001', '{"qtd":1}', '{"g1":"sim"}',
           '{"skus":["BB-1"],"action":"Corrigido"}')), 'bloqueada_gate', 'gate SIM com desvio = bloqueada pelo gate');
select throws_ok($$select submit_task('bbbbbbbb-0000-4000-a000-000000000001', '{"qtd":1,"itens":[{"sku":"X"}]}', '{"g1":"nao"}', null)$$,
  '22023', null, 'grupo abaixo da meta (2 itens) impede conclusão');
select is((select status::text from submit_task('bbbbbbbb-0000-4000-a000-000000000001',
           '{"qtd":1,"itens":[{"sku":"X"},{"sku":"Y"}]}', '{"g1":"nao"}', null)), 'concluida_prazo', 'gate ok e campos ok = concluída no prazo');
select throws_ok($$select submit_task('bbbbbbbb-0000-4000-a000-000000000001', '{"qtd":2,"itens":[{"sku":"X"},{"sku":"Y"}]}', '{"g1":"nao"}', null)$$,
  '22023', null, 'concluída não pode ser reenviada sem contestação');
select is((select status::text from submit_task('bbbbbbbb-0000-4000-a000-000000000002',
           '{"qtd":1,"itens":[{"sku":"X"},{"sku":"Y"}]}', '{"g1":"nao"}', null)), 'concluida_atraso', 'envio depois do prazo = atraso');

select throws_ok($$select review_task('bbbbbbbb-0000-4000-a000-000000000001', 'validada', null)$$,
  '42501', null, 'analista não revisa');

-- Etapas e sequência ----------------------------------------------------
select throws_ok($$select set_step('cccccccc-0000-4000-a000-000000000002', 0, true)$$,
  '22023', null, 'bloco 2 fica bloqueado enquanto o bloco 1 não for concluído');
select throws_ok($$select submit_task('cccccccc-0000-4000-a000-000000000002', '{}', '{}', null)$$,
  '22023', null, 'bloco bloqueado não aceita envio');
select throws_ok($$select set_step('cccccccc-0000-4000-a000-000000000001', 1, true)$$,
  '22023', null, 'etapas seguem a ordem: não dá para pular a primeira');
select is((select status::text from set_step('cccccccc-0000-4000-a000-000000000001', 0, true)), 'em_andamento',
  'marcar a primeira etapa inicia o bloco');
select throws_ok($$select submit_task('cccccccc-0000-4000-a000-000000000001', '{}', '{}', null)$$,
  '22023', null, 'envio exige todas as etapas marcadas');
select throws_ok($$insert into task_steps (task_id, step_index, checked_by) values ('cccccccc-0000-4000-a000-000000000001', 1, 'aaaaaaaa-0000-4000-a000-000000000001')$$,
  '42501', null, 'analista não grava etapa direto na tabela');
select ok((select count(*) = 1 from set_step('cccccccc-0000-4000-a000-000000000001', 1, true)), 'segunda etapa marcada em ordem');
select throws_ok($$select set_step('cccccccc-0000-4000-a000-000000000001', 0, false)$$,
  '22023', null, 'só a última etapa marcada pode ser desmarcada');
select is((select status::text from submit_task('cccccccc-0000-4000-a000-000000000001', '{}', '{}', null)), 'concluida_prazo',
  'todas as etapas marcadas: bloco concluído');
select throws_ok($$select set_step('cccccccc-0000-4000-a000-000000000001', 1, false)$$,
  '22023', null, 'bloco concluído não aceita alterar etapas');
select is((select (set_step('cccccccc-0000-4000-a000-000000000002', 0, true)).status::text), 'em_andamento',
  'concluir o bloco 1 libera o bloco 2');
select is((select count(*)::int from task_steps), 3, 'A enxerga as próprias etapas');

-- Analista B não vê as etapas de A
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000002","role":"authenticated"}', true);
select is((select count(*)::int from task_steps), 0, 'B não enxerga etapas de A');
select throws_ok($$select set_step('cccccccc-0000-4000-a000-000000000002', 0, false)$$,
  'P0002', null, 'B não altera etapas de A');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000001","role":"authenticated"}', true);

-- Como admin -----------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000009","role":"authenticated"}', true);
select throws_ok($$select review_task('bbbbbbbb-0000-4000-a000-000000000001', 'contestada', '  ')$$,
  '22023', null, 'contestação exige motivo');
select is((select needs_rework from review_task('bbbbbbbb-0000-4000-a000-000000000001', 'contestada', 'SKU inexistente')),
  true, 'contestada volta para o analista');
select ok((select count(*) >= 3 from audit_log
            where entity_id = 'bbbbbbbb-0000-4000-a000-000000000001' and action in ('bloqueio_gate', 'envio', 'revisao')),
  'bloqueio, envio e revisão aparecem na auditoria');
select ok((select count(*) = 3 from audit_log where entity = 'task_steps' and action = 'etapa_marcada'),
  'cada etapa marcada fica na auditoria (quem e quando)');
select ok((select count(*) = 3 from audit_log l join task_steps s on s.id::text = l.entity_id
            where l.entity = 'task_steps' and l.actor_id = s.checked_by and l.at is not null),
  'auditoria da etapa guarda o usuário que marcou');

-- Marcos do mensal em sequência -------------------------------------------
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000001","role":"authenticated"}', true);
select throws_ok($$select set_step('cccccccc-0000-4000-a000-000000000012', 0, true)$$,
  '22023', null, 'marco 2 do mensal fica bloqueado até concluir o marco 1');
select is((select status::text from set_step('cccccccc-0000-4000-a000-000000000011', 0, true)), 'em_andamento',
  'marco 1 do mensal está liberado');

-- Aprovação por referência (itens do grupo revisável) -----------------------
select throws_ok($$select review_item('dddddddd-0000-4000-a000-000000000001', 'testes', 0, 'aprovada', null)$$,
  '42501', null, 'analista não aprova nem reprova teste');
select throws_ok($$insert into task_item_reviews (task_id, group_key, item_index, status, reviewer_id)
  values ('dddddddd-0000-4000-a000-000000000001', 'testes', 0, 'aprovada', 'aaaaaaaa-0000-4000-a000-000000000001')$$,
  '42501', null, 'analista não grava aprovação direto na tabela');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000009","role":"authenticated"}', true);
select is((select status from review_item('dddddddd-0000-4000-a000-000000000001', 'testes', 0, 'aprovada', null)), 'aprovada',
  'admin aprova a referência 1');
select throws_ok($$select review_item('dddddddd-0000-4000-a000-000000000001', 'testes', 1, 'reprovada', '  ')$$,
  '22023', null, 'reprovar exige o motivo');
select is((select status from review_item('dddddddd-0000-4000-a000-000000000001', 'testes', 1, 'reprovada', 'Hipótese muito genérica')), 'reprovada',
  'admin reprova a referência 2 de forma independente da 1');
select throws_ok($$select review_item('dddddddd-0000-4000-a000-000000000001', 'testes', 0, 'reprovada', 'Mudei de ideia')$$,
  '22023', null, 'referência já avaliada não é avaliada de novo');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000001","role":"authenticated"}', true);
select is((select count(*)::int from task_item_reviews where task_id = 'dddddddd-0000-4000-a000-000000000001'), 2,
  'analista vê o retorno de cada referência');
select throws_ok($$select resubmit_item('dddddddd-0000-4000-a000-000000000001', 'testes', 0, '{"sku":"BB-1","sugestao":"Outra"}')$$,
  '22023', null, 'referência aprovada não pode ser reenviada');
select throws_ok($$select resubmit_item('dddddddd-0000-4000-a000-000000000001', 'testes', 1, '{"sku":"BB-2","sugestao":""}')$$,
  '22023', null, 'reenvio exige os campos preenchidos');
select ok((select (payload -> 'testes' -> 1 ->> 'sugestao') = 'Testar vídeo na página'
             from resubmit_item('dddddddd-0000-4000-a000-000000000001', 'testes', 1, '{"sku":"BB-2","sugestao":"Testar vídeo na página"}')),
  'analista corrige e reenvia a referência reprovada (a aprovada não muda)');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000009","role":"authenticated"}', true);
select is((select status from review_item('dddddddd-0000-4000-a000-000000000001', 'testes', 1, 'aprovada', null)), 'aprovada',
  'referência reenviada volta para a avaliação do admin');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000002","role":"authenticated"}', true);
select is((select count(*)::int from task_item_reviews), 0, 'outro analista não vê aprovações alheias');

-- Usuários e papéis no banco ----------------------------------------------
select throws_ok($$select admin_create_user('novo@teste.local', 'Novo', 'analista', 'senha-forte-1')$$,
  '42501', null, 'analista não cria login');
update profiles set role = 'admin' where id = 'aaaaaaaa-0000-4000-a000-000000000002';
reset role;
select is((select role::text from profiles where id = 'aaaaaaaa-0000-4000-a000-000000000002'), 'analista',
  'analista não muda o próprio papel (o banco ignora a tentativa)');
set local role authenticated;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000009","role":"authenticated"}', true);
select is((select role::text from admin_create_user('Novo@Teste.local', 'Pessoa Nova', 'analista', 'senha-forte-1')), 'analista',
  'admin cria login de analista pelo painel');
select throws_ok($$select admin_create_user('novo@teste.local', 'Outra', 'analista', 'senha-forte-1')$$,
  '22023', null, 'e-mail repetido é recusado');
select throws_ok($$select admin_create_user('x@teste.local', 'X', 'analista', 'curta')$$,
  '22023', null, 'senha com menos de 8 caracteres é recusada');
update profiles set role = 'admin' where email = 'novo@teste.local';
reset role;
select is((select raw_app_meta_data ->> 'role' from auth.users where email = 'novo@teste.local'), 'admin',
  'mudar o papel no perfil atualiza o login');
set local role authenticated;
update profiles set active = false where email = 'novo@teste.local';
reset role;
select ok((select banned_until > now() from auth.users where email = 'novo@teste.local'), 'desativar bloqueia o login');
set local role authenticated;
update profiles set role = 'analista', active = true where email = 'novo@teste.local';
select throws_ok($$update profiles set role = 'analista' where id = 'aaaaaaaa-0000-4000-a000-000000000009'$$,
  '22023', null, 'o último admin master ativo não pode ser rebaixado');
select lives_ok($$select admin_set_password((select id from profiles where email = 'novo@teste.local'), 'outra-senha-1')$$,
  'admin redefine a senha');

reset role;
-- Links das ferramentas: todos leem, só o gestor escreve
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000009","role":"authenticated"}', true);
select lives_ok($$insert into useful_links (name, url, description) values ('Hub', 'https://ceo61.github.io/bb-hub/', 'Importações e concorrência')$$,
  'gestor cadastra link');
select throws_ok($$insert into useful_links (name, url) values ('Ruim', 'ftp://x')$$, '23514', null, 'link precisa começar com http(s)');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000001","role":"authenticated"}', true);
select is((select count(*)::int from useful_links), 1, 'analista vê os links');
select throws_ok($$insert into useful_links (name, url) values ('Meu', 'https://x.com')$$, '42501', null, 'analista não cadastra link');
update useful_links set name = 'Alterado';
select is((select name from useful_links limit 1), 'Hub', 'analista não altera link');
reset role;

-- Solicitações de teste (bloco opcional) ------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000001","role":"authenticated"}', true);
select is((select status from create_test_request('AB-12X', 'Trocar o kit de fotos', 'Fotos atuais sem aplicação', local_today(), local_today() + 14)),
  'pendente', 'analista solicita teste e ele fica aguardando aprovação');
select throws_ok($$select create_test_request('AB-1', 'X', 'Y', local_today(), local_today() - 1)$$,
  '22023', null, 'data final antes do início é recusada');
select throws_ok($$select create_test_request('  ', 'X', 'Y', local_today(), local_today())$$,
  '22023', null, 'referência é obrigatória');
select throws_ok($$select review_test_request((select id from test_requests limit 1), 'aprovada', null)$$,
  '42501', null, 'analista não aprova o próprio teste');
select throws_ok($$insert into test_requests (user_id, sku, analysis, explanation, start_date, end_date)
  values ('aaaaaaaa-0000-4000-a000-000000000001', 'Z', 'Z', 'Z', local_today(), local_today())$$,
  '42501', null, 'analista não grava solicitação direto na tabela');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000009","role":"authenticated"}', true);
select throws_ok($$select review_test_request((select id from test_requests where sku = 'AB-12X'), 'reprovada', ' ')$$,
  '22023', null, 'reprovar exige justificativa');
select is((select review_reason from review_test_request((select id from test_requests where sku = 'AB-12X'), 'reprovada', 'Categoria fora da estratégia')),
  'Categoria fora da estratégia', 'gestor reprova com justificativa');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000002","role":"authenticated"}', true);
select is((select count(*)::int from test_requests), 0, 'outro analista não vê a solicitação');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000001","role":"authenticated"}', true);
select is((select status from resubmit_test_request((select id from test_requests where sku = 'AB-12X'), 'AB-12X', 'Trocar fotos e título', 'Ajustado à estratégia', local_today(), local_today() + 10)),
  'pendente', 'analista corrige e reenvia a reprovada');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000009","role":"authenticated"}', true);
select is((select status from review_test_request((select id from test_requests where sku = 'AB-12X'), 'aprovada', null)),
  'aprovada', 'gestor aprova o reenvio');
reset role;

-- Tela "Hoje" numa chamada: só dados do próprio analista ------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000001","role":"authenticated"}', true);
select ok((select bool_and(x ->> 'user_id' = 'aaaaaaaa-0000-4000-a000-000000000001') and count(*) > 0
             from jsonb_array_elements((dashboard_today(local_today(), local_today() - 7)) -> 'tasks') x),
  'dashboard_today traz só tarefas do próprio analista');
select ok((select count(*) > 0 from jsonb_array_elements((dashboard_today(local_today(), local_today() - 7)) -> 'steps')),
  'dashboard_today traz as etapas marcadas');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000002","role":"authenticated"}', true);
select is((select count(*)::int from jsonb_array_elements((dashboard_today(local_today(), local_today() - 7)) -> 'steps')), 0,
  'dashboard_today de outro analista não vê etapas alheias');
reset role;

-- Fora do expediente nada é registrado -----------------------------------
update settings set value = '[]' where key = 'dias_uteis';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000001","role":"authenticated"}', true);
select throws_ok($$select set_step('cccccccc-0000-4000-a000-000000000011', 0, false)$$,
  '22023', 'Sem expediente hoje: as atividades valem de segunda a sexta.', 'fora do expediente a etapa não é registrada');
reset role;
update settings set value = '[1,2,3,4,5,6,7]' where key = 'dias_uteis';
select is(monthly_due('2026-01-15'), '2026-01-31'::date, 'mensal vence no último dia útil do mês');

-- Visibilidade por analista: frequências e exclusões ---------------------
select generate_tasks(local_today(), local_today() + 14);
update profiles set frequencies = '{diaria}' where id = 'aaaaaaaa-0000-4000-a000-000000000002';
select is((select count(*)::int from task_instances ti join activity_templates t on t.id = ti.template_id
            where ti.user_id = 'aaaaaaaa-0000-4000-a000-000000000002' and ti.ref_date >= local_today()
              and t.frequency <> 'diaria' and ti.status <> 'pausada'), 0,
  'só diárias: semanais e mensais futuras saem da lista do analista');
select ok((select count(*) > 0 from task_instances ti join activity_templates t on t.id = ti.template_id
            where ti.user_id = 'aaaaaaaa-0000-4000-a000-000000000002' and ti.ref_date >= local_today()
              and t.frequency = 'diaria' and ti.status <> 'pausada'),
  'só diárias: as diárias continuam');
update profiles set frequencies = '{diaria,semanal,mensal}' where id = 'aaaaaaaa-0000-4000-a000-000000000002';
select generate_tasks(local_today(), local_today() + 14);
select ok((select count(*) > 0 from task_instances ti join activity_templates t on t.id = ti.template_id
            where ti.user_id = 'aaaaaaaa-0000-4000-a000-000000000002' and ti.ref_date >= local_today()
              and t.frequency = 'semanal' and ti.status <> 'pausada'),
  'devolver a frequência traz as semanais de volta');
insert into template_exclusions (template_id, user_id)
  values ((select id from activity_templates where code = 'D1'), 'aaaaaaaa-0000-4000-a000-000000000002');
select is((select count(*)::int from task_instances ti
            where ti.user_id = 'aaaaaaaa-0000-4000-a000-000000000002' and ti.ref_date >= local_today()
              and ti.template_id = (select id from activity_templates where code = 'D1') and ti.status <> 'pausada'), 0,
  'atividade excluída some só para aquele analista');
select ok((select count(*) > 0 from task_instances ti
            where ti.user_id = 'aaaaaaaa-0000-4000-a000-000000000001' and ti.ref_date >= local_today()
              and ti.template_id = (select id from activity_templates where code = 'D1')),
  'os outros analistas continuam com a atividade excluída');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-a000-000000000002","role":"authenticated"}', true);
delete from template_exclusions where user_id = 'aaaaaaaa-0000-4000-a000-000000000002';
reset role;
select is((select count(*)::int from template_exclusions where user_id = 'aaaaaaaa-0000-4000-a000-000000000002'), 1,
  'analista não consegue remover a própria exclusão');

-- Nenhum texto fala mais em "admin master"
select is((select count(*)::int from activity_templates where (coalesce(description,'') || instructions::text || fields::text) ~* 'admin master'), 0,
  'modelos usam "gestor" em vez de "admin master"');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~* 'admin master'), 0,
  'mensagens do banco usam "gestor"');

-- Só os blocos pedidos: diário D1, D2, D3, D5; semanal S1; mensal M1, M2, M3
select is((select string_agg(code, ',' order by sort_order) from activity_templates),
  'D1,D2,D3,D5,S1,M1,M2,M3', 'existem só os blocos e marcos pedidos, na ordem');

select * from finish();
rollback;
