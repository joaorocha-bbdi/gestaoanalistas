import { Link } from 'react-router-dom'
import { cx, InfoTip, Segmented } from '@/components/ui'
import { efficiencyPercent, groupBy } from '@/lib/metrics'
import { fmtDay, fmtMonth, startOfMonth, startOfWeek } from '@/lib/dates'
import type { Profile, TaskFact } from '@/lib/types'
import { LineChart } from './charts'

export type ChartView = 'semana' | 'mes' | 'total'

const pctText = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`)

function counts(facts: TaskFact[]) {
  const expected = facts.filter((f) => f.status !== 'pausada' && f.expected)
  return { expected: expected.length, done: expected.filter((f) => f.completed).length }
}

/** Série do gráfico: semana a semana (últimas 12), mês a mês (últimos 12) ou tudo, semana a semana. */
export function efficiencySeries(facts: TaskFact[], view: ChartView) {
  const key = (f: TaskFact) => (view === 'mes' ? startOfMonth(f.ref_date) : startOfWeek(f.ref_date))
  const groups = groupBy(facts.filter((f) => f.status !== 'pausada' && f.expected), key)
  const keys = [...groups.keys()].sort()
  const shown = view === 'total' ? keys : keys.slice(-12)
  return shown.map((k) => ({ period: k, value: efficiencyPercent(groups.get(k)!), ...counts(groups.get(k)!) }))
}

/**
 * Eficiência em porcentagem, simples de ler: concluídas ÷ esperadas.
 * Equipe e cada analista no período filtrado; gráfico por semana, por mês ou de todo o registro.
 */
export function EfficiencyDashboard({ analysts, periodFacts, historyFacts, view, onView, periodLabel }: {
  analysts: Profile[]
  periodFacts: TaskFact[]
  historyFacts: TaskFact[]
  view: ChartView
  onView: (v: ChartView) => void
  periodLabel: string
}) {
  const team = efficiencyPercent(periodFacts)
  const teamCounts = counts(periodFacts)
  const byUser = groupBy(periodFacts, (f) => f.user_id)
  const people = analysts.map((a) => {
    const xs = byUser.get(a.id) ?? []
    return { a, value: efficiencyPercent(xs), ...counts(xs) }
  }).sort((x, y) => (y.value ?? -1) - (x.value ?? -1))
  const series = efficiencySeries(historyFacts, view)

  return (
    <div className="space-y-10">
      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[18rem_1fr]">
        <div>
          <div className="flex items-center gap-1 text-md">
            Eficiência da equipe
            <InfoTip label="Como é calculado">
              <span className="block font-semibold">Eficiência</span>
              <span className="mt-1 block text-sm">Atividades concluídas ÷ atividades esperadas × 100%.</span>
              <span className="mt-1.5 block text-muted">Esperada = já venceu ou já foi concluída. Concluir com atraso também conta como feito.</span>
            </InfoTip>
          </div>
          <p className="font-display text-5xl font-semibold tabular-nums">{pctText(team)}</p>
          <div className="mt-3 h-3 overflow-hidden rounded-sm bg-subtle" aria-hidden>
            <div className="h-full bg-signal" style={{ width: `${team ?? 0}%` }} />
          </div>
          <p className="mt-2 text-sm text-muted tabular-nums">{teamCounts.done} de {teamCounts.expected} atividades concluídas, {periodLabel}</p>
        </div>

        <div>
          <p className="mb-2 text-md">Eficiência de cada analista</p>
          {people.length === 0 ? <p className="text-sm text-muted">Nenhum analista ativo.</p> : (
            <ul className="divide-y divide-line border-y border-line">
              {people.map(({ a, value, done, expected }) => (
                <li key={a.id}>
                  <Link to={`/admin/equipe/${a.id}`} className="grid grid-cols-[minmax(0,10rem)_1fr_3.5rem] items-center gap-4 py-2.5 hover:bg-hover sm:px-2">
                    <span className="truncate font-medium">{a.full_name}</span>
                    <span className="flex items-center gap-3">
                      <span className="h-2.5 flex-1 overflow-hidden rounded-sm bg-subtle" aria-hidden>
                        <span className={cx('block h-full', value !== null && value < 70 ? 'bg-warn' : 'bg-signal')} style={{ width: `${value ?? 0}%` }} />
                      </span>
                      <span className="hidden w-24 text-right text-xs text-muted tabular-nums sm:inline">{done} de {expected}</span>
                    </span>
                    <span className="text-right font-display text-xl font-semibold tabular-nums">{pctText(value)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-md">Eficiência da equipe ao longo do tempo</p>
          <Segmented<ChartView> size="sm" ariaLabel="Visão do gráfico" value={view} onChange={onView}
            options={[{ value: 'semana', label: 'Por semana' }, { value: 'mes', label: 'Por mês' }, { value: 'total', label: 'Todo o período' }]} />
        </div>
        {series.length < 2 ? (
          <p className="text-sm text-muted">Ainda não há {view === 'mes' ? 'meses' : 'semanas'} suficientes registrados para desenhar o gráfico.</p>
        ) : (
          <LineChart
            ariaLabel={`Eficiência da equipe ${view === 'mes' ? 'por mês' : 'por semana'}`}
            format={(v) => `${Math.round(v)}%`}
            points={series.map((s) => ({
              x: s.period,
              label: view === 'mes' ? fmtMonth(s.period).split(' ')[0] : fmtDay(s.period),
              y: s.value,
              detail: `${s.done} de ${s.expected} concluídas`,
            }))}
          />
        )}
      </div>
    </div>
  )
}
