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
  /** 0 a 1: (etapas marcadas + 1 se concluída) ÷ (etapas + 1). */
  progress: number
  /** Próxima a fazer no seu grupo: primeira liberada e não concluída. */
  current: boolean
}

export const stepsTotalOf = (t: Pick<TaskInstance, 'template_snapshot'>) => t.template_snapshot.instructions?.length ?? 0

/**
 * Progresso do bloco. 100% só depois do envio aceito: o envio conta como o
 * último ponto, então marcar todas as etapas dá n ÷ (n+1), nunca 100%.
 */
export function blockProgress(stepsTotal: number, stepsDone: number, completed: boolean): number {
  if (completed) return 1
  return Math.min(Math.max(stepsDone, 0), stepsTotal) / (stepsTotal + 1)
}

/** Progresso agregado: pontos feitos ÷ pontos totais (cada etapa e cada envio valem 1 ponto). */
export function dayProgress(blocks: Pick<BlockState, 'stepsDone' | 'stepsTotal' | 'task'>[]): number {
  let done = 0, total = 0
  for (const b of blocks) {
    const completed = isCompleted(b.task.status)
    total += b.stepsTotal + 1
    done += completed ? b.stepsTotal + 1 : Math.min(b.stepsDone, b.stepsTotal)
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
