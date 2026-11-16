import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Clock, Lock, OctagonAlert, RotateCcw, X } from 'lucide-react'
import {
  Button, cx, ErrorNote, FormField, FullPage, ReviewLabel, Segmented, Spinner, StatusLabel, Textarea,
} from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import {
  stepCounts, useItemReviews, useRecordFollowup, useResubmitItem, useReviews, useSaveDraft, useSetStep, useSettings, useSteps, useSubmissions, useSubmitTask,
  useTask, useTasks, useTextContext, type Dashboard,
} from '@/data/queries'
import { sequenceStates } from '@/lib/sequence'
import { ITEM_STATE_LABEL, itemStatus, reviewableGroups, type ItemState } from '@/lib/itemReviews'
import { evaluateGates, mergePayload, missingFields, parseList, renderText, submitBlockers } from '@/lib/fields'
import { effectiveStatus, errorMessage, isCompleted, STATUS_META } from '@/lib/status'
import { dueText, fmtDateTime, fmtDayOf, localDate } from '@/lib/dates'
import { useHotkeys, useNow } from '@/lib/hooks'
import type { Deviation, GateAnswer, Payload, TaskInstance } from '@/lib/types'
import { useAuth } from '@/auth/AuthProvider'
import { FieldList } from './FieldInput'
import { StepsList } from './StepsList'
import { periodLabel } from './taskText'
import { Plate, plateState } from './Plate'

export function TaskPanel({ taskId, onClose, onNavigate }: {
  taskId: string | null
  onClose: () => void
  onNavigate?: (dir: 1 | -1) => void
}) {
  const { data: task, isLoading, error } = useTask(taskId)
  const titleId = 'task-panel-title'
  return (
    <FullPage open={!!taskId} onClose={onClose} labelledBy={titleId} backLabel="Voltar ao checklist"
      title={task ? <TaskTitle task={task} id={titleId} /> : <span id={titleId} className="text-muted">Atividade</span>}>
      {isLoading && <div className="px-5"><Spinner /></div>}
      {error && <div className="p-5"><ErrorNote error={error} /></div>}
      {task && <TaskBody key={task.id + (isCompleted(task.status) ? 'c' : 'o') + task.needs_rework} task={task} onNavigate={onNavigate} />}
    </FullPage>
  )
}

/** Estado de sequência (cadeado, posição) desta atividade entre as do mesmo período. */
function useBlock(task: TaskInstance) {
  // A tela "Hoje" já tem as tarefas do analista: reaproveita em vez de buscar de novo.
  const qc = useQueryClient()
  const cached = new Map<string, TaskInstance>()
  for (const [, d] of qc.getQueriesData<Dashboard>({ queryKey: ['tasks', 'dashboard', task.user_id] })) {
    for (const t of d?.tasks ?? []) cached.set(t.id, t)
  }
  const inCache = cached.has(task.id)
  const q = useTasks({ userId: task.user_id, from: task.ref_date, to: task.ref_date, enabled: !inCache })
  const source = inCache ? [...cached.values()] : q.data ?? []
  const group = source.filter((t) => t.period_key === task.period_key
    && t.template_snapshot.frequency === task.template_snapshot.frequency)
  return sequenceStates(group, new Map()).find((b) => b.task.id === task.id)
}

/** Analista vê só a data; o gestor vê data e horário (registro de auditoria). */
function useWhen() {
  const { profile } = useAuth()
  return (ts: string) => (profile?.role === 'admin' ? fmtDateTime(ts) : fmtDayOf(ts))
}

function TaskTitle({ task, id }: { task: TaskInstance; id: string }) {
  const now = useNow()
  const s = task.template_snapshot
  const st = effectiveStatus(task, now)
  const open = !isCompleted(task.status) && task.status !== 'pausada'
  const position = useBlock(task)?.position
  const due = dueText(localDate(task.due_at))
  return (
    <div className="flex items-start gap-4">
      <Plate label={position ?? s.code ?? '·'} state={plateState(task.status, task.due_at, now)} size="lg" />
      <div className="min-w-0 space-y-1">
        <p className="text-sm text-muted">{s.code} · {periodLabel(task)}</p>
        <h2 id={id} className="text-2xl font-semibold leading-7">{s.name}</h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <StatusLabel status={st} />
          {open && <span className={cx(due.late ? 'font-medium text-bad' : '')}>{due.text}</span>}
          {task.curve && <span>Curva <span className="font-semibold text-ink">{task.curve}</span></span>}
          {s.target_qty && <span>Meta <span className="font-semibold text-ink">{s.target_qty}</span> {s.target_label}</span>}
        </div>
      </div>
    </div>
  )
}

