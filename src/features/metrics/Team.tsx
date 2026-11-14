import { Link } from 'react-router-dom'
import { cx, StatusLabel, table } from '@/components/ui'
import { computeMetrics, dayProgress, groupBy, pct, streak, trend } from '@/lib/metrics'
import { addDays, dueText, fmtDay, fmtWeekday, localDate, todayISO } from '@/lib/dates'
import { effectiveStatus, isOpen } from '@/lib/status'
import type { EfficiencyWeights, Profile, TaskFact } from '@/lib/types'
import { PlanBar, RateBar, Sparkline } from './charts'

/** Atrasadas agora: abertas com prazo vencido + não feitas/bloqueadas recentes. */
export function overdueNow(facts: TaskFact[], now: number) {
  return facts
    .filter((f) => f.status !== 'pausada')
    .filter((f) => {
      const st = effectiveStatus(f, now)
      return st === 'nao_feita' || (f.status === 'bloqueada_gate') || (isOpen(f.status) && new Date(f.due_at).getTime() < now) || f.needs_rework
    })
    .sort((a, b) => b.due_at.localeCompare(a.due_at))
}

export function OverdueTable({ facts, now, onOpen }: { facts: TaskFact[]; now: number; onOpen: (id: string) => void }) {
  return (
    <div className={table.wrap}>
      <table className={cx(table.table, 'min-w-[640px]')}>
        <thead>
          <tr>
            <th className={table.th}>Prazo</th>
            <th className={table.th}>Analista</th>
            <th className={table.th}>Atividade</th>
            <th className={table.th}>Situação</th>
            <th className={table.thNum}>Situação do prazo</th>
          </tr>
        </thead>
        <tbody>
          {facts.map((f) => (
            <tr key={f.id} tabIndex={0} className={table.trClick} onClick={() => onOpen(f.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpen(f.id) }}>
              <td className={cx(table.td, 'whitespace-nowrap tabular-nums')}>{fmtDay(localDate(f.due_at))}</td>
              <td className={cx(table.td, 'text-md font-semibold')}>{f.full_name}</td>
              <td className={table.td}>{f.template_name} <span className="text-sm text-faint">{f.template_code}</span></td>
              <td className={table.td}>
                <StatusLabel status={effectiveStatus(f, now)} />
                {f.needs_rework && <span className="ml-2 text-sm text-bad">contestada, aguardando correção</span>}
              </td>
              <td className={cx(table.tdNum, 'whitespace-nowrap', dueText(localDate(f.due_at)).late ? 'text-bad' : 'text-muted')}>{dueText(localDate(f.due_at)).text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Comparativo entre analistas. */
export function AnalystComparison({ analysts, facts, history, weights, today }: {
  analysts: Profile[]; facts: TaskFact[]; history: TaskFact[]; weights: EfficiencyWeights; today: string
}) {
  const byUser = groupBy(facts, (f) => f.user_id)
  const histByUser = groupBy(history, (f) => f.user_id)
  const rows = analysts.map((a) => {
    const m = computeMetrics(byUser.get(a.id) ?? [], weights)
    const h = histByUser.get(a.id) ?? []
    const weekly = trend(h.filter((f) => f.expected || f.completed), 'semana', weights).slice(-8).map((t) => t.metrics.efficiency)
    return { a, m, streak: streak(h, today), weekly }
  }).sort((x, y) => (x.m.efficiency ?? 101) - (y.m.efficiency ?? 101))

  return (
    <div className={table.wrap}>
      <table className={cx(table.table, 'min-w-[820px]')}>
        <thead>
          <tr>
            <th className={table.th}>Analista</th>
            <th className={cx(table.th, 'w-40')}>Eficiência</th>
            <th className={table.thNum}>Conclusão</th>
            <th className={table.thNum}>Pontualidade</th>
            <th className={table.thNum}>Qualidade</th>
            <th className={table.thNum}>Não feitas</th>
            <th className={table.thNum}>Atrasos</th>
            <th className={table.thNum}>Gate</th>
            <th className={table.thNum}>Sequência</th>
            <th className={table.thNum}>8 semanas</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ a, m, streak: s, weekly }) => (
            <tr key={a.id} className={table.tr}>
              <td className={table.td}>
                <Link to={`/admin/equipe/${a.id}`} className="font-medium hover:text-accent hover:underline underline-offset-2">{a.full_name}</Link>
              </td>
              <td className={table.td}>
                <div className="flex items-center gap-2">
                  <span className="w-10 text-right font-mono text-sm tnum">{m.efficiency === null ? '—' : m.efficiency.toFixed(0)}</span>
                  <RateBar value={m.efficiency === null ? null : m.efficiency / 100} />
                </div>
              </td>
              <td className={table.tdNum}>{pct(m.completionRate)}</td>
              <td className={table.tdNum}>{pct(m.punctualityRate)}</td>
              <td className={table.tdNum}>{pct(m.qualityRate)}</td>
              <td className={cx(table.tdNum, m.counts.missed > 0 && 'text-bad')}>{m.counts.missed}</td>
              <td className={cx(table.tdNum, m.counts.late > 0 && 'text-warn')}>{m.counts.late}</td>
              <td className={table.tdNum}>{m.counts.gateBlockEvents}</td>
              <td className={table.tdNum}>{s}</td>
              <td className={table.tdNum}><Sparkline values={weekly} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Andamento da semana: previsto vs. realizado por dia e por analista. */
export function WeekProgress({ analysts, facts, weekStart, workdays }: {
  analysts: Profile[]; facts: TaskFact[]; weekStart: string; workdays: number[]
}) {
  const days = workdays.filter((d) => d <= 7).sort().map((d) => addDays(weekStart, d - 1))
  const today = todayISO()
  const byUser = groupBy(facts.filter((f) => f.frequency === 'diaria'), (f) => f.user_id)
  const max = Math.max(1, ...analysts.flatMap((a) => dayProgress(byUser.get(a.id) ?? [], days).map((d) => d.planned)))
  return (
    <div>
      <div className={table.wrap}>
        <table className={cx(table.table, 'min-w-[640px]')}>
          <thead>
            <tr>
              <th className={table.th}>Analista</th>
              {days.map((d) => (
                <th key={d} className={cx(table.th, d === today && 'text-accent')}>{fmtWeekday(d)} <span className="font-normal normal-case tnum">{fmtDay(d).split(' ')[0]}</span></th>
              ))}
              <th className={table.thNum}>Semana</th>
            </tr>
          </thead>
          <tbody>
            {analysts.map((a) => {
              const prog = dayProgress(byUser.get(a.id) ?? [], days)
              const planned = prog.filter((p) => p.day <= today).reduce((s, p) => s + p.planned, 0)
              const done = prog.reduce((s, p) => s + p.done, 0)
              return (
                <tr key={a.id} className={table.tr}>
                  <td className={cx(table.td, 'whitespace-nowrap font-medium')}>{a.full_name}</td>
                  {prog.map((p) => (
                    <td key={p.day} className={cx(table.td, 'w-28')}>
                      {p.planned ? (
                        <div className="space-y-1">
                          <PlanBar planned={p.planned} done={p.done} onTime={p.onTime} max={max}
                            label={`${a.full_name}, ${fmtDay(p.day)}: ${p.done} de ${p.planned} concluídas, ${p.onTime} no prazo`} />
                          <span className={cx('block font-mono text-2xs tnum', p.day > today ? 'text-faint' : 'text-muted')}>
                            {p.day > today ? `${p.planned} previstas` : `${p.done}/${p.planned}`}
                          </span>
                        </div>
                      ) : <span className="text-faint">·</span>}
                    </td>
                  ))}
                  <td className={cx(table.tdNum, 'font-mono text-sm')}>{done}/{planned}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <li className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-4 rounded-full bg-accent" />Concluída no prazo</li>
        <li className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-4 rounded-full bg-warn" />Concluída com atraso</li>
        <li className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-4 rounded-full bg-subtle ring-1 ring-line" />Prevista, não concluída</li>
      </ul>
    </div>
  )
}
