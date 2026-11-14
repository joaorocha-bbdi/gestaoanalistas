import { useEffect, useMemo, useRef, useState } from 'react'
import { Ban, ShieldAlert, ShieldCheck } from 'lucide-react'
import {
  Button, Checkbox, cx, EmptyState, ErrorNote, FormField, PageHeader, ReviewLabel, Select, Sheet, Skeleton, Spinner,
  StatusLabel, table, Textarea,
} from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { FilterBar, useFilters } from '@/features/metrics/Filters'
import { FieldList } from '@/features/tasks/FieldInput'
import { StepsList } from '@/features/tasks/StepsList'
import { Block, Callout } from '@/features/tasks/TaskPanel'
import { periodLabel } from '@/features/tasks/taskText'
import { stepCounts, useFacts, useReviewTask, useReviews, useSettings, useSteps, useSubmissions, useTask, useTextContext } from '@/data/queries'
import { dueText, fmtDateTime, fmtDay, localDate } from '@/lib/dates'
import { useHotkeys, useSearchParamState } from '@/lib/hooks'
import { errorMessage } from '@/lib/status'
import { renderText } from '@/lib/fields'
import type { TaskFact } from '@/lib/types'

type Queue = 'pendentes' | 'todas' | 'contestadas'

export default function ReviewPage() {
  const settings = useSettings()
  const [f, actions] = useFilters('30d')
  const [queue, setQueue] = useState<Queue>('pendentes')
  const [onlyGate, setOnlyGate] = useState(false)
  const [onlySample, setOnlySample] = useState(false)
  const [openId, setOpenId] = useSearchParamState('t')
  const [sel, setSel] = useState(0)
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([])

  const facts = useFacts({ from: f.from, to: f.to, userId: f.userId, templateId: f.templateId })
  const rate = Number(settings.amostragem_revisao) || 20

  const rows = useMemo(() => (facts.data ?? [])
    .filter((x) => x.completed)
    .filter((x) => queue === 'todas' || (queue === 'pendentes' ? x.review_status === 'nao_revisada' : x.contested))
    .filter((x) => !onlyGate || x.gate_block_count > 0)
    .filter((x) => !onlySample || x.sample_bucket < rate)
    .sort((a, b) => (b.submitted_at ?? '').localeCompare(a.submitted_at ?? '')), [facts.data, queue, onlyGate, onlySample, rate])

  useHotkeys({
    j: () => move(1),
    k: () => move(-1),
    enter: () => { const r = rows[sel]; if (r) setOpenId(r.id) },
    r: () => { const r = rows[sel] ?? rows[0]; if (r) setOpenId(r.id) },
  }, !openId)

  function move(d: number) {
    const n = Math.min(Math.max(sel + d, 0), rows.length - 1)
    setSel(n)
    rowRefs.current[n]?.focus()
  }
  function next() {
    const i = rows.findIndex((r) => r.id === openId)
    const n = rows[i + 1]
    if (n) { setOpenId(n.id); setSel(i + 1) } else setOpenId(null)
  }

  return (
    <>
      <PageHeader title="Revisão" meta={<>Amostra estável de {rate}% das conclusões · <span className="font-mono">j/k</span> navega, <span className="font-mono">r</span> abre</>}>
        <FilterBar state={f} actions={actions} />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Select aria-label="Fila" className="w-auto" value={queue} onChange={(e) => setQueue(e.target.value as Queue)}>
            <option value="pendentes">Não revisadas</option>
            <option value="contestadas">Contestadas</option>
            <option value="todas">Todas as conclusões</option>
          </Select>
          <Checkbox label="Só com gate bloqueado" checked={onlyGate} onChange={setOnlyGate} />
          <Checkbox label={`Só amostra aleatória (${rate}%)`} checked={onlySample} onChange={setOnlySample} />
        </div>
      </PageHeader>

      <ErrorNote error={facts.error} />
      {facts.isLoading ? <Skeleton className="h-64" /> : rows.length === 0 ? (
        <EmptyState title={queue === 'pendentes' ? 'Fila vazia' : 'Nada encontrado'}>
          {queue === 'pendentes' ? 'Todas as conclusões do período com esses filtros já foram revisadas.' : 'Ajuste os filtros ou o período.'}
        </EmptyState>
      ) : (
        <div className={table.wrap}>
          <p className="mb-2 text-sm text-muted tnum">{rows.length} conclus{rows.length === 1 ? 'ão' : 'ões'}</p>
          <table className={cx(table.table, 'min-w-[760px]')}>
            <thead>
              <tr>
                <th className={table.th}>Dia</th>
                <th className={table.th}>Analista</th>
                <th className={table.th}>Atividade</th>
                <th className={table.th}>Situação</th>
                <th className={table.th}>Gate</th>
                <th className={table.th}>Revisão</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} ref={(el) => { rowRefs.current[i] = el }} tabIndex={0}
                  className={cx(table.trClick, sel === i && 'bg-hover')}
                  onFocus={() => setSel(i)}
                  onClick={() => { setSel(i); setOpenId(r.id) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(r.id) }}>
                  <td className={cx(table.td, 'whitespace-nowrap text-muted tnum')}>{fmtDay(r.ref_date)}</td>
                  <td className={cx(table.td, 'font-medium')}>{r.full_name}</td>
                  <td className={table.td}>{r.template_name}</td>
                  <td className={table.td}><StatusLabel status={r.status} short /></td>
                  <td className={table.td}>
                    {r.gate_block_count > 0
                      ? <span className="inline-flex items-center gap-1.5 text-sm"><Ban className="size-4 text-bad" aria-hidden />barrou {r.gate_block_count}×</span>
                      : <span className="text-faint">—</span>}
                  </td>
                  <td className={table.td}><ReviewLabel status={r.review_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ReviewSheet fact={rows.find((r) => r.id === openId)} taskId={openId} onClose={() => setOpenId(null)} onDone={next} />
    </>
  )
}

function ReviewSheet({ taskId, fact, onClose, onDone }: { taskId: string | null; fact?: TaskFact; onClose: () => void; onDone: () => void }) {
  const { data: task, isLoading } = useTask(taskId)
  const subs = useSubmissions(taskId)
  const reviews = useReviews(taskId)
  const stepsQ = useSteps(taskId ? [taskId] : [])
  const settings = useSettings()
  const text = useTextContext()
  const review = useReviewTask()
  const toast = useToast()
  const [contesting, setContesting] = useState(false)
  const [reason, setReason] = useState('')
  const reasonRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { setContesting(false); setReason('') }, [taskId])
  useEffect(() => { if (contesting) reasonRef.current?.focus() }, [contesting])

  async function act(status: 'validada' | 'contestada') {
    if (!task) return
    if (status === 'contestada' && !reason.trim()) { setContesting(true); return }
    try {
      await review.mutateAsync({ id: task.id, status, reason })
      toast(status === 'validada' ? `Validada: ${task.template_snapshot.name}.` : 'Contestada. Voltou para o analista corrigir.')
      onDone()
    } catch (e) { toast(errorMessage(e), 'bad') }
  }

  useHotkeys({
    v: () => { if (!contesting) void act('validada') },
    c: () => setContesting(true),
    'mod+enter': () => { if (contesting) void act('contestada') },
  }, !!taskId)

  const s = task?.template_snapshot
  return (
    <Sheet
      open={!!taskId}
      onClose={onClose}
      labelledBy="review-title"
      title={task && s ? (
        <div className="space-y-1">
          <p className="font-mono text-xs text-muted">{s.code} · {periodLabel(task)}</p>
          <h2 id="review-title" className="text-lg font-semibold">{fact?.full_name ?? ''} — {s.name}</h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <StatusLabel status={task.status} />
            <span className="tnum">Prazo: {dueText(localDate(task.due_at)).text.replace(/^vence |^venceu /, '')} · enviada em {task.submitted_at ? fmtDateTime(task.submitted_at) : '—'}</span>
            <ReviewLabel status={task.review_status} />
          </div>
        </div>
      ) : <span id="review-title">Revisão</span>}
      footer={task && (
        contesting ? (
          <div className="space-y-2">
            <FormField label="Motivo da contestação" required hint="O analista vê este texto e precisa corrigir e reenviar.">
              <Textarea ref={reasonRef} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </FormField>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setContesting(false)}>Cancelar</Button>
              <Button variant="danger" icon={<ShieldAlert className="size-4" />} loading={review.isPending}
                disabled={!reason.trim()} onClick={() => act('contestada')} kbd="Ctrl ↵">Contestar</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="danger" icon={<ShieldAlert className="size-4" />} onClick={() => setContesting(true)} kbd="C">Contestar</Button>
            <Button variant="primary" icon={<ShieldCheck className="size-4" />} loading={review.isPending} onClick={() => act('validada')} kbd="V">Validar</Button>
          </div>
        )
      )}
    >
      {isLoading || !task || !s ? <div className="px-5"><Spinner /></div> : (
        <div className="space-y-8 px-5 py-5">
          {task.needs_rework && (
            <Callout tone="warn" icon={<ShieldAlert className="size-4" />} title="Aguardando correção do analista">
              {reviews.data?.[0]?.reason}
            </Callout>
          )}
          {(s.instructions?.length ?? 0) > 0 && (
            <Block title="Etapas registradas" meta="quem marcou e quando">
              <StepsList steps={s.instructions} texts={stepsQ.data ?? []} done={stepCounts(stepsQ.data).get(task.id) ?? 0}
                editable={false} completed text={text} onToggle={() => {}} />
            </Block>
          )}
          <Block title="Registro enviado">
            <FieldList defs={s.fields} value={task.payload} onChange={() => {}} ctx={{ text, settings, readOnly: true }} />
          </Block>

          {s.gates.length > 0 && (
            <Block title="Verificações e envios">
              <ol className="space-y-4">
                {(subs.data ?? []).map((sub) => (
                  <li key={sub.id} className="rounded border border-line p-3 text-sm">
                    <div className="mb-2 flex items-center justify-between">
                      <StatusLabel status={sub.result_status} />
                      <span className="font-mono text-xs text-muted">{fmtDateTime(sub.submitted_at)}</span>
                    </div>
                    <ul className="space-y-1">
                      {(sub.gate_answers ?? []).map((g) => (
                        <li key={g.gate_key} className="flex justify-between gap-3">
                          <span className={g.ok ? 'text-muted' : 'text-bad'}>{renderText(g.question, text)}</span>
                          <span className={cx('font-medium', !g.ok && 'text-bad')}>{g.answer === 'sim' ? 'Sim' : 'Não'}</span>
                        </li>
                      ))}
                    </ul>
                    {sub.deviation && (
                      <p className="mt-2 border-t border-line pt-2">
                        <span className="text-muted">Desvio:</span> <span className="font-mono">{sub.deviation.skus.join(', ')}</span>
                        <span className="block">{sub.deviation.action}</span>
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </Block>
          )}

          {(reviews.data?.length ?? 0) > 0 && (
            <Block title="Revisões anteriores">
              <ul className="space-y-2 text-sm">
                {reviews.data!.map((r) => (
                  <li key={r.id}>
                    <ReviewLabel status={r.status} /> <span className="font-mono text-xs text-muted">{fmtDateTime(r.created_at)}</span>
                    {r.reason && <p className="text-muted">{r.reason}</p>}
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {s.followup_fields?.length > 0 && task.followup && (
            <Block title="Leitura do resultado">
              <FieldList defs={s.followup_fields} value={task.followup} onChange={() => {}} ctx={{ text, settings, readOnly: true }} />
            </Block>
          )}
          {s.description && <p className="text-sm text-muted">{renderText(s.description, text)}</p>}
        </div>
      )}
    </Sheet>
  )
}
