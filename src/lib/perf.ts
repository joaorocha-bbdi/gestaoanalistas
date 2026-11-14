import type { TaskFact, TaskStep } from './types'

/**
 * Funções puras usadas para responder rápido na tela sem mudar regra nenhuma:
 * atualização otimista de etapas e uma única busca de fatos para vários recortes.
 */

/** Marca ou desmarca uma etapa localmente (o banco confirma depois; se recusar, a tela volta). */
export function applyStepToggle(steps: TaskStep[] | undefined, taskId: string, index: number, checked: boolean,
  who: { id: string; name: string }, now = new Date().toISOString()): TaskStep[] {
  const list = steps ?? []
  const without = list.filter((s) => !(s.task_id === taskId && s.step_index === index))
  if (!checked) return without
  return [...without, {
    id: `otimista-${taskId}-${index}`, task_id: taskId, step_index: index, checked_at: now, checked_by: who.id,
    user: { full_name: who.name },
  }].sort((a, b) => a.task_id.localeCompare(b.task_id) || a.step_index - b.step_index)
}

/** Menor intervalo que cobre todos os recortes pedidos (uma busca só no banco). */
export function coveringRange(ranges: { from: string; to: string }[]): { from: string; to: string } {
  return {
    from: ranges.reduce((m, r) => (r.from < m ? r.from : m), ranges[0].from),
    to: ranges.reduce((m, r) => (r.to > m ? r.to : m), ranges[0].to),
  }
}

/** Recorta, já no navegador, os fatos de um intervalo (inclusive nas pontas). */
export function sliceFacts(rows: TaskFact[] | undefined, from: string, to: string): TaskFact[] {
  return (rows ?? []).filter((f) => f.ref_date >= from && f.ref_date <= to)
}

/** Agrupa etapas por tarefa. */
export function stepsByTask(steps: TaskStep[] | undefined): Map<string, TaskStep[]> {
  const m = new Map<string, TaskStep[]>()
  for (const s of steps ?? []) m.set(s.task_id, [...(m.get(s.task_id) ?? []), s])
  return m
}
