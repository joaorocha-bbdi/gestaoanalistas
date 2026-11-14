import { useMemo, useState } from 'react'
import { Check, Clock, Plus, X } from 'lucide-react'
import { Button, cx, EmptyState, ErrorNote, PageHeader, Segmented, Skeleton, table } from '@/components/ui'
import { TaskPanel } from '@/features/tasks/TaskPanel'
import { TestRequestDialog } from '@/features/tests/TestRequestDialog'
import { useItemReviews, useTestRequests, useTestsQueue } from '@/data/queries'
import { fmtDay, fmtDayOf, fmtMonth, todayISO } from '@/lib/dates'
import { useSearchParamState } from '@/lib/hooks'
import { ITEM_STATE_LABEL, itemStatus, reviewableGroups, type ItemState } from '@/lib/itemReviews'
import type { Payload, TestRequest } from '@/lib/types'

type Phase = 'agendado' | 'em_teste' | 'encerrado' | 'sem_data'
const PHASE_LABEL: Record<Phase, string> = {
  agendado: 'Ainda não começou', em_teste: 'Em teste', encerrado: 'Prazo encerrado', sem_data: '—',
}

function phaseOf(inicio: string | undefined, fim: string | undefined, today: string): Phase {
  if (!inicio || !fim) return 'sem_data'
  if (today < inicio) return 'agendado'
  if (today > fim) return 'encerrado'
  return 'em_teste'
}

const isoDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)

interface Row {
  key: string
  origin: string
  sku: string
  what: string
  why: string | null
  inicio?: string
  fim?: string
  state: ItemState
  reason: string | null
  phase: Phase
  sortKey: string
  request?: TestRequest
  taskId?: string
}

/**
 * Testes do analista: as solicitações avulsas (bloco opcional) e as referências do
 * marco mensal, com o que testar, por quê, período e a decisão do gestor.
 */
