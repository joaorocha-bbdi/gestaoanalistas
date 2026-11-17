import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, CalendarOff, Check, ChevronLeft, ChevronRight, Clock, ExternalLink, FlaskConical, PartyPopper, X } from 'lucide-react'
import {
  Button, cx, EmptyState, ErrorNote, PageHeader, ReviewLabel, Section, Skeleton, StatusLabel,
} from '@/components/ui'
import { FieldList } from '@/features/tasks/FieldInput'
import { Block } from '@/features/tasks/TaskPanel'
import { TaskPanel } from '@/features/tasks/TaskPanel'
import {
  useAnalysts, useDaysOff, useDayWork, useFacts, useHolidays, useItemReviews, useSettings, useSteps, useTestRequests, useTextContext,
} from '@/data/queries'
import { deliveredOn, summarizeDay, type DaySummary } from '@/lib/daily'
import { addDays, eachDay, fmtDateTime, fmtDay, fmtDayLong, fmtTime, isoWeekday, localDate, startOfWeek, todayISO, WEEKDAYS_SHORT } from '@/lib/dates'
import { renderText } from '@/lib/fields'
import { ITEM_STATE_LABEL, itemStatus, reviewableGroups } from '@/lib/itemReviews'
import { effectiveStatus, isCompleted } from '@/lib/status'
import { useNow } from '@/lib/hooks'
import type { Profile, TaskInstance, TaskStep, TestRequest } from '@/lib/types'

/**
 * Desempenho diário: um card por dia da semana escolhida. Clicar no dia mostra
 * um card por analista; clicar no analista mostra tudo o que ele fez naquele dia,
 * com data e horário de cada entrega e o conteúdo registrado.
 */
