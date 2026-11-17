import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarOff, Check, Lock, Undo2 } from 'lucide-react'
import { Button, cx, Dialog, EmptyState, table } from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { useDaysOff, useSetDayOff } from '@/data/queries'
import { DayOffDialog } from '@/features/daysoff/DaysOff'
import { fmtDateTime, fmtDay, fmtDayOf } from '@/lib/dates'
import { blockPoints, blockProgress } from '@/lib/sequence'
import { must, supabase } from '@/lib/supabase'
import type { Payload, Profile, TaskFact } from '@/lib/types'

/**
 * Avanço de hoje: uma linha por analista, uma coluna por bloco da sequência.
 * Mostra o progresso por etapas e quem está bloqueado esperando o bloco anterior.
 */
export function DayBoard({ analysts, facts, today, onOpen }: {
  analysts: Profile[]; facts: TaskFact[]; today: string; onOpen: (taskId: string) => void
}) {
  const toast = useToast()
  const daysOffQ = useDaysOff({ from: today, to: today })
  const setDayOff = useSetDayOff()
  const [disabling, setDisabling] = useState<Profile | null>(null)
  const offToday = new Map((daysOffQ.data ?? []).map((d) => [d.user_id, d]))

  const todays = facts.filter((f) => f.ref_date === today && f.frequency === 'diaria' && f.status !== 'pausada' && f.sequential)
  const columns = [...new Map(todays.map((f) => [f.template_id, { id: f.template_id, name: f.template_name, order: f.sort_order }])).values()]
    .sort((a, b) => a.order - b.order)
  const anyOff = analysts.some((a) => offToday.has(a.id))
  if (!columns.length && !anyOff) return <EmptyState title="Sem blocos hoje">Não há atividades diárias em sequência geradas para hoje.</EmptyState>

  const reactivate = (a: Profile) => setDayOff.mutate({ userId: a.id, day: today, off: false },
    { onSuccess: () => toast(`Dia de hoje reativado para ${a.full_name}.`) })

  return (
    <div className={table.wrap}>
      <table className={cx(table.table, 'min-w-[820px]')}>
        <thead>
          <tr>
            <th className={table.th}>Analista</th>
            {columns.map((c, i) => <th key={c.id} className={table.th}>Bloco {i + 1}: {c.name}</th>)}
            <th className={table.thNum}>Dia</th>
          </tr>
        </thead>
        <tbody>
          {analysts.map((a) => {
            const off = offToday.get(a.id)
            const nameCell = (
              <td className={cx(table.td, 'whitespace-nowrap')}>
                <span className={cx('block text-md font-semibold', off && 'text-muted')}>{a.full_name}</span>
                {off ? (
                  <button type="button" disabled={setDayOff.isPending} onClick={() => reactivate(a)}
                    className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted underline-offset-2 hover:text-ink hover:underline">
                    <Undo2 className="size-3.5" aria-hidden />Reativar o dia
                  </button>
                ) : (
                  <button type="button" onClick={() => setDisabling(a)}
                    className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted underline-offset-2 hover:text-ink hover:underline">
                    <CalendarOff className="size-3.5" aria-hidden />Desativar o dia
                  </button>
                )}
              </td>
            )
            if (off) {
              return (
                <tr key={a.id} className={table.tr}>
                  {nameCell}
                  <td className={table.td} colSpan={Math.max(columns.length, 1)}>
                    <span className="inline-flex items-center gap-1.5 text-sm text-muted">
                      <CalendarOff className="size-4" aria-hidden />
                      Dia desativado: as diárias de hoje não contam.{off.reason ? ` Motivo: ${off.reason}` : ''}
                    </span>
                  </td>
                  <td className={cx(table.tdNum, 'text-muted')}>—</td>
                </tr>
              )
            }
            const mine = todays.filter((f) => f.user_id === a.id)
            let blocked = false
            let points = 0, total = 0
            const cells = columns.map((c) => {
              const f = mine.find((x) => x.template_id === c.id)
              if (!f) return { c, f: undefined, locked: false }
              const locked = blocked && !f.completed
              if (!f.completed) blocked = true
              const p = blockPoints(f.steps_total, f.steps_done, f.completed)
              points += p.done
              total += p.total
              return { c, f, locked }
            })
            const day = total ? Math.round((points / total) * 100) : 0
            return (
              <tr key={a.id} className={table.tr}>
                {nameCell}
                {!columns.length && <td className={cx(table.td, 'text-faint')}>sem blocos hoje</td>}
                {cells.map(({ c, f, locked }) => (
                  <td key={c.id} className={cx(table.td, 'min-w-44')}>
                    {!f ? <span className="text-faint">sem tarefa</span> : (
                      <button type="button" onClick={() => onOpen(f.id)} className="block w-full rounded text-left hover:bg-hover" aria-label={`${a.full_name}, ${c.name}`}>
                        {locked ? (
                          <span className="inline-flex items-center gap-1.5 text-sm text-muted"><Lock className="size-4" aria-hidden />Bloqueado</span>
                        ) : f.completed ? (
                          <span className="inline-flex items-center gap-1.5 text-sm"><Check className="size-4 text-ok" strokeWidth={3} aria-hidden />Concluído</span>
                        ) : (
                          <span className="block space-y-1">
                            <span className="flex items-center gap-2">
                              <span className="h-2 w-24 overflow-hidden rounded-sm bg-subtle">
                                <span className="block h-full bg-signal" style={{ width: `${blockProgress(f.steps_total, f.steps_done, false) * 100}%` }} />
                              </span>
                              <span className="text-sm tabular-nums">{Math.round(blockProgress(f.steps_total, f.steps_done, false) * 100)}%</span>
                            </span>
                            <span className="block text-xs text-muted tabular-nums">{f.steps_done} de {f.steps_total} etapas</span>
                          </span>
                        )}
                      </button>
                    )}
                  </td>
                ))}
                <td className={cx(table.tdNum, 'font-display text-xl font-semibold')}>{day}%</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {disabling && <DayOffDialog analyst={disabling} day={today} onClose={() => setDisabling(null)} />}
    </div>
  )
}

interface Analysis {
  id: string
  ref_date: string
  submitted_at: string | null
  payload: Payload
  user: { full_name: string; active?: boolean } | null
}

/** Análises que os analistas enviaram no check de produtos com giro (vão direto ao gestor). */
export function useProductAnalyses(limit = 6) {
  return useQuery({
    queryKey: ['analises', limit],
    queryFn: async () => must(await supabase.from('task_instances')
      .select('id, ref_date, submitted_at, payload, user:profiles!user_id(full_name, active)')
      .eq('template_snapshot->>code', 'D3').in('status', ['concluida_prazo', 'concluida_atraso'])
      .order('submitted_at', { ascending: false }).limit(limit)) as unknown as Analysis[],
    // Usuário desativado não aparece para o gestor.
    select: (rows) => rows.filter((r) => r.user?.active !== false),
  })
}

const yesNo = (v: unknown) => (v === true ? 'Sim' : v === false ? 'Não' : '—')

/**
 * Análises do check de produtos com giro em cards: um card por referência.
 * Clicar abre um modal com todos os detalhes do que o analista registrou.
 */
export function ProductAnalyses({ items, onOpen }: { items: Analysis[]; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState<{ a: Analysis; p: Payload } | null>(null)
  const cards = items.flatMap((a) =>
    ((Array.isArray(a.payload.produtos) ? a.payload.produtos : []) as Payload[]).map((p, i) => ({ key: `${a.id}:${i}`, a, p })))
  if (!cards.length) return <EmptyState title="Nenhuma análise enviada ainda">As análises do check de produtos com giro aparecem aqui assim que os analistas concluírem o bloco.</EmptyState>
  return (
    <>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {cards.map(({ key, a, p }) => (
          <li key={key}>
            <button type="button" onClick={() => setOpen({ a, p })}
              className="flex h-full w-full flex-col rounded-lg border border-line bg-surface px-4 py-3 text-left hover:border-ink focus-visible:border-ink">
              <span className="font-mono text-xl font-semibold leading-6">{String(p.sku ?? '—')}</span>
              <span className="mt-1 truncate text-xs text-muted">{a.user?.full_name ?? 'Analista'}, {a.submitted_at ? fmtDayOf(a.submitted_at) : fmtDay(a.ref_date)}</span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <Dialog open onClose={() => setOpen(null)} title={`Referência ${String(open.p.sku ?? '')}`}
          footer={<><Button variant="ghost" onClick={() => setOpen(null)}>Fechar</Button>
            <Button onClick={() => { const id = open.a.id; setOpen(null); onOpen(id) }}>Abrir a atividade</Button></>}>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[12rem_1fr]">
            {([
              ['Analista', open.a.user?.full_name ?? '—'],
              ['Enviada em', open.a.submitted_at ? fmtDateTime(open.a.submitted_at) : fmtDay(open.a.ref_date)],
              ['Taxa de conversão', String(open.p.conversao ?? '—')],
              ['Kit de fotos precisa ser renovado?', yesNo(open.p.renovar_fotos)],
              ['Descrição precisa de alteração?', yesNo(open.p.alterar_descricao)],
              ['Compatibilidades corretas?', yesNo(open.p.compat_ok)],
              ['Pontos que precisam de melhoria', String(open.p.pontos_melhoria ?? '—')],
              ['Análise do produto', String(open.p.analise ?? '—')],
            ] as const).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-sm text-muted">{k}</dt>
                <dd className="whitespace-pre-wrap break-words">{v}</dd>
              </div>
            ))}
          </dl>
        </Dialog>
      )}
    </>
  )
}
