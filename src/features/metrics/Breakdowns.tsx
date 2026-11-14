import { cx, table } from '@/components/ui'
import { computeMetrics, groupBy, pct, trend } from '@/lib/metrics'
import { fmtDay, fmtMonth } from '@/lib/dates'
import type { EfficiencyWeights, TaskFact } from '@/lib/types'
import { LineChart, RateBar } from './charts'

/** Por atividade, da mais negligenciada para a menos. */
export function ActivityBreakdown({ facts, weights, onPick }: { facts: TaskFact[]; weights: EfficiencyWeights; onPick?: (templateId: string) => void }) {
  const rows = [...groupBy(facts.filter((f) => f.status !== 'pausada'), (f) => f.template_id).entries()]
    .map(([id, xs]) => ({ id, name: xs[0].template_name, code: xs[0].template_code, m: computeMetrics(xs, weights) }))
    .filter((r) => r.m.counts.expected > 0)
    .sort((a, b) => (a.m.completionRate ?? 1) - (b.m.completionRate ?? 1))
  if (!rows.length) return <p className="text-sm text-muted">Sem atividades vencidas no período.</p>
  return (
    <div className={table.wrap}>
      <table className={cx(table.table, 'min-w-[640px]')}>
        <thead>
          <tr>
            <th className={table.th}>Atividade</th>
            <th className={cx(table.th, 'w-44')}>Conclusão</th>
            <th className={table.thNum}>Esperadas</th>
            <th className={table.thNum}>Não feitas</th>
            <th className={table.thNum}>Pontualidade</th>
            <th className={table.thNum}>Qualidade</th>
            <th className={table.thNum}>Gate barrou</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={onPick ? table.trClick : table.tr} onClick={() => onPick?.(r.id)}>
              <td className={table.td}><span className="font-medium">{r.name}</span> <span className="font-mono text-2xs text-faint">{r.code}</span></td>
              <td className={table.td}>
                <div className="flex items-center gap-2">
                  <span className="w-11 text-right font-mono text-sm tnum">{pct(r.m.completionRate)}</span>
                  <RateBar value={r.m.completionRate} />
                </div>
              </td>
              <td className={table.tdNum}>{r.m.counts.expected}</td>
              <td className={cx(table.tdNum, r.m.counts.missed > 0 && 'text-bad')}>{r.m.counts.missed}</td>
              <td className={table.tdNum}>{pct(r.m.punctualityRate)}</td>
              <td className={table.tdNum}>{pct(r.m.qualityRate)}</td>
              <td className={table.tdNum}>{r.m.counts.gateTasks ? `${r.m.counts.gateBlockedTasks}/${r.m.counts.gateTasks}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function EfficiencyTrend({ facts, weights, by }: { facts: TaskFact[]; weights: EfficiencyWeights; by: 'semana' | 'mes' }) {
  const series = trend(facts.filter((f) => f.expected || f.completed), by, weights)
  if (series.length < 2) {
    return <p className="text-sm text-muted">É preciso mais de {by === 'semana' ? 'uma semana' : 'um mês'} de dados no período para ver tendência.</p>
  }
  return (
    <LineChart
      ariaLabel={`Índice de eficiência por ${by}`}
      format={(v) => v.toFixed(1).replace('.', ',')}
      points={series.map((s) => ({
        x: s.period,
        label: by === 'semana' ? fmtDay(s.period) : fmtMonth(s.period).split(' ')[0],
        y: s.metrics.efficiency,
        detail: `Conclusão ${pct(s.metrics.completionRate)} · pontualidade ${pct(s.metrics.punctualityRate)}`,
      }))}
    />
  )
}