export default function Tests() {
  const today = todayISO()
  const reqQ = useTestRequests()
  const monthlyQ = useTestsQueue()
  const tasks = (monthlyQ.data ?? []).filter((t) => reviewableGroups(t.template_snapshot.fields).length > 0)
  const itemQ = useItemReviews(tasks.map((t) => t.id))
  const [filter, setFilter] = useState<'todos' | 'em_teste' | ItemState>('todos')
  const [openId, setOpenId] = useSearchParamState('t')
  const [dialog, setDialog] = useState<{ request: TestRequest | null } | null>(null)

  const rows = useMemo<Row[]>(() => {
    const fromRequests: Row[] = (reqQ.data ?? []).map((r) => ({
      key: r.id, origin: `Solicitado em ${fmtDayOf(r.created_at)}`, sku: r.sku, what: r.analysis, why: r.explanation,
      inicio: r.start_date, fim: r.end_date, state: r.status, reason: r.review_reason,
      phase: phaseOf(r.start_date, r.end_date, today), sortKey: r.start_date, request: r,
    }))
    const fromMonthly: Row[] = tasks.flatMap((t) => reviewableGroups(t.template_snapshot.fields).flatMap((g) =>
      ((Array.isArray(t.payload[g.key]) ? t.payload[g.key] : []) as Payload[]).map((item, index) => {
        const inicio = isoDate(item.inicio), fim = isoDate(item.fim_previsto)
        const st = itemStatus(itemQ.data, t.id, g.key, index)
        return {
          key: `${t.id}:${g.key}:${index}`, origin: `Checklist de ${fmtMonth(t.period_start)}`,
          sku: String(item.sku ?? '—'), what: String(item.sugestao ?? '—'), why: null, inicio, fim,
          state: st.state, reason: st.reason, phase: phaseOf(inicio, fim, today), sortKey: inicio ?? '', taskId: t.id,
        }
      })))
    return [...fromRequests, ...fromMonthly].sort((a, b) => b.sortKey.localeCompare(a.sortKey))
  }, [reqQ.data, tasks, itemQ.data, today])

  const shown = rows.filter((r) => filter === 'todos' || (filter === 'em_teste'
    ? r.state === 'aprovada' && r.phase === 'em_teste' : r.state === filter))

  return (
    <>
      <PageHeader
        title="Testes"
        meta="Os testes que você solicitou e os do checklist mensal, com o que testar, o período e a decisão do gestor."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setDialog({ request: null })}>Solicitar teste</Button>}
      >
        <Segmented
          ariaLabel="Filtro"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'todos', label: 'Todos' },
            { value: 'em_teste', label: 'Em teste agora' },
            { value: 'pendente', label: 'Aguardando aprovação' },
            { value: 'aprovada', label: 'Aprovados' },
            { value: 'reprovada', label: 'Reprovados' },
          ]}
        />
      </PageHeader>
      <ErrorNote error={reqQ.error || monthlyQ.error || itemQ.error} />
      {reqQ.isLoading || monthlyQ.isLoading ? <Skeleton className="h-48" /> : shown.length === 0 ? (
        <EmptyState title={rows.length ? 'Nada com esse filtro' : 'Nenhum teste ainda'}
          action={!rows.length && <Button onClick={() => setDialog({ request: null })}>Solicitar teste</Button>}>
          {rows.length ? 'Escolha outro filtro.' : 'Solicitar um teste é opcional. Informe a referência, o que testar e por quê; o gestor aprova ou reprova.'}
        </EmptyState>
      ) : (
        <div className={table.wrap}>
          <table className={cx(table.table, 'min-w-[920px]')}>
            <thead>
              <tr>
                <th className={table.th}>Referência</th>
                <th className={table.th}>O que testar e por quê</th>
                <th className={table.th}>Início</th>
                <th className={table.th}>Final previsto</th>
                <th className={table.th}>Aprovação</th>
                <th className={table.th}>Período</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key} className={r.taskId ? table.trClick : table.tr} tabIndex={r.taskId ? 0 : undefined}
                  onClick={() => r.taskId && setOpenId(r.taskId)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && r.taskId) setOpenId(r.taskId) }}>
                  <td className={cx(table.td, 'whitespace-nowrap align-top')}>
                    <span className="font-mono text-md font-semibold">{r.sku}</span>
                    <span className="block text-xs text-muted">{r.origin}</span>
                  </td>
                  <td className={cx(table.td, 'max-w-md align-top')}>
                    <span className="block">{r.what}</span>
                    {r.why && <span className="mt-1 block text-sm text-muted">{r.why}</span>}
                    {r.state === 'reprovada' && r.reason && (
                      <span className="mt-2 block rounded border border-bad/30 bg-bad/5 px-2.5 py-1.5 text-sm">
                        <span className="font-medium">Reprovado pelo gestor:</span> {r.reason}
                      </span>
                    )}
                    {r.state === 'reprovada' && r.request && (
                      <Button size="sm" className="mt-2" onClick={(e) => { e.stopPropagation(); setDialog({ request: r.request! }) }}>
                        Corrigir e reenviar
                      </Button>
                    )}
                  </td>
                  <td className={cx(table.td, 'whitespace-nowrap align-top tabular-nums')}>{r.inicio ? fmtDay(r.inicio) : '—'}</td>
                  <td className={cx(table.td, 'whitespace-nowrap align-top tabular-nums')}>{r.fim ? fmtDay(r.fim) : '—'}</td>
                  <td className={cx(table.td, 'align-top')}><ReviewState state={r.state} /></td>
                  <td className={cx(table.td, 'whitespace-nowrap align-top text-sm', r.phase === 'em_teste' && r.state === 'aprovada' ? 'font-medium' : 'text-muted')}>
                    {r.state === 'aprovada' ? PHASE_LABEL[r.phase] : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialog && <TestRequestDialog key={dialog.request?.id ?? 'novo'} open onClose={() => setDialog(null)} request={dialog.request} />}
      <TaskPanel taskId={openId} onClose={() => setOpenId(null)} />
    </>
  )
}

function ReviewState({ state }: { state: ItemState }) {
  const Icon = state === 'aprovada' ? Check : state === 'reprovada' ? X : Clock
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium',
      state === 'aprovada' && 'text-ok', state === 'reprovada' && 'text-bad', state === 'pendente' && 'text-muted')}>
      <Icon className="size-4" strokeWidth={2.25} aria-hidden />{ITEM_STATE_LABEL[state]}
    </span>
  )
}
