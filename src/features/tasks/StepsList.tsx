import { Check, Loader2, Lock } from 'lucide-react'
import { cx } from '@/components/ui'
import { renderText, type TextContext } from '@/lib/fields'
import { fmtDateTime } from '@/lib/dates'
import type { TaskStep } from '@/lib/types'
import { blockProgress } from '@/lib/sequence'
import { Linkify } from './Linkify'

/**
 * Etapas do bloco, em ordem. Só a próxima pode ser marcada; só a última marcada
 * pode ser desmarcada. Cada marcação mostra quem marcou e quando (o admin vê o mesmo).
 */
export function StepsList({ steps, texts, done, editable, completed, pendingIndex, onToggle, text }: {
  steps: string[]
  texts: TaskStep[]
  done: number
  editable: boolean
  completed: boolean
  pendingIndex?: number | null
  onToggle: (index: number, checked: boolean) => void
  text: TextContext
}) {
  const total = steps.length
  const progress = blockProgress(total, done, completed)
  const byIndex = new Map(texts.map((s) => [s.step_index, s]))
  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <div className="h-2.5 flex-1 overflow-hidden rounded-sm bg-subtle" role="progressbar" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)} aria-label="Progresso do bloco">
          <div className="h-full bg-signal transition-[width] duration-200" style={{ width: `${progress * 100}%` }} />
        </div>
        <span className="font-display text-xl font-semibold tabular-nums">{Math.round(progress * 100)}%</span>
      </div>
      <p className="-mt-2 mb-4 text-sm text-muted">
        {completed
          ? 'Bloco concluído.'
          : done < total
            ? `${done} de ${total} etapas marcadas.`
            : 'Todas as etapas marcadas. Envie o registro para concluir o bloco e liberar o próximo.'}
      </p>

      <ol className="divide-y divide-line border-y border-line">
        {steps.map((raw, i) => {
          const checked = i < done
          const isNext = i === done
          const isLast = i === done - 1
          const rec = byIndex.get(i)
          const canToggle = editable && (isNext || isLast)
          const busy = pendingIndex === i
          return (
            <li key={i} className="flex items-start gap-3 py-3">
              <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                aria-label={`Etapa ${i + 1}: ${renderText(raw, text)}`}
                disabled={!canToggle || busy}
                onClick={() => onToggle(i, !checked)}
                className={cx(
                  'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded border-2 transition-colors',
                  checked ? 'border-signal bg-signal text-signal-ink' : 'border-line-strong bg-surface',
                  canToggle && !checked && 'border-ink hover:bg-hover',
                  !canToggle && !checked && 'border-line',
                  !canToggle && 'cursor-default',
                )}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : checked ? <Check className="size-4" strokeWidth={3} aria-hidden /> : null}
              </button>
              <div className="min-w-0 flex-1">
                <p className={cx('text-md', checked ? 'text-muted' : isNext && editable ? 'font-medium' : !checked && !isNext ? 'text-muted' : '')}>
                  <span className="mr-2 text-sm text-faint">{i + 1}.</span>
                  <Linkify text={renderText(raw, text)} />
                </p>
                {rec && (
                  <p className="mt-0.5 text-sm text-muted">
                    Marcada por {rec.user?.full_name ?? 'usuário'} em {fmtDateTime(rec.checked_at)}
                  </p>
                )}
                {!checked && !isNext && editable && (
                  <p className="mt-0.5 flex items-center gap-1 text-sm text-faint"><Lock className="size-3" aria-hidden />Marque a etapa {i} antes.</p>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
