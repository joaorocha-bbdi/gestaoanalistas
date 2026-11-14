import { cx, StatusIcon, table } from '@/components/ui'
import { addDays, fmtDay, fmtWeekday, todayISO } from '@/lib/dates'
import { effectiveStatus, STATUS_META } from '@/lib/status'
import type { TaskInstance } from '@/lib/types'
import { periodLabel } from './taskText'

/** Grade atividade × dia (seg–sex) com o status de cada tarefa. */
export function WeekGrid({ tasks, weekStart, now, onOpen, workdays = [1, 2, 3, 4, 5] }: {
  tasks: TaskInstance[]
  weekStart: string
  now: number
  onOpen: (id: string) => void
  workdays?: number[]
}) {
  const days = workdays.filter((d) => d <= 7).sort().map((d) => addDays(weekStart, d - 1))
  const today = todayISO()
  const daily = tasks.filter((t) => t.template_snapshot.frequency === 'diaria')
  const periodic = tasks.filter((t) => t.template_snapshot.frequency !== 'diaria')

  const templates = new Map<string, { name: string; code: string | null; order: number }>()
  for (const t of daily) {
    templates.set(t.template_id, { name: t.template_snapshot.name, code: t.template_snapshot.code, order: t.template_snapshot.sort_order ?? 0 })
  }
  const rows = [...templates.entries()].sort((a, b) => a[1].order - b[1].order || a[1].name.localeCompare(b[1].name))
  const cell = (tid: string, day: string) => daily.find((t) => t.template_id === tid && t.ref_date === day)

  return (
    <div className="space-y-8">
      <div className={table.wrap}>
        <table className={cx(table.table, 'min-w-[560px]')}>
          <thead>
            <tr>
              <th className={table.th}>Atividade</th>
              {days.map((d) => (
                <th key={d} className={cx(table.th, 'w-20 text-center', d === today && 'text-accent')}>
                  {fmtWeekday(d)} <span className="font-normal normal-case tnum">{fmtDay(d).split(' ')[0]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([tid, info]) => (
              <tr key={tid} className={table.tr}>
                <td className={table.td}>
                  <span className="font-medium">{info.name}</span>
                  <span className="ml-2 font-mono text-2xs text-faint">{info.code}</span>
                </td>
                {days.map((d) => {
                  const t = cell(tid, d)
                  if (!t) return <td key={d} className={cx(table.td, 'text-center text-faint')} aria-label="Sem tarefa">·</td>
                  const st = effectiveStatus(t, now)
                  return (
                    <td key={d} className={cx(table.td, 'text-center', d === today && 'bg-accent-soft/40')}>
                      <button
                        onClick={() => onOpen(t.id)}
                        className="inline-flex size-8 items-center justify-center rounded hover:bg-hover"
                        title={`${info.name} · ${fmtDay(d)} · ${STATUS_META[st].label}`}
                        aria-label={`${info.name}, ${fmtDay(d)}: ${STATUS_META[st].label}`}
                      >
                        <StatusIcon status={st} className="size-[18px]" />
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={days.length + 1} className={cx(table.td, 'py-6 text-muted')}>Nenhuma atividade diária nesta semana.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {periodic.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-medium text-muted">Semanais e mensais</h3>
          <ul className="divide-y divide-line border-y border-line">
            {periodic.map((t) => {
              const st = effectiveStatus(t, now)
              return (
                <li key={t.id}>
                  <button onClick={() => onOpen(t.id)} className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-hover sm:px-2">
                    <StatusIcon status={st} />
                    <span className="flex-1 truncate">{t.template_snapshot.name}</span>
                    <span className="hidden text-sm text-muted sm:inline">{periodLabel(t)}</span>
                    <span className="text-sm text-muted">{STATUS_META[st].short}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

export function StatusLegend() {
  const items = ['concluida_prazo', 'concluida_atraso', 'bloqueada_gate', 'nao_feita', 'em_andamento', 'pendente'] as const
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legenda">
      {items.map((s) => (
        <li key={s} className="inline-flex items-center gap-1.5"><StatusIcon status={s} className="size-3.5" />{STATUS_META[s].label}</li>
      ))}
    </ul>
  )
}
