-- =====================================================================
-- Rotina · agendamento (pg_cron, horários em UTC)
-- 03:05 UTC = 00:05 em São Paulo: gera as tarefas da semana corrente.
-- A cada 15 min: marca vencidas como "não feita".
-- Se pg_cron não estiver disponível, o app cobre via refresh_tasks() ao abrir.
-- =====================================================================
do $do$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('rotina-gerar-tarefas', '5 3 * * *',
    $c$select public.generate_tasks(public.local_today(), public.week_end(public.local_today())); select public.mark_overdue();$c$);
  perform cron.schedule('rotina-vencidas', '*/15 * * * *', $c$select public.mark_overdue();$c$);
exception when others then
  raise notice 'pg_cron indisponível (%). Ative em Database > Extensions e rode este arquivo de novo.', sqlerrm;
end
$do$;