export default function Daily() {
  const today = todayISO()
  const settings = useSettings()
  // Semana, dia, analista e atividade aberta ficam no endereço. Cada clique muda
  // tudo de uma vez: duas mudanças seguidas no endereço se sobrescreveriam.
  const [sp, setSp] = useSearchParams()
  const patch = (changes: Record<string, string | null>) => setSp((prev) => {
    const n = new URLSearchParams(prev)
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) n.delete(k)
      else n.set(k, v)
    }
    return n
  }, { replace: true })
  const weekParam = sp.get('semana')
  const dayParam = sp.get('dia')
  const userParam = sp.get('analista')
  const openId = sp.get('t')
  const setOpenId = (id: string | null) => patch({ t: id })

  const weekStart = startOfWeek(weekParam ?? dayParam ?? today)
  const weekEnd = addDays(weekStart, 6)
  const isCurrentWeek = weekStart === startOfWeek(today)

  const analystsQ = useAnalysts()
  const holidaysQ = useHolidays()
  // Volta um mês: pega semanais/mensais de outro período enviadas nesta semana.
  const facts = useFacts({ from: addDays(weekStart, -31), to: weekEnd })
  const daysOff = useDaysOff({ from: weekStart, to: weekEnd })

  const holidays = new Map((holidaysQ.data ?? []).map((h) => [h.day, h.label]))
  const workdays = settings.dias_uteis
  // Fim de semana só aparece se alguém enviou algo nele.
  const days = eachDay(weekStart, weekEnd).filter((d) => d <= today
    && (workdays.includes(isoWeekday(d)) || (facts.data ?? []).some((f) => deliveredOn(f, d))))
  const futureDays = eachDay(weekStart, weekEnd).filter((d) => d > today && workdays.includes(isoWeekday(d)))

  const summaries = useMemo(() => new Map(days.map((d) => [d, summarizeDay(facts.data ?? [], d)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [facts.data, days.join()])

  const selectedDay = dayParam && dayParam >= weekStart && dayParam <= weekEnd ? dayParam : null
  const selectedUser = selectedDay ? analystsQ.data.find((a) => a.id === userParam) ?? null : null

  const goWeek = (n: number) => patch({ semana: addDays(weekStart, 7 * n), dia: null, analista: null })
  const pickDay = (d: string) => patch({ semana: weekStart, dia: d === selectedDay ? null : d, analista: null })

  return (
    <>
      <PageHeader title="Desempenho diário"
        meta="Escolha um dia e depois um analista para ver tudo o que foi feito, com data e horário de cada entrega."
        actions={(
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} onClick={() => goWeek(-1)}>Semana anterior</Button>
            {!isCurrentWeek && <Button size="sm" variant="secondary" onClick={() => patch({ semana: null, dia: today, analista: null })}>Hoje</Button>}
            <Button size="sm" variant="ghost" disabled={isCurrentWeek} onClick={() => goWeek(1)}>
              Próxima semana<ChevronRight className="size-4" />
            </Button>
          </div>
        )} />

      <ErrorNote error={facts.error || analystsQ.error} />

      <Section title={`Semana de ${fmtDay(weekStart)} a ${fmtDay(weekEnd)}`} meta="um card por dia; clique para ver a equipe naquele dia">
        {facts.isLoading ? <Skeleton className="h-36" /> : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {/* Ordem da semana: segunda → sexta (sábado/domingo só se houve entrega). */}
            {days.map((d) => (
              <li key={d}>
                <DayCard day={d} summary={summaries.get(d)!} holiday={holidays.get(d)} isToday={d === today}
                  selected={d === selectedDay} onClick={() => pickDay(d)} />
              </li>
            ))}
            {futureDays.map((d) => (
              <li key={d} className="flex min-h-36 flex-col rounded-lg border border-dashed border-line px-4 py-3 text-faint">
                <span className="text-xs uppercase tracking-wide">{WEEKDAYS_SHORT[isoWeekday(d) - 1]}</span>
                <span className="font-display text-2xl font-semibold">{fmtDay(d)}</span>
                <span className="mt-auto text-xs">ainda não chegou</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {selectedDay && (
        <Section title={fmtDayLong(selectedDay)}
          meta={holidays.has(selectedDay) ? `Feriado: ${holidays.get(selectedDay)}. Não conta nas métricas.` : 'um card por analista; clique para ver o que ele fez'}>
          {analystsQ.isLoading ? <Skeleton className="h-28" /> : analystsQ.data.length === 0 ? (
            <EmptyState title="Nenhum analista ativo" />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {analystsQ.data.map((a) => {
                const off = (daysOff.data ?? []).find((x) => x.user_id === a.id && x.day === selectedDay)
                return (
                  <li key={a.id}>
                    <AnalystCard analyst={a} summary={summarizeDay(facts.data ?? [], selectedDay, a.id)}
                      offReason={off ? (off.reason ?? '') : undefined} selected={a.id === selectedUser?.id}
                      onClick={() => patch({ analista: a.id === selectedUser?.id ? null : a.id })} />
                  </li>
                )
              })}
            </ul>
          )}
        </Section>
      )}

      {selectedDay && selectedUser && (
        <AnalystDay key={selectedUser.id + selectedDay} analyst={selectedUser} day={selectedDay} onOpen={setOpenId} />
      )}

      <TaskPanel taskId={openId} onClose={() => setOpenId(null)} />
    </>
  )
}

function Progress({ value }: { value: number }) {
  return (
    <span className="block h-1.5 overflow-hidden rounded-sm bg-subtle" aria-hidden>
      <span className="block h-full bg-signal" style={{ width: `${Math.round(value * 100)}%` }} />
    </span>
  )
}

function DayCard({ day, summary: s, holiday, isToday, selected, onClick }: {
  day: string; summary: DaySummary; holiday?: string; isToday: boolean; selected: boolean; onClick: () => void
}) {
  const rate = s.expected ? s.done / s.expected : 0
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}
      className={cx('flex h-full min-h-36 w-full flex-col gap-2 rounded-lg border bg-surface px-4 py-3 text-left transition-colors',
        selected ? 'border-ink shadow-[inset_0_0_0_1px_rgb(var(--ink))]' : 'border-line hover:border-ink focus-visible:border-ink')}>
      <span className="flex items-center justify-between gap-2 text-xs uppercase tracking-wide text-muted">
        {WEEKDAYS_SHORT[isoWeekday(day) - 1]}
        {isToday && <span className="rounded-sm bg-signal px-1.5 py-0.5 font-semibold normal-case tracking-normal text-signal-ink">hoje</span>}
      </span>
      <span className="font-display text-2xl font-semibold leading-none">{fmtDay(day)}</span>
      {holiday ? (
        <span className="mt-auto inline-flex items-center gap-1.5 text-sm text-muted"><PartyPopper className="size-4" aria-hidden />{holiday}</span>
      ) : (
        <span className="mt-auto block space-y-1.5">
          <span className="flex items-baseline justify-between text-sm">
            <span><span className="font-semibold tabular-nums">{s.done}</span><span className="text-muted"> de {s.expected} feitas</span></span>
            {s.expected > 0 && <span className="tabular-nums text-muted">{Math.round(rate * 100)}%</span>}
          </span>
          <Progress value={rate} />
          <span className="flex flex-wrap gap-x-3 text-xs text-muted">
            <span>{s.deliveries} {s.deliveries === 1 ? 'entrega' : 'entregas'}</span>
            {s.missed > 0 && <span className="text-bad">{s.missed} não {s.missed === 1 ? 'feita' : 'feitas'}</span>}
          </span>
        </span>
      )}
    </button>
  )
}

function AnalystCard({ analyst, summary: s, offReason, selected, onClick }: {
  analyst: Profile; summary: DaySummary; offReason?: string; selected: boolean; onClick: () => void
}) {
  const rate = s.expected ? s.done / s.expected : 0
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}
      className={cx('flex h-full w-full flex-col gap-2 rounded-lg border bg-surface px-4 py-3 text-left transition-colors',
        selected ? 'border-ink shadow-[inset_0_0_0_1px_rgb(var(--ink))]' : 'border-line hover:border-ink focus-visible:border-ink')}>
      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate text-md font-semibold">{analyst.full_name}</span>
        {offReason === undefined && s.expected > 0 && <span className="font-display text-xl font-semibold tabular-nums">{Math.round(rate * 100)}%</span>}
      </span>
      {offReason !== undefined ? (
        <span className="inline-flex items-center gap-1.5 text-sm text-muted">
          <CalendarOff className="size-4 shrink-0" aria-hidden />Dia desativado{offReason ? `: ${offReason}` : ''}
        </span>
      ) : (
        <>
          <Progress value={rate} />
          <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-muted">
            <span><span className="font-medium text-ink tabular-nums">{s.done}</span> de {s.expected} feitas</span>
            {s.late > 0 && <span className="text-warn">{s.late} com atraso</span>}
            {s.missed > 0 && <span className="text-bad">{s.missed} não {s.missed === 1 ? 'feita' : 'feitas'}</span>}
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <Clock className="size-3.5" aria-hidden />
            {s.firstAt ? (s.firstAt === s.lastAt ? `entrega às ${fmtTime(s.firstAt)}` : `entregas das ${fmtTime(s.firstAt)} às ${fmtTime(s.lastAt!)}`) : 'nenhuma entrega no dia'}
          </span>
        </>
      )}
    </button>
  )
}

/** Tudo o que o analista fez no dia, em ordem de entrega, com o conteúdo registrado. */
function AnalystDay({ analyst, day, onOpen }: { analyst: Profile; day: string; onOpen: (id: string) => void }) {
  const work = useDayWork(day, analyst.id)
  const tasks = useMemo(() => [...(work.data ?? [])].sort((a, b) =>
    (a.submitted_at ?? '￿').localeCompare(b.submitted_at ?? '￿')
    || (a.template_snapshot.sort_order ?? 0) - (b.template_snapshot.sort_order ?? 0)), [work.data])
  const ids = tasks.map((t) => t.id)
  const steps = useSteps(ids)
  const itemReviews = useItemReviews(ids)
  const requestsQ = useTestRequests()
  const requests = (requestsQ.data ?? []).filter((r) => r.user_id === analyst.id && localDate(r.created_at) === day)

  const delivered = tasks.filter((t) => t.submitted_at && localDate(t.submitted_at) === day)
  const pending = tasks.filter((t) => !delivered.includes(t))

  return (
    <Section title={`${analyst.full_name} · ${fmtDayLong(day)}`}
      meta={work.isLoading ? undefined : `${delivered.length} ${delivered.length === 1 ? 'entrega' : 'entregas'} no dia${requests.length ? `, ${requests.length} ${requests.length === 1 ? 'solicitação de teste' : 'solicitações de teste'}` : ''}${pending.length ? `, ${pending.length} sem entrega` : ''}.`}>
      <ErrorNote error={work.error} />
      {work.isLoading ? <Skeleton className="h-48" /> : !tasks.length && !requests.length ? (
        <EmptyState title="Nada registrado neste dia">Não há atividades nem envios de {analyst.full_name} em {fmtDay(day)}.</EmptyState>
      ) : (
        <ol className="space-y-4">
          {delivered.map((t) => (
            <li key={t.id}><TaskCard task={t} steps={(steps.data ?? []).filter((s) => s.task_id === t.id)} reviews={itemReviews.data} onOpen={onOpen} /></li>
          ))}
          {requests.map((r) => <li key={r.id}><TestRequestCard request={r} /></li>)}
          {pending.map((t) => (
            <li key={t.id}><TaskCard task={t} steps={(steps.data ?? []).filter((s) => s.task_id === t.id)} reviews={itemReviews.data} onOpen={onOpen} /></li>
          ))}
        </ol>
      )}
    </Section>
  )
}

function TaskCard({ task, steps, reviews, onOpen }: {
  task: TaskInstance; steps: TaskStep[]; reviews: Parameters<typeof itemStatus>[0]; onOpen: (id: string) => void
}) {
  const now = useNow()
  const settings = useSettings()
  const text = useTextContext()
  const s = task.template_snapshot
  const st = effectiveStatus(task, now)
  const instructions = s.instructions ?? []
  const byIndex = new Map(steps.map((x) => [x.step_index, x]))
  const groups = isCompleted(task.status) ? reviewableGroups(s.fields) : []
  const hasPayload = Object.values(task.payload ?? {}).some((v) => v !== null && v !== '' && !(Array.isArray(v) && !v.length))

  return (
    <article className="rounded-lg border border-line bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs text-muted">{s.code ? `${s.code} · ` : ''}{s.frequency === 'diaria' ? 'Diária' : s.frequency === 'semanal' ? 'Semanal' : 'Mensal'}{task.curve ? ` · curva ${task.curve}` : ''}</p>
          <h3 className="text-lg font-semibold leading-6">{s.name}</h3>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <StatusLabel status={st} />
            {isCompleted(task.status) && <ReviewLabel status={task.review_status} />}
          </div>
        </div>
        <div className="text-right text-sm">
          {task.submitted_at ? (
            <>
              <p className="text-xs text-muted">Entregue em</p>
              <p className="font-display text-xl font-semibold tabular-nums">{fmtDateTime(task.submitted_at)}</p>
            </>
          ) : <p className="text-muted">Sem entrega</p>}
          <p className="text-xs text-muted">prazo {fmtDateTime(task.due_at)}</p>
        </div>
      </header>

      <div className="space-y-6 px-4 py-4">
        {instructions.length > 0 && (
          <Block title="Etapas" meta={`${byIndex.size} de ${instructions.length} marcadas`}>
            <ol className="space-y-1.5">
              {instructions.map((ins, i) => {
                const done = byIndex.get(i)
                return (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    {done ? <Check className="mt-0.5 size-4 shrink-0 text-ok" strokeWidth={3} aria-label="marcada" />
                      : <span className="mt-0.5 size-4 shrink-0 rounded-sm border border-line-strong" aria-label="não marcada" />}
                    <span className={cx('min-w-0 flex-1', !done && 'text-muted')}>{renderText(ins, text)}</span>
                    {done && <span className="shrink-0 text-xs tabular-nums text-muted">{fmtDateTime(done.checked_at)}</span>}
                  </li>
                )
              })}
            </ol>
          </Block>
        )}

        {s.fields.length > 0 && (hasPayload ? (
          <Block title="Conteúdo registrado">
            <FieldList defs={s.fields} value={task.payload} onChange={() => {}} ctx={{ text, settings, readOnly: true }} />
          </Block>
        ) : <p className="text-sm text-muted">Nenhum conteúdo registrado.</p>)}

        {groups.length > 0 && (
          <Block title="Aprovação das referências">
            <ul className="divide-y divide-line border-y border-line">
              {groups.flatMap((g) => ((Array.isArray(task.payload[g.key]) ? task.payload[g.key] : []) as Record<string, unknown>[]).map((item, i) => {
                const r = itemStatus(reviews, task.id, g.key, i)
                return (
                  <li key={`${g.key}${i}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                    <span>{g.item_label ?? g.label} {i + 1}{item.sku ? <span className="ml-2 font-mono text-muted">{String(item.sku)}</span> : null}</span>
                    <span className={cx('font-medium', r.state === 'aprovada' && 'text-ok', r.state === 'reprovada' && 'text-bad', r.state === 'pendente' && 'text-muted')}>
                      {ITEM_STATE_LABEL[r.state]}{r.reason ? `: ${r.reason}` : ''}
                    </span>
                  </li>
                )
              }))}
            </ul>
          </Block>
        )}

        {task.deviation && (task.deviation.skus.length > 0 || task.deviation.action) && (
          <div className="flex gap-2 rounded border border-bad/30 bg-bad/5 px-3 py-2 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden />
            <p><span className="font-medium">Desvio:</span> <span className="font-mono">{task.deviation.skus.join(', ')}</span>{task.deviation.action ? ` — ${task.deviation.action}` : ''}</p>
          </div>
        )}

        {task.followup && (s.followup_fields?.length ?? 0) > 0 && (
          <Block title="Leitura do resultado" meta={task.followup_at ? `registrada em ${fmtDateTime(task.followup_at)}` : undefined}>
            <FieldList defs={s.followup_fields} value={task.followup} onChange={() => {}} ctx={{ text, settings, readOnly: true }} />
          </Block>
        )}

        <div className="flex justify-end">
          <Button size="sm" variant="ghost" icon={<ExternalLink className="size-4" />} onClick={() => onOpen(task.id)}>Abrir a atividade completa</Button>
        </div>
      </div>
    </article>
  )
}

function TestRequestCard({ request: r }: { request: TestRequest }) {
  const tone = r.status === 'aprovada' ? 'text-ok' : r.status === 'reprovada' ? 'text-bad' : 'text-muted'
  const Icon = r.status === 'aprovada' ? Check : r.status === 'reprovada' ? X : Clock
  return (
    <article className="rounded-lg border border-line bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 space-y-1">
          <p className="inline-flex items-center gap-1.5 text-xs text-muted"><FlaskConical className="size-3.5" aria-hidden />Solicitação de teste</p>
          <h3 className="font-mono text-lg font-semibold leading-6">{r.sku}</h3>
          <p className={cx('inline-flex items-center gap-1.5 text-sm font-medium', tone)}>
            <Icon className="size-4" aria-hidden />{r.status === 'aprovada' ? 'Aprovada' : r.status === 'reprovada' ? 'Reprovada' : 'Aguardando aprovação'}
          </p>
        </div>
        <div className="text-right text-sm">
          <p className="text-xs text-muted">Enviada em</p>
          <p className="font-display text-xl font-semibold tabular-nums">{fmtDateTime(r.created_at)}</p>
        </div>
      </header>
      <dl className="grid gap-x-6 gap-y-3 px-4 py-4 sm:grid-cols-[minmax(0,220px)_1fr]">
        {([
          ['Análise', r.analysis],
          ['Explicação', r.explanation],
          ['Período do teste', `${fmtDay(r.start_date)} a ${fmtDay(r.end_date)}`],
          ...(r.review_reason ? [['Motivo do gestor', r.review_reason]] : []),
          ...(r.reviewed_at ? [['Decidida em', fmtDateTime(r.reviewed_at)]] : []),
        ] as [string, string][]).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-sm text-muted">{k}</dt>
            <dd className="whitespace-pre-wrap break-words">{v}</dd>
          </div>
        ))}
      </dl>
    </article>
  )
}
