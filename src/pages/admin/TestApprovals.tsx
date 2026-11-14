import { useMemo, useRef, useState } from 'react'
import { Check, Clock, X } from 'lucide-react'
import { Button, cx, EmptyState, ErrorNote, FormField, PageHeader, Segmented, Skeleton, Textarea } from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { useItemReviews, useReviewItem, useReviewTestRequest, useTestRequests, useTestsQueue } from '@/data/queries'
import { fmtDay, fmtDayOf, fmtMonth } from '@/lib/dates'
import { ITEM_STATE_LABEL, itemStatus, reviewableGroups, type ItemState } from '@/lib/itemReviews'
import { errorMessage } from '@/lib/status'
import type { Payload } from '@/lib/types'

type Filter = ItemState | 'todas'

interface Row {
  key: string
  /** 'item' = referência do marco mensal; 'request' = solicitação avulsa do analista. */
  kind: 'item' | 'request'
  requestId?: string
  taskId: string
  analyst: string
  month: string
  sentAt: string | null
  group: string
  index: number
  itemLabel: string
  item: Payload
  fields: { key: string; label: string }[]
  state: ItemState
  reason: string | null
}

/**
 * Aprovação de testes: cada referência é avaliada de forma independente.
 * Aprovar mostra "teste aprovado" para o analista; reprovar exige o motivo,
 * que aparece para ele como devolutiva.
 */
