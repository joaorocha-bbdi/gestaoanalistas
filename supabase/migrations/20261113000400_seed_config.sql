-- =====================================================================
-- Rotina · parâmetros padrão e modelos de atividade iniciais
-- Textos aceitam {concorrente} e {limite_*} (ver settings).
-- =====================================================================

insert into public.settings (key, value, label, description) values
  ('gate_params',            '{"limite_venda": 80, "limite_folga": 0}', 'Limites das verificações',
   'Valores usados nas perguntas-gate da precificação diária.'),
  ('curva_por_dia',          '{"1":"A","2":"B","3":"C","4":"D","5":"E"}', 'Curva por dia da semana',
   'Qual curva cada dia útil precifica. Dia sem curva fica sem rotação.'),
  ('curvas',                 '["A","B","C","D","E"]', 'Curvas disponíveis', null),
  ('rotulo_concorrente',     '"BGT"', 'Concorrente de referência',
   'Nome exibido nas instruções e perguntas (ex.: BGT).'),
  ('dias_uteis',             '[1,2,3,4,5]', 'Dias de expediente', 'ISO: 1 = segunda … 7 = domingo.'),
  ('pesos_eficiencia',       '{"conclusao":40,"pontualidade":30,"qualidade":30}', 'Pesos do índice de eficiência',
   'Composição do índice 0–100. Os pesos são normalizados pela soma.'),
  ('amostragem_revisao',     '20', 'Amostra de revisão (%)',
   'Percentual de conclusões sorteadas de forma estável para revisão.'),
  ('status_pedido_opcoes',   '["Não iniciado","Em cotação","Pedido feito","Outro"]', 'Status do pedido de compra', null),
  ('status_importacao_opcoes','["Em produção","Embarcada","Em trânsito","Em desembaraço","Recebida","Outro"]', 'Status da importação', null),
  ('hub_url',                '"https://ceo61.github.io/bb-hub/"', 'Endereço do hub', null)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Modelos
-- ---------------------------------------------------------------------
insert into public.activity_templates
  (code, name, description, instructions, frequency, weekdays, cutoff_time, target_qty, target_label,
   weight, valid_from, valid_to, paused, pause_reason, shows_curve, fields, gates, followup_fields, sort_order)
values
-- D1 ------------------------------------------------------------------
('D1', 'Descontos Black Friday',
 'Conferir o que muda hoje na campanha e separar o que bate de frente com a {concorrente}.',
 '["Abrir o hub e clicar em “ver o que vai mudar hoje”.",
   "Conferir os produtos listados.",
   "Separar o range de produtos que vão bater de frente com a {concorrente} e os que não vão."]',
 'diaria', '{1,2,3,4,5}', '12:00', null, null,
 1, '2026-11-01', '2026-11-30', false, null, false,
 '[{"key":"colidem","label":"Produtos que colidem com a {concorrente}","type":"number","required":true},
   {"key":"nao_colidem","label":"Produtos que não colidem","type":"number","required":true},
   {"key":"observacoes","label":"Observações","type":"textarea"}]',
 '[]', '[]', 10),

-- D2 ------------------------------------------------------------------
('D2', 'Precificação diária por curva',
 'Precificar a curva do dia e garantir que a {concorrente} está mapeada.',
 '["Abrir a curva do dia indicada no card.",
   "Precificar considerando tudo o que foi alinhado nas reuniões.",
   "Para cada produto, verificar o mapeamento da {concorrente}: eles têm o produto? Falta o link para rastrearmos o preço?",
   "Responder as verificações. Se alguma for SIM, listar os SKUs em desvio e a ação tomada."]',
 'diaria', '{1,2,3,4,5}', '11:00', null, null,
 2, null, null, false, null, true,
 '[{"key":"curva","label":"Curva trabalhada","type":"select","options_setting":"curvas","default_from":"curva_do_dia","required":true},
   {"key":"qtd_precificados","label":"Produtos precificados","type":"number","required":true},
   {"key":"skus_link","label":"SKUs que precisaram de link {concorrente}","type":"list","mono":true,"help":"Um SKU por linha. A quantidade é contada automaticamente."},
   {"key":"diretrizes","label":"Diretrizes de reunião aplicadas","type":"textarea","required":true}]',
 '[{"key":"venda_abaixo","question":"Há algum item com venda abaixo de {limite_venda}%?","expected":"nao"},
   {"key":"folga_abaixo","question":"Há algum item com folga abaixo de {limite_folga}?","expected":"nao"}]',
 '[]', 20),

