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