export default function TestApprovals() {
  const q = useTestsQueue()
  const tasks = (q.data ?? []).filter((t) => reviewableGroups(t.template_snapshot.fields).length > 0)
  const reviews = useItemReviews(tasks.map((t) => t.id))
  const review = useReviewItem()
  const requestsQ = useTestRequests()
  const reviewRequest = useReviewTestRequest()
  const toast = useToast()
  const [filter, setFilter] = useState<Filter>('pendente')
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const reasonRef = useRef<HTMLTextAreaElement>(null)

  const rows = useMemo<Row[]>(() => tasks.flatMap((t): Row[] =>
    reviewableGroups(t.template_snapshot.fields).flatMap((g) => {
      const items = (Array.isArray(t.payload[g.key]) ? t.payload[g.key] : []) as Payload[]
      return items.map((item, index): Row => {
        const st = itemStatus(reviews.data, t.id, g.key, index)
        return {
          kind: 'item' as const, key: `${t.id}:${g.key}:${index}`, taskId: t.id, analyst: t.user?.full_name ?? 'Analista', month: fmtMonth(t.period_start),
          sentAt: t.submitted_at, group: g.key, index, itemLabel: g.item_label ?? g.label, item,
          fields: (g.fields ?? []).map((f) => ({ key: f.key, label: f.label })), state: st.state, reason: st.reason,
        }
      })
    })).concat((requestsQ.data ?? []).map((q): Row => ({
      kind: 'request', requestId: q.id, key: q.id, taskId: '', analyst: q.user?.full_name ?? 'Analista',
      month: `Solicitação avulsa, ${fmtDay(q.start_date)} a ${fmtDay(q.end_date)}`, sentAt: q.updated_at, group: '', index: 0,
      itemLabel: 'Referência',
      item: { sku: q.sku, analise: q.analysis, explicacao: q.explanation, inicio: fmtDay(q.start_date), fim: fmtDay(q.end_date) },
      fields: [
        { key: 'sku', label: 'Referência' }, { key: 'analise', label: 'O que testar' }, { key: 'explicacao', label: 'Explicação' },
        { key: 'inicio', label: 'Início' }, { key: 'fim', label: 'Data final prevista' },
      ],
      state: q.status, reason: q.review_reason,
    }))).sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? '')), [tasks, reviews.data, requestsQ.data])

  const counts = { pendente: 0, aprovada: 0, reprovada: 0 }
  for (const r of rows) counts[r.state]++
  const shown = rows.filter((r) => filter === 'todas' || r.state === filter)

  async function decide(r: Row, status: 'aprovada' | 'reprovada') {
    if (status === 'reprovada' && !reason.trim()) { reasonRef.current?.focus(); return }
    try {
      if (r.kind === 'request') await reviewRequest.mutateAsync({ id: r.requestId!, status, reason: reason.trim() })
      else await review.mutateAsync({ taskId: r.taskId, group: r.group, index: r.index, status, reason: reason.trim() })
      toast(status === 'aprovada' ? `Teste aprovado: ${r.analyst}.` : `Teste reprovado. ${r.analyst} vai ver o motivo.`)
      setRejecting(null); setReason('')
    } catch (e) { toast(errorMessage(e), 'bad') }
  }

  return (
    <>
      <PageHeader
        title="Aprovação de testes"
        meta="Solicitações de teste dos analistas e referências do checklist mensal. Aprove ou reprove cada uma de forma independente; reprovar exige justificativa."
      >
        <Segmented<Filter>
          ariaLabel="Situação"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'pendente', label: `Pendentes (${counts.pendente})` },
            { value: 'aprovada', label: `Aprovados (${counts.aprovada})` },
            { value: 'reprovada', label: `Reprovados (${counts.reprovada})` },
            { value: 'todas', label: 'Todos' },
          ]}
        />
      </PageHeader>

      <ErrorNote error={q.error || reviews.error || requestsQ.error} />
      {q.isLoading || reviews.isLoading || requestsQ.isLoading ? <Skeleton className="h-48" /> : shown.length === 0 ? (
        <EmptyState title={filter === 'pendente' ? 'Nenhum teste aguardando aprovação' : 'Nada por aqui'}>
          {filter === 'pendente'
            ? 'As sugestões aparecem aqui quando o analista concluir o marco de testes do mês.'
            : 'Mude o filtro para ver outras situações.'}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {shown.map((r) => (
            <li key={r.key} className="py-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="text-md font-semibold">
                  {r.analyst}
                  <span className="ml-3 text-sm font-normal text-muted">{r.month}{r.sentAt ? `, enviado em ${fmtDayOf(r.sentAt)}` : ''}</span>
                </p>
                <StateLabel state={r.state} />
              </div>

              <dl className="mt-3 grid gap-x-8 gap-y-3 md:grid-cols-[minmax(0,14rem)_1fr]">
                {r.fields.map((f) => (
                  <div key={f.key} className="contents">
                    <dt className="text-sm text-muted">{f.label}</dt>
                    <dd className="whitespace-pre-wrap break-words">{String(r.item[f.key] ?? '—')}</dd>
                  </div>
                ))}
              </dl>

              {r.state === 'reprovada' && r.reason && (
                <p className="mt-3 rounded border border-bad/30 bg-bad/5 px-3 py-2 text-sm">
                  <span className="font-medium">Motivo da reprovação:</span> {r.reason}
                </p>
              )}

              {r.state === 'pendente' && (
                rejecting === r.key ? (
                  <div className="mt-4 max-w-xl space-y-3">
                    <FormField label="Justificativa da reprovação" required hint="O analista vê este texto e pode corrigir e reenviar.">
                      <Textarea ref={reasonRef} rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
                    </FormField>
                    <div className="flex gap-2">
                      <Button variant="danger" icon={<X className="size-4" />} loading={review.isPending || reviewRequest.isPending} disabled={!reason.trim()}
                        onClick={() => decide(r, 'reprovada')}>Reprovar teste</Button>
                      <Button variant="ghost" onClick={() => { setRejecting(null); setReason('') }}>Cancelar</Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant="primary" icon={<Check className="size-4" />} loading={(review.isPending && review.variables?.index === r.index && review.variables?.taskId === r.taskId) || (reviewRequest.isPending && reviewRequest.variables?.id === r.requestId)}
                      onClick={() => decide(r, 'aprovada')}>Aprovar teste</Button>
                    <Button variant="danger" icon={<X className="size-4" />} onClick={() => { setRejecting(r.key); setReason('') }}>Reprovar</Button>
                  </div>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function StateLabel({ state }: { state: ItemState }) {
  const Icon = state === 'aprovada' ? Check : state === 'reprovada' ? X : Clock
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-sm font-medium', state === 'aprovada' && 'text-ok', state === 'reprovada' && 'text-bad', state === 'pendente' && 'text-muted')}>
      <Icon className="size-4" strokeWidth={2.25} aria-hidden />{ITEM_STATE_LABEL[state]}
    </span>
  )
}
