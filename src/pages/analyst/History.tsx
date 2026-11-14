import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/auth/AuthProvider'
import { EmptyState, ErrorNote, PageHeader, ReviewLabel, Select, Skeleton, StatusLabel, table, cx } from '@/components/ui'
import { TaskPanel } from '@/features/tasks/TaskPanel'
import { useTasks } from '@/data/queries'
import { addDays, fmtDay, fmtDayOf, todayISO } from '@/lib/dates'
import { useNow, useSearchParamState } from '@/lib/hooks'
import { effectiveStatus, STATUS_META } from '@/lib/status'
import { must, supabase } from '@/lib/supabase'
import type { Review, TaskStatus } from '@/lib/types'

const RANGES = [
  { v: '30', label: 'Últimos 30 dias' },
  { v: '90', label: 'Últimos 90 dias' },
  { v: '365', label: 'Último ano' },
]

export default function History() {
  const { profile } = useAuth()
  const now = useNow()
  const today = todayISO()
  const [range, setRange] = useState('30')
  const [status, setStatus] = useState<TaskStatus | 'contestada' | ''>('')
  const [tpl, setTpl] = useState('')
  const [openId, setOpenId] = useSearchParamState('t')
  const from = addDays(today, -Number(range))

  const tasks = useTasks({ userId: profile?.id, from, to: today, enabled: !!profile })
  const reviews = useQuery({
    queryKey: ['reviews', 'minhas', from],
    enabled: !!profile,
    queryFn: async () => must(await supabase.from('reviews').select('*').gte('created_at', `${from}T00:00:00-03:00`)
      .order('created_at', { ascending: false })) as Review[],
  })
  const lastReview = useMemo(() => {
    const m = new Map<string, Review>()
    for (const r of reviews.data ?? []) if (!m.has(r.task_id)) m.set(r.task_id, r)
    return m
  }, [reviews.data])

  const all = (tasks.data ?? []).filter((t) => t.ref_date < today || new Date(t.due_at).getTime() < now)
  const templates = [...new Map(all.map((t) => [t.template_id, t.template_snapshot.name])).entries()]
  const rows = all
    .filter((t) => !tpl || t.template_id === tpl)
    .filter((t) => !status || (status === 'contestada'
      ? lastReview.get(t.id)?.status === 'contestada' || t.needs_rework
      : effectiveStatus(t, now) === status))
    .sort((a, b) => b.due_at.localeCompare(a.due_at))

  return (
    <>
      <PageHeader title="Meu histórico" meta={`${rows.length} atividades`}>
        <div className="flex flex-wrap gap-2">
          <Select aria-label="Período" className="w-auto" value={range} onChange={(e) => setRange(e.target.value)}>
            {RANGES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
          </Select>
          <Select aria-label="Situação" className="w-auto" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
            <option value="">Todas as situações</option>
            {(['concluida_prazo', 'concluida_atraso', 'bloqueada_gate', 'nao_feita', 'pausada'] as TaskStatus[])
              .map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
            <option value="contestada">Contestadas na revisão</option>
          </Select>
          <Select aria-label="Atividade" className="w-auto" value={tpl} onChange={(e) => setTpl(e.target.value)}>
            <option value="">Todas as atividades</option>
            {templates.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
        </div>
      </PageHeader>

      <ErrorNote error={tasks.error} />
      {tasks.isLoading ? <Skeleton className="h-64" /> : rows.length === 0 ? (
        <EmptyState title="Nada encontrado com esses filtros">Tente ampliar o período ou limpar a situação.</EmptyState>
      ) : (
        <div className={table.wrap}>
          <table className={cx(table.table, 'min-w-[720px]')}>
            <thead>
              <tr>
                <th className={table.th}>Dia</th>
                <th className={table.th}>Atividade</th>
                <th className={table.th}>Situação</th>
                <th className={table.th}>Enviada</th>
                <th className={table.th}>Revisão</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const r = lastReview.get(t.id)
                return (
                  <tr key={t.id} tabIndex={0} className={table.trClick} onClick={() => setOpenId(t.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(t.id) }}>
                    <td className={cx(table.td, 'whitespace-nowrap tnum text-muted')}>{fmtDay(t.ref_date)}</td>
                    <td className={table.td}>{t.template_snapshot.name}</td>
                    <td className={table.td}><StatusLabel status={effectiveStatus(t, now)} /></td>
                    <td className={cx(table.td, 'whitespace-nowrap text-sm text-muted')}>{t.submitted_at ? fmtDayOf(t.submitted_at) : '—'}</td>
                    <td className={table.td}>
                      <ReviewLabel status={t.review_status} />
                      {r?.status === 'contestada' && r.reason && <p className="mt-0.5 max-w-xs text-sm text-muted">{r.reason}</p>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <TaskPanel taskId={openId} onClose={() => setOpenId(null)} />
    </>
  )
}
