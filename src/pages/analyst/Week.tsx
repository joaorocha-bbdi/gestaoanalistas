import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { Button, ErrorNote, IconButton, PageHeader, Section, Skeleton, StatusLabel, table, cx } from '@/components/ui'
import { TaskPanel } from '@/features/tasks/TaskPanel'
import { StatusLegend, WeekGrid } from '@/features/tasks/WeekGrid'
import { useSettings, useTasks } from '@/data/queries'
import { addDays, dueText, fmtDay, localDate, startOfWeek, todayISO } from '@/lib/dates'
import { useHotkeys, useNow, useSearchParamState } from '@/lib/hooks'
import { effectiveStatus } from '@/lib/status'
import type { TaskInstance } from '@/lib/types'

export default function Week() {
  const { profile } = useAuth()
  return <WeekView userId={profile?.id} title="Minha semana" />
}

/** Também usada pelo gestor no detalhe do analista. */
export function WeekView({ userId, title, embedded }: { userId?: string; title: string; embedded?: boolean }) {
  const now = useNow()
  const settings = useSettings()
  const [wkParam, setWk] = useSearchParamState('semana')
  const [openId, setOpenId] = useSearchParamState('t')
  const thisWeek = startOfWeek(todayISO())
  const week = wkParam ?? thisWeek
  const tasks = useTasks({ userId, from: week, to: addDays(week, 6), enabled: !!userId })

  useHotkeys({ h: () => setWk(addDays(week, -7)), l: () => setWk(addDays(week, 7)) }, !openId)

  // Semanais/mensais com vencimento nesta semana entram pela data de vencimento.
  const list = tasks.data ?? []
  const late = list.filter((t) => {
    const st = effectiveStatus(t, now)
    return st === 'nao_feita' || st === 'concluida_atraso' || st === 'bloqueada_gate' || t.needs_rework
  })

  const nav = (
    <div className="flex items-center gap-1">
      <IconButton label="Semana anterior (h)" onClick={() => setWk(addDays(week, -7))}><ChevronLeft className="size-4" /></IconButton>
      <span className="min-w-40 text-center text-sm tnum">{fmtDay(week)} – {fmtDay(addDays(week, 4))}</span>
      <IconButton label="Próxima semana (l)" onClick={() => setWk(addDays(week, 7))}><ChevronRight className="size-4" /></IconButton>
      {week !== thisWeek && <Button size="sm" variant="ghost" onClick={() => setWk(null)}>Esta semana</Button>}
    </div>
  )

  const Header = embedded
    ? <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{title}</h2>{nav}</div>
    : <PageHeader title={title} actions={nav} />

  return (
    <>
      {Header}
      <ErrorNote error={tasks.error} />
      {tasks.isLoading ? <Skeleton className="h-48" /> : (
        <>
          <WeekGrid tasks={list} weekStart={week} now={now} onOpen={setOpenId} workdays={settings.dias_uteis} />
          <div className="mt-4"><StatusLegend /></div>

          <Section title="Atrasos e pendências da semana" meta={late.length ? String(late.length) : undefined} className="mt-10">
            {late.length ? <LateTable tasks={late} now={now} onOpen={setOpenId} /> : (
              <p className="text-sm text-muted">Nada atrasado nesta semana.</p>
            )}
          </Section>
        </>
      )}
      <TaskPanel taskId={openId} onClose={() => setOpenId(null)} />
    </>
  )
}

function LateTable({ tasks, now, onOpen }: { tasks: TaskInstance[]; now: number; onOpen: (id: string) => void }) {
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr>
            <th className={table.th}>Dia</th>
            <th className={table.th}>Atividade</th>
            <th className={table.th}>Situação</th>
            <th className={table.thNum}>Prazo</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} tabIndex={0} className={table.trClick} onClick={() => onOpen(t.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpen(t.id) }}>
              <td className={cx(table.td, 'tnum text-muted')}>{fmtDay(t.ref_date)}</td>
              <td className={table.td}>{t.template_snapshot.name}</td>
              <td className={table.td}>
                <StatusLabel status={effectiveStatus(t, now)} />
                {t.needs_rework && <span className="ml-2 text-sm text-bad">· contestada</span>}
              </td>
              <td className={cx(table.tdNum, dueText(localDate(t.due_at)).late && 'text-bad')}>{dueText(localDate(t.due_at)).text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