-- D3 ------------------------------------------------------------------
('D3', 'Check de 2 produtos com giro',
 'Revisão completa de dois produtos que giram, entendendo por que convertem.',
 '["Escolher 2 produtos com giro.",
   "Para cada um, percorrer o checklist até o fim antes de passar ao próximo."]',
 'diaria', '{1,2,3,4,5}', '17:00', 2, 'produtos',
 1, null, null, false, null, false,
 '[{"key":"produtos","label":"Produtos","type":"group","item_label":"Produto","min_items":2,"fields":[
     {"key":"sku","label":"SKU","type":"text","mono":true,"required":true},
     {"key":"compatibilidades","label":"Compatibilidades verificadas","type":"boolean","required":true},
     {"key":"lixos","label":"Lixos removidos","type":"boolean","required":true,
      "note":"Candidato a integração: remover lixos depende de sistemas da tecnologia. Na v1 é verificação manual."},
     {"key":"variacoes","label":"Variações que mais e menos convertem","type":"textarea","required":true},
     {"key":"renovar_fotos","label":"Kit de fotos precisa ser renovado?","type":"boolean","required":true},
     {"key":"alterar_descricao","label":"Descrição precisa de alteração?","type":"boolean","required":true},
     {"key":"botoes_coesos","label":"Nomes dos botões de SKU estão coesos","type":"boolean","required":true},
     {"key":"pdp_revisada","label":"PDP completa revisada","type":"boolean","required":true},
     {"key":"por_que_converte","label":"Por que o produto converte bem","type":"text","required":true},
     {"key":"observacoes","label":"Observações","type":"textarea"}]}]',
 '[]', '[]', 30),

-- D4 ------------------------------------------------------------------
('D4', '5 produtos entupidos',
 'Estoque parado: diagnosticar por que não vende e traçar estratégia.',
 '["Selecionar 5 produtos com estoque parado.",
   "Para cada um, registrar o diagnóstico e a estratégia."]',
 'diaria', '{1,2,3,4,5}', '17:00', 5, 'produtos',
 1, null, null, true, 'Segurar para a próxima onda.', false,
 '[{"key":"produtos","label":"Produtos","type":"group","item_label":"Produto","min_items":5,"fields":[
     {"key":"sku","label":"SKU","type":"text","mono":true,"required":true},
     {"key":"motivo","label":"Motivo de não vender","type":"select","required":true,
      "options":["Falta de compatibilidade","Falta de fotos","Preço ruim","Outro"]},
     {"key":"diagnostico","label":"Diagnóstico","type":"textarea","required":true},
     {"key":"estrategia","label":"Estratégia traçada","type":"textarea","required":true}]}]',
 '[]', '[]', 40),

-- D5 ------------------------------------------------------------------
('D5', 'Acompanhamento da concorrência',
 'Ler o movimento de preço da concorrência na categoria e transformar em ação.',
 '["Abrir a aba de concorrência no hub.",
   "Verificar se a concorrência abaixou, manteve ou aumentou preço na categoria.",
   "Identificar oportunidades de mercado e associar uma ação a cada uma."]',
 'diaria', '{1,2,3,4,5}', '16:00', null, null,
 1, null, null, false, null, false,
 '[{"key":"categoria","label":"Categoria analisada","type":"text","required":true},
   {"key":"movimento","label":"Movimento observado","type":"select","required":true,"options":["Abaixou","Manteve","Aumentou"]},
   {"key":"oportunidade","label":"Oportunidade identificada","type":"textarea","required":true},
   {"key":"acao","label":"Ação proposta","type":"textarea","required":true}]',
 '[]', '[]', 50),

