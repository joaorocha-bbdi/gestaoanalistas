import { useAuth } from '@/auth/AuthProvider'
import { ErrorNote, PageHeader, Section, Skeleton } from '@/components/ui'
import { FilterBar, useFilters } from '@/features/metrics/Filters'
import { MetricStrip } from '@/features/metrics/MetricStrip'
import { ActivityBreakdown, EfficiencyTrend } from '@/features/metrics/Breakdowns'
import { useFacts, useSettings } from '@/data/queries'
import { computeMetrics, streak } from '@/lib/metrics'
import { coveringRange, sliceFacts } from '@/lib/perf'
import { addDays, fmtDay, todayISO } from '@/lib/dates'

export default function Performance() {
  const { profile } = useAuth()
  return <PerformanceView userId={profile?.id} title="Meu desempenho" />
}

/** Também usada pelo gestor no detalhe do analista. */
export function PerformanceView({ userId, title, embedded }: { userId?: string; title: string; embedded?: boolean }) {
  const settings = useSettings()
  const [f, actions] = useFilters('30d')
  const today = todayISO()
  // Uma busca só: período escolhido + janela fixa de 12 semanas (sequência e tendência).
  const historyRange = { from: addDays(today, -84), to: today }
  const all = useFacts({ ...coveringRange([{ from: f.from, to: f.to }, historyRange]), userId })
  const facts = {
    data: all.isLoading ? undefined : sliceFacts(all.data, f.from, f.to).filter((x) => !f.templateId || x.template_id === f.templateId),
    isLoading: all.isLoading, error: all.error,
  }
  const history = { data: all.isLoading ? undefined : sliceFacts(all.data, historyRange.from, historyRange.to), isLoading: all.isLoading }
  const weights = settings.pesos_eficiencia

  const m = computeMetrics(facts.data ?? [], weights)
  const s = streak(history.data ?? [], today)

  return (
    <>
      {embedded ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          <FilterBar state={f} actions={actions} showUser={false} />
        </div>
      ) : (
        <PageHeader title={title} meta={`${fmtDay(f.from)} – ${fmtDay(f.to)}`}>
          <FilterBar state={f} actions={actions} showUser={false} />
        </PageHeader>
      )}
      <ErrorNote error={facts.error} />
      {facts.isLoading ? <Skeleton className="h-24" /> : <MetricStrip m={m} streak={s} />}

      <Section title="Eficiência por semana" meta="últimas 12 semanas" className="mt-10">
        {history.isLoading ? <Skeleton className="h-44" /> : <EfficiencyTrend facts={history.data ?? []} weights={weights} by="semana" />}
      </Section>

      <Section title="Por atividade" meta="menor conclusão primeiro">
        <ActivityBreakdown facts={facts.data ?? []} weights={weights} onPick={(id) => actions.setTemplate(id)} />
      </Section>
    </>
  )
}
