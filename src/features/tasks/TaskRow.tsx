import { forwardRef } from 'react'
import { useNow } from '@/lib/hooks'
import { Lock, RotateCcw } from 'lucide-react'
import { cx, StatusLabel } from '@/components/ui'
import { effectiveStatus, isCompleted } from '@/lib/status'
import { dueText, fmtDay, fmtDayOf, localDate } from '@/lib/dates'
import type { BlockState } from '@/lib/sequence'
import type { TaskInstance } from '@/lib/types'
import { Plate, plateState } from './Plate'

/** Uma linha do checklist: placa numerada, bloco ou marco, progresso e situação. */
export const TaskRow = forwardRef<HTMLButtonElement, {
  task: TaskInstance
  selected?: boolean
  showDate?: boolean
  block?: BlockState
  onOpen: () => void
  onFocus?: () => void
}>(function TaskRow({ task, selected, showDate, block, onOpen, onFocus }, ref) {
  const now = useNow()
  const s = task.template_snapshot
  const st = effectiveStatus(task, now)
  const done = isCompleted(task.status)
  const locked = !!block?.locked
  const state = plateState(task.status, task.due_at, now)
  const gateItems = s.gates?.length ?? 0
  const pct = Math.round((block?.progress ?? (done ? 1 : 0)) * 100)
  const due = dueText(localDate(task.due_at))
  const noun = s.frequency === 'diaria' ? 'Bloco' : 'Marco'

  const meta: string[] = []
  if (showDate) meta.push(`Dia ${fmtDay(task.ref_date)}`)
  if (task.curve) meta.push(`Curva ${task.curve}`)
  if (s.target_qty) meta.push(`Meta de ${s.target_qty} ${s.target_label ?? ''}`.trim())
  if (gateItems) meta.push(`${gateItems} verificaç${gateItems === 1 ? 'ão' : 'ões'}`)
  if (block && block.stepsTotal) meta.push(`${block.stepsDone} de ${block.stepsTotal} etapas`)

  const cta = block?.current ? (block.stepsDone > 0 ? 'Continuar' : 'Começar') : null

  return (
    <button
      ref={ref}
      type="button"
      onClick={locked ? undefined : onOpen}
      onFocus={onFocus}
      aria-disabled={locked || undefined}
      aria-current={selected ? 'true' : undefined}
      className={cx(
        'group grid w-full grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 border-b border-line px-1 py-3.5 text-left last:border-0 sm:grid-cols-[auto_1fr_auto] sm:px-3',
        locked ? 'cursor-not-allowed' : 'hover:bg-hover focus-visible:bg-hover focus-visible:outline-none',
        selected && !locked && 'bg-hover shadow-[inset_4px_0_0_rgb(var(--signal))]',
        block?.current && !selected && 'shadow-[inset_4px_0_0_rgb(var(--signal))]',
      )}
    >
      <span className={cx('relative', locked && 'opacity-50')}>
        <Plate label={block?.position ?? s.code ?? '·'} state={locked ? 'paused' : state} />
        {locked && <Lock className="absolute -right-1.5 -top-1.5 size-4 rounded-full bg-bg p-0.5 text-muted" aria-hidden />}
      </span>

      <span className={cx('min-w-0', locked && 'opacity-60')}>
        <span className="flex items-baseline gap-2">
          {block?.position && <span className="shrink-0 text-sm text-faint">{noun} {block.position}</span>}
          <span className={cx('truncate text-md font-semibold', done && 'font-medium text-muted')}>{s.name}</span>
          <span className="hidden shrink-0 text-sm text-faint sm:inline">{s.code}</span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 text-sm text-muted">
          {locked
            ? <span className="inline-flex items-center gap-1">Conclua “{block?.blockedBy}” para liberar</span>
            : meta.map((m) => <span key={m}>{m}</span>)}
          {task.needs_rework && (
            <span className="inline-flex items-center gap-1 font-medium text-bad"><RotateCcw className="size-3.5" aria-hidden />Contestada, corrigir</span>
          )}
        </span>
        {!locked && block && block.stepsTotal > 0 && (
          <span className="mt-2 flex items-center gap-2" aria-hidden>
            <span className="h-1.5 w-full max-w-56 overflow-hidden rounded-sm bg-subtle">
              <span className={cx('block h-full', done ? 'bg-ok' : 'bg-signal')} style={{ width: `${pct}%` }} />
            </span>
            <span className="text-sm tabular-nums text-muted">{pct}%</span>
          </span>
        )}
      </span>

      <span className="col-span-2 flex items-center justify-between gap-4 pl-[calc(3.25rem+1rem)] sm:col-span-1 sm:block sm:pl-0 sm:text-right">
        {cta ? (
          <span className="inline-flex h-9 items-center rounded bg-signal px-4 text-base font-semibold text-signal-ink">{cta}</span>
        ) : locked ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted"><Lock className="size-4" aria-hidden />Bloqueado</span>
        ) : (
          <StatusLabel status={st} />
        )}
        <span className={cx('block text-sm', (st === 'nao_feita' || due.late) && !done && !locked ? 'font-medium text-bad' : 'text-muted')}>
          {task.status === 'pausada' ? 'fora de vigência'
            : done && task.submitted_at ? `enviada em ${fmtDayOf(task.submitted_at)}`
            : due.text}
        </span>
      </span>
    </button>
  )
})
