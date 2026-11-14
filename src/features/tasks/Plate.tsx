import { cx } from '@/components/ui'
import { isCompleted } from '@/lib/status'
import type { TaskStatus } from '@/lib/types'

export type PlateState = 'open' | 'late' | 'done' | 'paused'

/**
 * Estado visual da placa. O prazo é por data: vale até o fim do dia de vencimento,
 * então só fica "atrasada" depois que o dia passou.
 */
export function plateState(status: TaskStatus, dueAt: string, now: number): PlateState {
  if (status === 'pausada') return 'paused'
  if (isCompleted(status)) return 'done'
  if (new Date(dueAt).getTime() < now) return 'late'
  return 'open'
}

const SIZE = {
  sm: 'h-9 min-w-[2.25rem] px-2 text-xl',
  md: 'h-12 min-w-[3.25rem] px-2.5 text-3xl',
  lg: 'h-14 min-w-[3.75rem] px-3 text-4xl',
  xl: 'h-20 min-w-[5.25rem] px-4 text-5xl',
}

/** A placa numera o bloco (ou marco) na sequência: 1, 2, 3… */
export function Plate({ label, state, size = 'md', className }: {
  label: string | number; state: PlateState; size?: keyof typeof SIZE; className?: string
}) {
  return (
    <span className={cx('plate', `plate-${state}`, SIZE[size], className)}>
      {label}
    </span>
  )
}