-- S1 ------------------------------------------------------------------
('S1', 'Acompanhamento do pedido de compra',
 'Saber o volume necessário e em que pé está o pedido.',
 '["Abrir o hub na aba importações: https://ceo61.github.io/bb-hub/?#importacoes",
   "Conferir o volume de pedido necessário.",
   "Confirmar se o pedido já foi feito, se está em cotação ou parado."]',
 'semanal', '{5}', '17:00', null, null,
 1, null, null, false, null, false,
 '[{"key":"status_pedido","label":"Status do pedido","type":"select","options_setting":"status_pedido_opcoes","required":true},
   {"key":"volume","label":"Volume necessário","type":"number","required":true},
   {"key":"observacoes","label":"Observações","type":"textarea"}]',
 '[]', '[]', 60),

-- M1 ------------------------------------------------------------------
('M1', 'Acompanhamento da importação',
 'Estar totalmente por dentro da importação, inclusive da data de chegada da carga.',
 '["Levantar o status atual da importação.", "Confirmar a data prevista de chegada da carga."]',
 'mensal', '{1,2,3,4,5}', '17:00', null, null,
 1, null, null, false, null, false,
 '[{"key":"status_importacao","label":"Status da importação","type":"select","options_setting":"status_importacao_opcoes","required":true},
   {"key":"chegada","label":"Data prevista de chegada","type":"date","required":true},
   {"key":"observacoes","label":"Observações","type":"textarea"}]',
 '[]', '[]', 70),

-- M2 ------------------------------------------------------------------
('M2', 'Pesquisa de mercado da categoria',
 'Comparar nosso ticket com o mercado na categoria.',
 '["Escolher a categoria.", "Levantar preços praticados pelo mercado.", "Concluir se nosso ticket está acima, abaixo ou igual."]',
 'mensal', '{1,2,3,4,5}', '17:00', null, null,
 1, null, null, false, null, false,
 '[{"key":"categoria","label":"Categoria","type":"text","required":true},
   {"key":"ticket","label":"Nosso ticket em relação ao mercado","type":"select","required":true,"options":["Maior","Igual","Menor"]},
   {"key":"evidencias","label":"Evidências e links","type":"list","required":true,"help":"Um link ou evidência por linha."},
   {"key":"observacoes","label":"Observações","type":"textarea"}]',
 '[]', '[]', 80),

-- M3 ------------------------------------------------------------------
('M3', 'Dois testes de estratégia por categoria',
 'Executar dois testes no mês e registrar a leitura do resultado quando sair.',
 '["Definir a hipótese de cada teste.",
   "Aplicar a alteração (ex.: trocar o kit de fotos de 2 produtos de teclado).",
   "Registrar a métrica de antes e a data prevista de leitura.",
   "Quando a leitura sair, registrar métrica depois e conclusão em “Registrar leitura”."]',
 'mensal', '{1,2,3,4,5}', '17:00', 2, 'testes',
 1, null, null, false, null, false,
 '[{"key":"testes","label":"Testes","type":"group","item_label":"Teste","min_items":2,"fields":[
     {"key":"hipotese","label":"Hipótese","type":"textarea","required":true},
     {"key":"alvo","label":"Produto ou categoria","type":"text","required":true},
     {"key":"alteracao","label":"O que foi alterado","type":"textarea","required":true},
     {"key":"metrica_antes","label":"Métrica antes","type":"text","required":true},
     {"key":"inicio","label":"Data de início","type":"date","required":true},
     {"key":"leitura_prevista","label":"Data de leitura","type":"date","required":true}]}]',
 '[]',
 '[{"key":"leituras","label":"Leituras","type":"group","item_label":"Teste","fields":[
     {"key":"metrica_depois","label":"Métrica depois","type":"text"},
     {"key":"conclusao","label":"Conclusão","type":"textarea"}]}]',
 90)
on conflict (code) do nothing;

-- Feriados nacionais (edite em Parâmetros).
insert into public.holidays (day, label) values
  ('2026-11-02', 'Finados'),
  ('2026-11-20', 'Dia da Consciência Negra'),
  ('2026-12-25', 'Natal'),
  ('2027-01-01', 'Confraternização Universal'),
  ('2027-02-15', 'Carnaval'),
  ('2027-02-16', 'Carnaval'),
  ('2027-03-26', 'Sexta-feira Santa'),
  ('2027-04-21', 'Tiradentes'),
  ('2027-05-01', 'Dia do Trabalho')
on conflict (day) do nothing;
