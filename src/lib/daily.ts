import { localDate } from './dates'
import type { TaskFact } from './types'

/** Resumo do que aconteceu num dia (de toda a equipe ou de um analista). */
export interface DaySummary {
  /** Atividades do dia (data de referência) que contam nas métricas, mesmo as ainda no prazo. */
  expected: number
  /** Dessas, quantas foram concluídas (no prazo ou com atraso). */
  done: number
  /** Dessas, quantas foram concluídas com atraso. */
  late: number
  /** Dessas, quantas ficaram sem fazer. */
  missed: number
  /** Envios feitos no dia (qualquer atividade, inclusive semanais e mensais). */
  deliveries: number
  /** Primeiro e último envio do dia. */
  firstAt: string | null
  lastAt: string | null
  /** Analistas que enviaram algo no dia. */
  people: number
}

/** A atividade foi enviada neste dia (horário de São Paulo)? */
export function deliveredOn(f: Pick<TaskFact, 'submitted_at'>, day: string): boolean {
  return !!f.submitted_at && localDate(f.submitted_at) === day
}

export function summarizeDay(facts: TaskFact[], day: string, userId?: string): DaySummary {
  const xs = userId ? facts.filter((f) => f.user_id === userId) : facts
  const due = xs.filter((f) => f.ref_date === day && f.status !== 'pausada')
  const delivered = xs.filter((f) => deliveredOn(f, day))
  const times = delivered.map((f) => f.submitted_at as string).sort()
  return {
    expected: due.length,
    done: due.filter((f) => f.completed).length,
    late: due.filter((f) => f.status === 'concluida_atraso').length,
    missed: due.filter((f) => f.status === 'nao_feita').length,
    deliveries: delivered.length,
    firstAt: times[0] ?? null,
    lastAt: times[times.length - 1] ?? null,
    people: new Set(delivered.map((f) => f.user_id)).size,
  }
}
