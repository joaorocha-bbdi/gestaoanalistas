import { useMemo, useRef, useState } from 'react'
import { Check, CheckCircle2, Lock, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { TestRequestDialog } from '@/features/tests/TestRequestDialog'
import { Button, cx, EmptyState, ErrorNote, Section, Segmented, Skeleton } from '@/components/ui'
import { TaskPanel } from '@/features/tasks/TaskPanel'
import { TaskRow } from '@/features/tasks/TaskRow'
import { Plate } from '@/features/tasks/Plate'
import { stepCounts, useDashboard, useSettings } from '@/data/queries'
import { itemStatus, reviewableGroups } from '@/lib/itemReviews'
import { fmtDayLong, isoWeekday, startOfWeek, todayISO } from '@/lib/dates'
import { useHotkeys, useNow, useSearchParamState } from '@/lib/hooks'
import { dayProgress, sequenceStates, type BlockState } from '@/lib/sequence'
import { isCompleted } from '@/lib/status'
import type { Payload, TaskInstance } from '@/lib/types'

type Tab = 'diario' | 'semanal' | 'mensal'
const TAB_LABEL: Record<Tab, string> = { diario: 'Diário', semanal: 'Semanal', mensal: 'Mensal' }

export default function Today() {
  const { profile } = useAuth()
  const today = todayISO()
  const now = useNow()
  const settings = useSettings()
  // Uma chamada só traz tarefas, etapas, aprovações e solicitações (dashboard_today).
  // A semana recomeça toda segunda: pendências só desta semana (as de antes ficam com o gestor).
  const weekStart = startOfWeek(today)
  const dash = useDashboard(profile?.id, today, weekStart)
  const [openId, setOpenId] = useSearchParamState('t')
  const [tabParam, setTab] = useSearchParamState('aba')
  const [sel, setSel] = useState(0)
  const [requesting, setRequesting] = useState(false)
  const requests = { data: dash.data?.test_requests }
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])

  const { daily, weekly, monthly, carry } = useMemo(() => {
    const all = dash.data?.tasks ?? []
    const cur = all.filter((t) => t.period_start <= today && t.period_end >= today)
    // Pendências de dias anteriores: ainda dá para enviar (conta como atraso) ou corrigir contestação.
    const carry = all.filter((t) => t.ref_date < today && t.ref_date >= weekStart && !cur.some((c) => c.id === t.id) && t.status !== 'pausada')
    return {
      daily: cur.filter((t) => t.template_snapshot.frequency === 'diaria'),
      weekly: cur.filter((t) => t.template_snapshot.frequency === 'semanal'),
      monthly: cur.filter((t) => t.template_snapshot.frequency === 'mensal'),
      carry,
    }
  }, [dash.data, today, weekStart])

  const counts = useMemo(() => stepCounts(dash.data?.steps), [dash.data])

  // Estado de cada bloco: sequência e progresso por etapas (cada dia tem a sua sequência).
  const blocks = useMemo(() => sequenceStates(daily, counts), [daily, counts])
  const states = useMemo(() => {
    const m = new Map<string, BlockState>()
    for (const b of blocks) m.set(b.task.id, b)
    // Cada período (dia, semana, mês) tem a sua sequência; sequenceStates agrupa sozinho.
    for (const b of sequenceStates([...carry, ...weekly, ...monthly], counts)) m.set(b.task.id, b)
    return m
  }, [blocks, carry, weekly, monthly, counts])

  // Retorno do gestor sobre os testes do mês (aprovado ou reprovado, por referência).
  const itemQ = { data: dash.data?.item_reviews }
  const feedback = useMemo(() => monthly.flatMap((t) => reviewableGroups(t.template_snapshot.fields).flatMap((g) =>
    ((Array.isArray(t.payload[g.key]) ? t.payload[g.key] : []) as Payload[]).map((item, index) => ({
      task: t, label: `${g.item_label ?? g.label} ${index + 1}`, sku: item.sku ? String(item.sku) : '', st: itemStatus(itemQ.data, t.id, g.key, index),
    })))).filter((f) => f.st.state !== 'pendente'), [monthly, itemQ.data])
  const rejected = feedback.filter((f) => f.st.state === 'reprovada')

  const tab: Tab = (tabParam as Tab) in TAB_LABEL ? (tabParam as Tab) : 'diario'
  const inOrder = (list: TaskInstance[]) => sequenceStates(list, counts).map((b) => b.task)
  const visible: TaskInstance[] = tab === 'diario' ? [...carry, ...blocks.map((b) => b.task)] : tab === 'semanal' ? inOrder(weekly) : inOrder(monthly)

  const progress = dayProgress(blocks)
  const doneToday = blocks.filter((b) => isCompleted(b.task.status)).length
  const currentBlock = blocks.find((b) => b.current)
  const curve = settings.curva_por_dia?.[String(isoWeekday(today))]

  useHotkeys({
    j: () => move(1),
    k: () => move(-1),
    enter: () => { const t = visible[sel]; if (t && !states.get(t.id)?.locked) setOpenId(t.id) },
  }, !openId)

  function move(d: number) {
    const n = Math.min(Math.max(sel + d, 0), visible.length - 1)
    setSel(n)
    rowRefs.current[n]?.focus()
  }
  /** Depois de concluir um bloco, abre o próximo liberado. */
  function navigatePanel(dir: 1 | -1) {
    const i = visible.findIndex((t) => t.id === openId)
    const nextTask = visible.slice(i + 1).find((t) => (!isCompleted(t.status) || t.needs_rework) && !states.get(t.id)?.locked)
    if (dir === 1 && nextTask) { setOpenId(nextTask.id); setSel(visible.indexOf(nextTask)) }
    else setOpenId(null)
  }

  let idx = 0
  const rows = (list: TaskInstance[], showDate = false) => list.map((t) => {
    const i = idx++
    return (
      <TaskRow
        key={t.id}
        ref={(el) => { rowRefs.current[i] = el }}
        task={t} now={now} selected={sel === i} showDate={showDate} block={states.get(t.id)}
        onFocus={() => setSel(i)}
        onOpen={() => { setSel(i); setOpenId(t.id) }}
      />
    )
  })

  const loading = dash.isLoading
  const weekend = isoWeekday(today) > 5
  const pct = Math.round(progress * 100)

  // Expediente é de segunda a sexta: no fim de semana não há nada para fazer.
  if (weekend) {
    return (
      <>
        <h1 className="mb-6 text-3xl font-semibold">{fmtDayLong(today)}</h1>
        <EmptyState title="Sem expediente hoje">
          As atividades valem de segunda a sexta. Na segunda-feira a semana recomeça com o checklist novo.
        </EmptyState>
      </>
    )
  }

  return (
    <>
      <header className="mb-10">
        <h1 className="text-3xl font-semibold">{fmtDayLong(today)}</h1>
        {loading ? <Skeleton className="mt-4 h-28" /> : blocks.length > 0 && (
          <div className="mt-5 grid gap-x-10 gap-y-5 border-t-2 border-ink pt-5 md:grid-cols-[auto_1fr] md:items-center">
            <div>
              <p className="font-display text-5xl font-semibold tabular-nums" aria-label={`${pct}% do dia concluído`}>{pct}%</p>
              <p className="text-md text-muted">do dia concluído</p>
            </div>
            <div className="min-w-0">
              {currentBlock ? (
                <div className="flex items-center gap-4">
                  <Plate label={currentBlock.position ?? '·'} state={new Date(currentBlock.task.due_at).getTime() < now ? 'late' : 'open'} size="lg" />
                  <div className="min-w-0">
                    <p className="text-sm text-muted">
                      {currentBlock.stepsDone > 0 ? 'Continue de onde parou' : 'Comece por aqui'}, bloco {currentBlock.position} de {blocks.filter((b) => b.position).length}
                    </p>
                    <p className="text-2xl font-semibold leading-7">{currentBlock.task.template_snapshot.name}</p>
                    {currentBlock.task.curve && <p className="text-md">Curva do dia: <span className="font-semibold">{currentBlock.task.curve}</span></p>}
                  </div>
                </div>
              ) : (
                <p className="text-2xl font-semibold">
                  {doneToday === blocks.length ? 'Todos os blocos de hoje foram concluídos.' : 'Não há bloco liberado no momento.'}
                  {curve && <span className="mt-1 block text-md font-normal">Curva do dia: <span className="font-semibold">{curve}</span></span>}
                </p>
              )}
            </div>
            <div className="md:col-span-2">
              <Lamps blocks={blocks} />
              <p className="mt-2 text-sm text-muted tnum">{doneToday} de {blocks.length} blocos concluídos</p>
            </div>
          </div>
        )}
      </header>

      <div className="mb-6">
        <Segmented<Tab>
          ariaLabel="Frequência"
          value={tab}
          onChange={(v) => { setTab(v); setSel(0) }}
          options={(Object.keys(TAB_LABEL) as Tab[]).map((k) => {
            const n = k === 'diario' ? blocks.length + carry.length : k === 'semanal' ? weekly.length : monthly.length
            return { value: k, label: `${TAB_LABEL[k]}${n ? ` (${n})` : ''}` }
          })}
        />
      </div>

      {rejected.length > 0 && tab !== 'mensal' && (
        <button type="button" onClick={() => setTab('mensal')}
          className="mb-6 flex w-full items-center gap-2 rounded border border-bad/30 bg-bad/5 px-4 py-3 text-left text-sm hover:bg-bad/10">
          <X className="size-4 shrink-0 text-bad" aria-hidden />
          <span><span className="font-medium">{rejected.length === 1 ? '1 teste foi reprovado' : `${rejected.length} testes foram reprovados`}</span>{' '}
            e aguarda sua correção. Abrir o checklist mensal.</span>
        </button>
      )}

      <ErrorNote error={dash.error} />

      {loading ? (
        <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : tab === 'diario' ? (
        <>
          {carry.length > 0 && (
            <Section title="Pendências desta semana" meta="Ainda dá para enviar, mas conta como atraso. Na segunda-feira a lista recomeça.">
              <div>{rows(carry, true)}</div>
            </Section>
          )}
          <Section title="Blocos de hoje" meta={blocks.length ? 'Cada bloco só libera quando o anterior for concluído.' : undefined}>
            {blocks.length ? <div>{rows(blocks.map((b) => b.task))}</div> : (
              <EmptyState title={weekend ? 'Sem expediente hoje' : 'Nenhuma atividade diária para hoje'}>
                {weekend
                  ? 'As atividades diárias voltam no próximo dia útil.'
                  : 'Pode ser feriado ou as atividades estão pausadas. Se não era esperado, fale com o gestor.'}
              </EmptyState>
            )}
          </Section>
          {blocks.length > 0 && doneToday === blocks.length && carry.length === 0 && (
            <p className="flex items-center gap-2 text-sm text-muted">
              <CheckCircle2 className="size-4 text-ok" aria-hidden /> Tudo de hoje concluído. Se o gestor contestar algo, o bloco volta para esta lista.
            </p>
          )}
        </>
      ) : (
        <>
        {tab === 'mensal' && feedback.length > 0 && (
          <Section title="Retorno do gestor sobre os seus testes" meta="cada referência é avaliada separadamente">
            <ul className="divide-y divide-line border-y border-line">
              {feedback.map((f, i) => (
                <li key={i}>
                  <button type="button" onClick={() => setOpenId(f.task.id)} className="flex w-full items-start gap-3 py-3 text-left hover:bg-hover sm:px-2">
                    {f.st.state === 'aprovada'
                      ? <Check className="mt-0.5 size-5 shrink-0 text-ok" strokeWidth={2.5} aria-hidden />
                      : <X className="mt-0.5 size-5 shrink-0 text-bad" strokeWidth={2.5} aria-hidden />}
                    <span className="min-w-0">
                      <span className="block text-md font-semibold">
                        {f.label}{f.sku ? <span className="ml-2 font-normal text-muted">{f.sku}</span> : null}
                        <span className={cx('ml-3 text-sm font-medium', f.st.state === 'aprovada' ? 'text-ok' : 'text-bad')}>
                          {f.st.state === 'aprovada' ? 'Teste aprovado' : 'Teste reprovado'}
                        </span>
                      </span>
                      {f.st.state === 'reprovada' && f.st.reason && <span className="block text-sm">Motivo: {f.st.reason}</span>}
                      {f.st.state === 'reprovada' && <span className="block text-sm text-muted">Abra para corrigir e reenviar esta referência.</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section title={tab === 'semanal' ? 'Checklist da semana' : 'Checklist do mês'}
          meta={tab === 'semanal' ? 'Vence no último dia útil da semana.' : 'Abre no dia 1 e vence no último dia do mês.'}>
          {visible.length ? <div>{rows(visible, true)}</div> : (
            <EmptyState title={tab === 'semanal' ? 'Nada semanal para esta semana' : 'Nada mensal para este mês'}>
              Quando houver atividade {tab === 'semanal' ? 'semanal' : 'mensal'} atribuída a você, ela aparece aqui.
            </EmptyState>
          )}
        </Section>
        </>
      )}

      <Section title="Solicitar teste" meta="Opcional. Peça um teste para uma referência; ele só começa depois da aprovação do gestor.">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-dashed border-line-strong px-5 py-4">
          <p className="text-sm text-muted">
            {(() => {
              const list = requests.data ?? []
              if (!list.length) return 'Você ainda não solicitou testes.'
              const n = (st: string) => list.filter((r) => r.status === st).length
              return `${n('pendente')} aguardando aprovação, ${n('aprovada')} aprovados, ${n('reprovada')} reprovados.`
            })()}{' '}
            <Link to="/testes" className="font-medium text-ink underline underline-offset-2">Ver meus testes</Link>
          </p>
          <Button variant="primary" onClick={() => setRequesting(true)}>Solicitar teste</Button>
        </div>
      </Section>
      <TestRequestDialog key={requesting ? 'aberto' : 'fechado'} open={requesting} onClose={() => setRequesting(false)} />

      <p className="mt-2 flex items-center gap-1.5 text-sm text-faint">
        <Lock className="size-3.5" aria-hidden /> O que está bloqueado libera sozinho quando o bloco anterior for concluído.
      </p>

      <TaskPanel taskId={openId} onClose={() => setOpenId(null)} onNavigate={navigatePanel} />
    </>
  )
}

/** Um segmento por bloco: o preenchimento mostra o progresso (etapas + envio). */
function Lamps({ blocks }: { blocks: BlockState[] }) {
  return (
    <ol className="flex gap-1.5" aria-label="Progresso de cada bloco de hoje">
      {blocks.map((b) => {
        const done = isCompleted(b.task.status)
        return (
          <li
            key={b.task.id}
            title={`${b.task.template_snapshot.name}: ${Math.round(b.progress * 100)}%`}
            className={cx('h-3 flex-1 overflow-hidden rounded-sm bg-subtle', b.locked && 'opacity-60')}
          >
            <div className={cx('h-full transition-[width] duration-200', done ? 'bg-ok' : 'bg-signal')} style={{ width: `${b.progress * 100}%` }} />
          </li>
        )
      })}
    </ol>
  )
}
