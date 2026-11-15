import { useMemo, useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ErrorNote, PageHeader, Section, Skeleton } from '@/components/ui'
import { FilterBar, useFilters } from '@/features/metrics/Filters'
import { ActivityBreakdown } from '@/features/metrics/Breakdowns'
import { OverdueTable, overdueNow, WeekProgress } from '@/features/metrics/Team'
import { DayBoard, ProductAnalyses, useProductAnalyses } from '@/features/metrics/DayBoard'
import { EfficiencyDashboard, type ChartView } from '@/features/metrics/EfficiencyDashboard'
import { TaskPanel } from '@/features/tasks/TaskPanel'
import { useAnalysts, useFacts, useItemReviews, useSettings, useTestRequests, useTestsQueue } from '@/data/queries'
import { itemStatus, reviewableGroups } from '@/lib/itemReviews'
import { coveringRange, sliceFacts } from '@/lib/perf'
import { addDays, fmtDay, startOfWeek, todayISO } from '@/lib/dates'
import { useNow, useSearchParamState } from '@/lib/hooks'

/** Início de "todo o período": antes de qualquer registro possível do sistema. */
const SINCE_ALWAYS = '2020-01-01'

export default function Overview() {
  const now = useNow()
  const today = todayISO()
  const settings = useSettings()
  const weights = settings.pesos_eficiencia
  const [f, actions] = useFilters('semana')
  const [openId, setOpenId] = useSearchParamState('t')
  const [view, setView] = useState<ChartView>('semana')

  const analystsQ = useAnalysts()
  const analysts = analystsQ.data.filter((a) => !f.userId || a.id === f.userId)
  // Uma busca só no banco cobre todos os recortes da tela; o recorte é feito aqui.
  const ranges = {
    // Não feitas: últimos 14 dias, para a semana anterior continuar visível para o gestor na segunda.
    recent: { from: addDays(today, -13), to: today },
    period: { from: f.from, to: f.to },
    week: { from: startOfWeek(today), to: addDays(startOfWeek(today), 6) },
    history: { from: view === 'total' ? SINCE_ALWAYS : addDays(today, view === 'mes' ? -365 : -84), to: today },
  }
  const all = useFacts({ ...coveringRange(Object.values(ranges)), userId: f.userId, templateId: f.templateId })
  // Recortes memorizados: o relógio (a cada 30 s) não refaz as contas sobre milhares de linhas.
  const rangeKey = JSON.stringify(ranges)
  const { recent, period, week, history } = useMemo(() => {
    const cut = (r: { from: string; to: string }) => (all.isLoading ? undefined : sliceFacts(all.data, r.from, r.to))
    return { recent: cut(ranges.recent), period: cut(ranges.period), week: cut(ranges.week), history: cut(ranges.history) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all.data, all.isLoading, rangeKey])

  const analyses = useProductAnalyses(12)
  const testsQ = useTestsQueue()
  const testTasks = (testsQ.data ?? []).filter((t) => reviewableGroups(t.template_snapshot.fields).length > 0)
  const testReviews = useItemReviews(testTasks.map((t) => t.id))
  const requestsQ = useTestRequests()
  const pendingRequests = (requestsQ.data ?? []).filter((r) => r.status === 'pendente').length
  const pendingItems = testReviews.isLoading ? 0 : testTasks.reduce((n, t) => n + reviewableGroups(t.template_snapshot.fields).reduce((m, g) =>
    m + ((Array.isArray(t.payload[g.key]) ? t.payload[g.key] : []) as unknown[]).filter((_, i) => itemStatus(testReviews.data, t.id, g.key, i).state === 'pendente').length, 0), 0)
  const pendingTests = pendingItems + pendingRequests
  const overdue = useMemo(() => overdueNow(recent ?? [], now), [recent, now])
  const todayOverdue = overdue.filter((x) => x.ref_date === today).length
  const PHRASE = { hoje: 'hoje', semana: 'nesta semana', mes: 'neste mês', '30d': 'nos últimos 30 dias' } as const
  const periodLabel = f.preset === 'custom' ? `de ${fmtDay(f.from)} a ${fmtDay(f.to)}` : PHRASE[f.preset]

  return (
    <>
      <PageHeader title="Visão geral" meta="Quem deixou de fazer, onde cada pessoa parou e como anda a eficiência da equipe.">
        <FilterBar state={f} actions={actions} />
      </PageHeader>

      {pendingTests > 0 && (
        <Link to="/admin/testes" className="mb-8 flex items-center justify-between gap-3 rounded border border-signal bg-accent-soft px-4 py-3 hover:brightness-95">
          <span><span className="font-semibold">{pendingTests === 1 ? '1 teste aguarda' : `${pendingTests} testes aguardam`} a sua aprovação.</span>{' '}
            <span className="text-muted">Cada referência é aprovada ou reprovada separadamente.</span></span>
          <span className="shrink-0 text-sm font-medium underline underline-offset-2">Abrir aprovação de testes</span>
        </Link>
      )}

      <ErrorNote error={all.error} />

      <Section
        title="Atividades não feitas"
        meta={all.isLoading ? undefined : overdue.length
          ? `${overdue.length} nos últimos 14 dias, ${todayOverdue} de hoje. O analista deixa de ver as da semana anterior na segunda; elas ficam aqui.`
          : undefined}
      >
        {all.isLoading ? <Skeleton className="h-32" /> : overdue.length ? (
          <OverdueTable facts={overdue} now={now} onOpen={setOpenId} />
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted"><CheckCircle2 className="size-4 text-ok" aria-hidden />Nenhuma atividade deixada de fazer nos últimos 14 dias com esses filtros.</p>
        )}
      </Section>

      <Section title="Avanço de hoje" meta="etapas marcadas em cada bloco, em ordem">
        {all.isLoading ? <Skeleton className="h-32" /> : (
          <DayBoard analysts={analysts} facts={recent ?? []} today={today} onOpen={setOpenId} />
        )}
      </Section>

      <Section title="Eficiência" meta={`Atividades concluídas ÷ esperadas, ${periodLabel}.`}>
        {all.isLoading ? <Skeleton className="h-64" /> : (
          <EfficiencyDashboard analysts={analysts} periodFacts={period ?? []} historyFacts={history ?? []}
            view={view} onView={setView} periodLabel={periodLabel} />
        )}
      </Section>

      <Section title="Análises de produtos com giro" meta="uma referência por card; clique para ver os detalhes">
        {analyses.isLoading ? <Skeleton className="h-24" /> : <ProductAnalyses items={analyses.data ?? []} onOpen={setOpenId} />}
      </Section>

      <Section title="Andamento da semana" meta="previsto × realizado, atividades diárias">
        {all.isLoading ? <Skeleton className="h-40" /> : (
          <WeekProgress analysts={analysts} facts={week ?? []} weekStart={startOfWeek(today)} workdays={settings.dias_uteis} />
        )}
      </Section>

      <Section title="Por atividade" meta="quais o time mais deixa de fazer">
        <ActivityBreakdown facts={period ?? []} weights={weights} onPick={(id) => actions.setTemplate(id)} />
      </Section>

      <TaskPanel taskId={openId} onClose={() => setOpenId(null)} />
    </>
  )
}
