import { isCompleted } from './status'
import type { TaskInstance } from './types'

/**
 * Blocos e marcos em sequência. Espelha public.task_lock_reason: uma atividade
 * sequencial só libera quando todas as sequenciais anteriores do MESMO período e
 * da MESMA frequência (mesmo dia, mesma semana ou mesmo mês) estiverem concluídas
 * (no prazo ou com atraso). O banco é quem garante; aqui serve para mostrar o
 * cadeado e o caminho.
 */

export interface BlockState {
  task: TaskInstance
  /** Posição na sequência (1, 2, 3…), só para atividades sequenciais. */
  position: number | null
  locked: boolean
  /** Nome da atividade que precisa ser concluída antes. */
  blockedBy: string | null
  stepsDone: number
  stepsTotal: number
  /** 0 a 1: etapas marcadas ÷ etapas (sem etapas: 1 se concluída). */
  progress: number
  /** Próxima a fazer no seu grupo: primeira liberada e não concluída. */
  current: boolean
}

export const stepsTotalOf = (t: Pick<TaskInstance, 'template_snapshot'>) => t.template_snapshot.instructions?.length ?? 0

/**
 * Pontos do bloco: cada etapa vale 1. Marcar todas as etapas já dá 100%.
 * Bloco sem etapas vale 1 ponto, ganho quando é concluído.
 */
export function blockPoints(stepsTotal: number, stepsDone: number, completed: boolean): { done: number; total: number } {
  const total = Math.max(stepsTotal, 1)
  if (completed) return { done: total, total }
  return { done: Math.min(Math.max(stepsDone, 0), stepsTotal), total }
}

/** Progresso do bloco: etapas marcadas ÷ etapas. */
export function blockProgress(stepsTotal: number, stepsDone: number, completed: boolean): number {
  const p = blockPoints(stepsTotal, stepsDone, completed)
  return p.done / p.total
}

/** Progresso agregado: etapas marcadas ÷ etapas de todos os blocos. */
export function dayProgress(blocks: Pick<BlockState, 'stepsDone' | 'stepsTotal' | 'task'>[]): number {
  let done = 0, total = 0
  for (const b of blocks) {
    const p = blockPoints(b.stepsTotal, b.stepsDone, isCompleted(b.task.status))
    done += p.done
    total += p.total
  }
  return total ? done / total : 0
}

const order = (t: TaskInstance) => t.template_snapshot.sort_order ?? 0
const isSeq = (t: TaskInstance) => !!t.template_snapshot.sequential
const groupOf = (t: TaskInstance) => `${t.template_snapshot.frequency}|${t.period_key}`

/** Estado de cada atividade. Aceita tarefas de vários grupos (dia, semana, mês) de uma vez. */
export function sequenceStates(tasks: TaskInstance[], stepsDone: ReadonlyMap<string, number>): BlockState[] {
  const sorted = [...tasks].sort((a, b) => order(a) - order(b) || a.due_at.localeCompare(b.due_at))
  const currentTaken = new Set<string>()
  const positions = new Map<string, number>()
  return sorted.map((task) => {
    const seq = isSeq(task)
    const g = groupOf(task)
    const blocker = seq
      ? sorted.find((b) => b.id !== task.id && isSeq(b) && groupOf(b) === g && order(b) < order(task)
          && !isCompleted(b.status) && b.status !== 'pausada')
      : undefined
    const done = stepsDone.get(task.id) ?? 0
    const completed = isCompleted(task.status)
    const locked = !!blocker && task.status !== 'pausada'
    const current = seq && !locked && !completed && !currentTaken.has(g) && task.status !== 'pausada'
    if (current) currentTaken.add(g)
    let position: number | null = null
    if (seq && task.status !== 'pausada') {
      position = (positions.get(g) ?? 0) + 1
      positions.set(g, position)
    }
    return {
      task,
      position,
      locked,
      blockedBy: blocker?.template_snapshot.name ?? null,
      stepsDone: done,
      stepsTotal: stepsTotalOf(task),
      progress: blockProgress(stepsTotalOf(task), done, completed),
      current,
    }
  })
}
