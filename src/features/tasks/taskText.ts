import { addDays, fmtDay, fmtDayLong, fmtMonth } from '@/lib/dates'
import type { Frequency, TaskInstance } from '@/lib/types'

export const FREQ_LABEL: Record<Frequency, string> = { diaria: 'Diária', semanal: 'Semanal', mensal: 'Mensal' }

export function periodLabel(t: Pick<TaskInstance, 'ref_date' | 'period_start' | 'period_end' | 'template_snapshot'>): string {
  const f = t.template_snapshot.frequency
  if (f === 'semanal') return `Semana de ${fmtDay(t.period_start)} a ${fmtDay(addDays(t.period_start, 4))}`
  if (f === 'mensal') return fmtMonth(t.period_start)
  return fmtDayLong(t.ref_date)
}