function TaskBody({ task, onNavigate }: { task: TaskInstance; onNavigate?: (dir: 1 | -1) => void }) {
  const s = task.template_snapshot
  const settings = useSettings()
  const text = useTextContext()
  const toast = useToast()
  const saveDraft = useSaveDraft()
  const submit = useSubmitTask()

  const { profile } = useAuth()
  const isOwner = profile?.id === task.user_id

  // Etapas marcadas e bloqueio por sequência (o banco também recusa).
  const stepsQ = useSteps([task.id])
  const setStep = useSetStep(profile ? { id: profile.id, name: profile.full_name } : undefined)
  const block = useBlock(task)
  const locked = !!block?.locked
  const stepsDone = stepCounts(stepsQ.data).get(task.id) ?? 0
  const instructions = s.instructions ?? []
  const stepsMissing = task.needs_rework ? 0 : Math.max(instructions.length - stepsDone, 0)

  // Só o dono edita, com o bloco liberado; admin vê em modo leitura (o banco também recusa).
  const editable = isOwner && !locked && task.status !== 'pausada' && (!isCompleted(task.status) || task.needs_rework)
  const stepsEditable = isOwner && !locked && task.status !== 'pausada' && !isCompleted(task.status)
  const [payload, setPayload] = useState<Payload>(() => mergePayload(s.fields, task.payload, { curve: task.curve }))
  const [gates, setGates] = useState<Record<string, GateAnswer | undefined>>(() => ({ ...task.gate_draft }))
  const [devSkus, setDevSkus] = useState(() => (task.deviation?.skus ?? []).join('\n'))
  const [devAction, setDevAction] = useState(() => task.deviation?.action ?? '')
  const [dirty, setDirty] = useState(false)
  const [showErrors, setShowErrors] = useState(false)

  const deviation: Deviation | null = useMemo(() => {
    const skus = parseList(devSkus)
    return skus.length || devAction.trim() ? { skus, action: devAction.trim() } : null
  }, [devSkus, devAction])

  const ev = evaluateGates(s.gates, gates)
  const { mode, blockers } = submitBlockers({ fields: s.fields, gates: s.gates, payload, answers: gates, deviation, stepsMissing })
  const errors = useMemo(() => new Set(showErrors ? missingFields(s.fields, payload) : []), [showErrors, s.fields, payload])

  const mark = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setDirty(true) }

  async function onSave() {
    try {
      await saveDraft.mutateAsync({ id: task.id, payload, gates: gates as Record<string, GateAnswer>, deviation })
      setDirty(false)
      toast('Rascunho salvo.')
    } catch (e) { toast(errorMessage(e), 'bad') }
  }

  async function onToggleStep(index: number, checked: boolean) {
    try { await setStep.mutateAsync({ taskId: task.id, index, checked }) } catch (e) { toast(errorMessage(e), 'bad') }
  }

  async function onSubmit() {
    if (blockers.length) { setShowErrors(true); return }
    try {
      const t = await submit.mutateAsync({ id: task.id, payload, gates: gates as Record<string, GateAnswer>, deviation })
      setDirty(false)
      toast(t.status === 'bloqueada_gate'
        ? 'Bloqueio registrado. A atividade só conclui quando as verificações estiverem em NÃO.'
        : `${STATUS_META[t.status].label}.`, t.status === 'bloqueada_gate' ? 'bad' : 'ok')
      if (t.status !== 'bloqueada_gate') onNavigate?.(1)
    } catch (e) { toast(errorMessage(e), 'bad') }
  }

  useHotkeys({
    'mod+enter': () => { if (editable) void onSubmit() },
    'mod+s': () => { if (editable) void onSave() },
  }, editable)

  // Aviso ao sair com alterações não salvas
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  const ctx = { text, settings, readOnly: !editable, errors }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 space-y-8 px-5 py-5">
        <ReviewBanner task={task} />
        {task.status === 'pausada' && (
          <Callout tone="muted" icon={<AlertTriangle className="size-4" />} title="Atividade pausada">
            Fora de vigência ou pausada pelo gestor. Não conta nas métricas e não aceita registro.
          </Callout>
        )}

        {s.description && <p className="text-muted">{renderText(s.description, text)}</p>}

        {locked && block?.blockedBy && (
          <Callout tone="warn" icon={<Lock className="size-4" />} title="Bloqueado até a etapa anterior">
            Conclua “{block.blockedBy}” para liberar esta atividade. Elas seguem uma sequência.
          </Callout>
        )}

        {instructions.length > 0 && (
          <Block title="Etapas" meta={stepsEditable ? 'marque uma a uma, em ordem' : undefined}>
            <StepsList
              steps={instructions}
              texts={(stepsQ.data ?? []).filter((x) => x.task_id === task.id)}
              done={stepsDone}
              editable={stepsEditable}
              completed={isCompleted(task.status)}
              pendingIndex={setStep.isPending ? (setStep.variables?.index ?? null) : null}
              onToggle={onToggleStep}
              text={text}
            />
          </Block>
        )}

        {s.fields.length > 0 && (
          <Block title="Registro">
            <FieldList defs={s.fields} value={payload} onChange={mark(setPayload)} ctx={ctx} />
          </Block>
        )}

        {s.gates.length > 0 && (
          <Block title="Verificações" meta="Só conclui com todas na resposta esperada">
            <ul className="divide-y divide-line rounded border border-line">
              {s.gates.map((g) => {
                const a = gates[g.key]
                const off = a !== undefined && a !== g.expected
                return (
                  <li key={g.key} className={cx('flex flex-wrap items-center justify-between gap-3 px-4 py-3', off && 'bg-bad/5')}>
                    <div className="min-w-0 flex-1">
                      <p className={cx(off && 'text-bad')}>{renderText(g.question, text)}</p>
                      <p className="text-xs text-muted">Esperado: {g.expected === 'nao' ? 'Não' : 'Sim'}</p>
                    </div>
                    <Segmented<GateAnswer>
                      ariaLabel={renderText(g.question, text)}
                      value={a}
                      disabled={!editable}
                      onChange={(v) => { setGates((x) => ({ ...x, [g.key]: v })); setDirty(true) }}
                      options={[{ value: 'sim', label: 'Sim' }, { value: 'nao', label: 'Não' }]}
                    />
                  </li>
                )
              })}
            </ul>

            {(ev.failing.length > 0 || task.status === 'bloqueada_gate') && (
              <div className="mt-4 space-y-4 rounded border border-bad/30 p-4">
                <div className="flex items-start gap-2 text-sm">
                  <OctagonAlert className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden />
                  <p>
                    <span className="font-medium">Com resposta SIM a atividade não conclui.</span>{' '}
                    <span className="text-muted">Registre os SKUs em desvio e a ação. Ela fica como “Bloqueada pelo gate” até você reenviar com tudo em NÃO.</span>
                  </p>
                </div>
                <FormField label="SKUs em desvio" required hint={`${parseList(devSkus).length} SKU(s)`}>
                  <Textarea mono rows={3} disabled={!editable} value={devSkus} placeholder="Um SKU por linha"
                    aria-invalid={showErrors && !parseList(devSkus).length}
                    onChange={(e) => { setDevSkus(e.target.value); setDirty(true) }} />
                </FormField>
                <FormField label="Ação tomada ou que vai tomar" required>
                  <Textarea rows={2} disabled={!editable} value={devAction}
                    aria-invalid={showErrors && !devAction.trim()}
                    onChange={(e) => { setDevAction(e.target.value); setDirty(true) }} />
                </FormField>
              </div>
            )}
          </Block>
        )}

        {isCompleted(task.status) && reviewableGroups(s.fields).length > 0 && <ItemReviewsBlock task={task} isOwner={isOwner} />}

        {isCompleted(task.status) && (s.followup_fields?.length ?? 0) > 0 && <FollowupBlock task={task} />}

        <HistoryBlock taskId={task.id} />
      </div>

      {editable && (
        <div className="sticky bottom-0 border-t border-line bg-surface px-5 py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
          {showErrors && blockers.length > 0 && (
            <p role="alert" className="mb-2 text-sm text-bad">
              Falta: {blockers.slice(0, 4).join(' · ')}{blockers.length > 4 && ` e mais ${blockers.length - 4}`}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {dirty && <span className="mr-auto text-xs text-muted">Alterações não salvas</span>}
            <Button variant="ghost" onClick={onSave} loading={saveDraft.isPending} kbd="Ctrl S">Salvar rascunho</Button>
            <Button
              variant={mode === 'bloquear' ? 'danger' : 'primary'}
              onClick={onSubmit}
              loading={submit.isPending}
              kbd="Ctrl ↵"
            >
              {mode === 'bloquear' ? 'Registrar bloqueio' : task.needs_rework ? 'Reenviar correção' : 'Concluir'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function ReviewBanner({ task }: { task: TaskInstance }) {
  const when = useWhen()
  const { data: reviews } = useReviews(task.id)
  const last = reviews?.[0]
  if (task.needs_rework && last?.status === 'contestada') {
    return (
      <Callout tone="bad" icon={<RotateCcw className="size-4" />} title="Contestada na revisão">
        <p>{last.reason}</p>
        <p className="mt-1 text-muted">Corrija o registro e reenvie. A pontualidade original é mantida; a contestação continua contando na qualidade.</p>
      </Callout>
    )
  }
  if (!isCompleted(task.status)) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
      <span>Enviada {task.submitted_at ? when(task.submitted_at) : '—'}</span>
      <ReviewLabel status={task.review_status} />
      {last?.status === 'contestada' && last.reason && <span>Motivo: {last.reason}</span>}
    </div>
  )
}

function FollowupBlock({ task }: { task: TaskInstance }) {
  const when = useWhen()
  const s = task.template_snapshot
  const settings = useSettings()
  const text = useTextContext()
  const toast = useToast()
  const save = useRecordFollowup()
  const groupDef = s.fields.find((f) => f.type === 'group')
  const itemCount = groupDef ? ((task.payload[groupDef.key] as unknown[]) ?? []).length : 1
  const [data, setData] = useState<Payload>(() => {
    const base = { ...(task.followup ?? {}) }
    for (const f of s.followup_fields) {
      if (f.type === 'group') {
        const arr = (Array.isArray(base[f.key]) ? base[f.key] : []) as Payload[]
        base[f.key] = Array.from({ length: Math.max(arr.length, itemCount) }, (_, i) => arr[i] ?? {})
      }
    }
    return base
  })
  return (
    <Block title="Leitura do resultado" meta={task.followup_at ? `Atualizada ${when(task.followup_at)}` : 'Em andamento até a leitura'}>
      <FieldList defs={s.followup_fields} value={data} onChange={setData} ctx={{ text, settings }} />
      <div className="mt-4 flex justify-end">
        <Button loading={save.isPending} onClick={async () => {
          try { await save.mutateAsync({ id: task.id, data }); toast('Leitura registrada.') } catch (e) { toast(errorMessage(e), 'bad') }
        }}>Registrar leitura</Button>
      </div>
    </Block>
  )
}

function HistoryBlock({ taskId }: { taskId: string }) {
  const when = useWhen()
  const { data: subs } = useSubmissions(taskId)
  const { data: reviews } = useReviews(taskId)
  const events = [
    ...(subs ?? []).map((s) => ({ at: s.submitted_at, kind: 'envio' as const, s })),
    ...(reviews ?? []).map((r) => ({ at: r.created_at, kind: 'revisao' as const, r })),
  ].sort((a, b) => b.at.localeCompare(a.at))
  if (!events.length) return null
  return (
    <Block title="Histórico">
      <ol className="space-y-3 border-l border-line pl-4">
        {events.map((e, i) => (
          <li key={i} className="text-sm">
            <p className="text-xs text-muted">{when(e.at)}</p>
            {e.kind === 'envio' ? (
              <div>
                <StatusLabel status={e.s.result_status} />
                {!e.s.gate_passed && (
                  <div className="mt-1 text-muted">
                    {e.s.gate_answers?.filter((g) => !g.ok).map((g) => <p key={g.gate_key}>“{g.question}” → {g.answer === 'sim' ? 'Sim' : 'Não'}</p>)}
                    {e.s.deviation && (
                      <p>Desvio: <span className="font-mono">{e.s.deviation.skus.join(', ')}</span> — {e.s.deviation.action}</p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div>
                <ReviewLabel status={e.r.status} />
                {e.r.reason && <p className="mt-0.5 text-muted">{e.r.reason}</p>}
              </div>
            )}
          </li>
        ))}
      </ol>
    </Block>
  )
}

export function Block({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 flex flex-wrap items-baseline gap-x-3 border-t-2 border-ink pt-2 text-lg font-semibold">
        {title}{meta && <span className="text-sm font-normal text-muted">{meta}</span>}
      </h3>
      {children}
    </section>
  )
}

export function Callout({ tone, icon, title, children }: { tone: 'bad' | 'warn' | 'muted' | 'accent'; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className={cx('flex gap-3 rounded border px-4 py-3 text-sm',
      tone === 'bad' && 'border-bad/30 bg-bad/5',
      tone === 'warn' && 'border-warn/30 bg-warn/5',
      tone === 'accent' && 'border-accent/30 bg-accent-soft',
      tone === 'muted' && 'border-line bg-subtle')}>
      <span className={cx('mt-0.5 shrink-0', tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'accent' ? 'text-accent' : 'text-muted')}>{icon}</span>
      <div><p className="font-medium">{title}</p><div className="mt-0.5">{children}</div></div>
    </div>
  )
}

/**
 * Aprovação por referência: cada item do grupo (ex.: cada teste) tem a sua situação.
 * Aprovado: o analista vê "teste aprovado". Reprovado: vê o motivo e pode corrigir e reenviar
 * só aquela referência, sem mexer nas outras.
 */
function ItemReviewsBlock({ task, isOwner }: { task: TaskInstance; isOwner: boolean }) {
  const s = task.template_snapshot
  const q = useItemReviews([task.id])
  const groups = reviewableGroups(s.fields)
  return (
    <Block title="Aprovação do gestor" meta="cada referência é avaliada separadamente">
      <div className="space-y-6">
        {groups.map((g) => {
          const items = (Array.isArray(task.payload[g.key]) ? task.payload[g.key] : []) as Payload[]
          return (
            <ul key={g.key} className="divide-y divide-line border-y border-line">
              {items.map((item, i) => {
                const st = itemStatus(q.data, task.id, g.key, i)
                return (
                  <li key={i} className="py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-md font-semibold">
                        {g.item_label ?? g.label} {i + 1}
                        {item.sku ? <span className="ml-2 font-normal text-muted">{String(item.sku)}</span> : null}
                      </p>
                      <ItemStateLabel state={st.state} />
                    </div>
                    {st.state === 'reprovada' && st.reason && (
                      <p className="mt-2 rounded border border-bad/30 bg-bad/5 px-3 py-2 text-sm">
                        <span className="font-medium">Motivo da reprovação:</span> {st.reason}
                      </p>
                    )}
                    {st.state === 'reprovada' && isOwner && (
                      <ResubmitItem task={task} groupKey={g.key} index={i} item={item} defs={g.fields ?? []} />
                    )}
                  </li>
                )
              })}
            </ul>
          )
        })}
      </div>
    </Block>
  )
}

function ItemStateLabel({ state }: { state: ItemState }) {
  const Icon = state === 'aprovada' ? Check : state === 'reprovada' ? X : Clock
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-sm font-medium',
      state === 'aprovada' && 'text-ok', state === 'reprovada' && 'text-bad', state === 'pendente' && 'text-muted')}>
      <Icon className="size-4" strokeWidth={2.25} aria-hidden />{ITEM_STATE_LABEL[state]}
    </span>
  )
}

function ResubmitItem({ task, groupKey, index, item, defs }: {
  task: TaskInstance; groupKey: string; index: number; item: Payload; defs: NonNullable<TaskInstance['template_snapshot']['fields'][number]['fields']>
}) {
  const settings = useSettings()
  const text = useTextContext()
  const toast = useToast()
  const resubmit = useResubmitItem()
  const [draft, setDraft] = useState<Payload>(item)
  const [showErrors, setShowErrors] = useState(false)
  const errors = useMemo(() => new Set(showErrors ? missingFields(defs, draft) : []), [showErrors, defs, draft])
  async function send() {
    if (missingFields(defs, draft).length) { setShowErrors(true); return }
    try {
      await resubmit.mutateAsync({ taskId: task.id, group: groupKey, index, item: draft })
      toast('Referência reenviada para a aprovação do gestor.')
    } catch (e) { toast(errorMessage(e), 'bad') }
  }
  return (
    <div className="mt-4 space-y-4 rounded border border-line p-4">
      <p className="text-sm font-medium">Corrija a sugestão e reenvie só esta referência</p>
      <FieldList defs={defs} value={draft} onChange={setDraft} ctx={{ text, settings, errors }} />
      <Button variant="primary" loading={resubmit.isPending} onClick={send}>Reenviar referência</Button>
    </div>
  )
}
