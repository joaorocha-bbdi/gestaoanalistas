import { isPlenary } from './status'
import { startOfWeek, startOfMonth } from './dates'
import type { EfficiencyWeights, TaskFact } from './types'

/**
 * Todas as métricas saem de linhas de public.v_task_facts. Nenhum contador
 * é guardado: qualquer número na tela pode ser refeito a partir dos dados brutos.
 * Taxas de conclusão, pontualidade e qualidade são ponderadas pelo peso da atividade.
 */

export interface MetricSet {
  counts: {
    total: number
    expected: number
    completed: number
    onTime: number
    late: number
    missed: number
    reviewed: number
    contested: number
    gateTasks: number
    gateBlockedTasks: number
    gateBlockEvents: number
    plenary: number
  }
  completionRate: number | null
  punctualityRate: number | null
  qualityRate: number | null
  gateBlockRate: number | null
  efficiency: number | null
}

export const DEFAULT_WEIGHTS: EfficiencyWeights = { conclusao: 40, pontualidade: 30, qualidade: 30 }

const ratio = (num: number, den: number) => (den > 0 ? num / den : null)

export function computeMetrics(all: TaskFact[], _weights: EfficiencyWeights = DEFAULT_WEIGHTS): MetricSet {
  const facts = all.filter((f) => f.status !== 'pausada')
  const w = (xs: TaskFact[]) => xs.reduce((s, f) => s + Number(f.weight || 1), 0)

  const expected = facts.filter((f) => f.expected)
  const completed = facts.filter((f) => f.completed)
  const onTime = completed.filter((f) => f.on_time)
  const reviewed = completed.filter((f) => f.reviewed)
  const accepted = reviewed.filter((f) => !f.contested)
  const gateTasks = facts.filter((f) => f.has_gates && f.submission_count > 0)
  const gateBlocked = gateTasks.filter((f) => f.gate_block_count > 0)

  const completionRate = ratio(w(expected.filter((f) => f.completed)), w(expected))
  const punctualityRate = ratio(w(onTime), w(completed))
  const qualityRate = ratio(w(accepted), w(reviewed))
  const gateBlockRate = ratio(gateBlocked.length, gateTasks.length)

  return {
    counts: {
      total: facts.length,
      expected: expected.length,
      completed: completed.length,
      onTime: onTime.length,
      late: completed.length - onTime.length,
      missed: expected.filter((f) => f.status === 'nao_feita' || f.status === 'bloqueada_gate').length,
      reviewed: reviewed.length,
      contested: completed.filter((f) => f.contested).length,
      gateTasks: gateTasks.length,
      gateBlockedTasks: gateBlocked.length,
      gateBlockEvents: facts.reduce((s, f) => s + f.gate_block_count, 0),
      plenary: facts.filter(isPlenary).length,
    },
    completionRate,
    punctualityRate,
    qualityRate,
    gateBlockRate,
    efficiency: efficiencyPercent(facts),
  }
}

/**
 * Eficiência em porcentagem, simples: atividades concluídas ÷ atividades esperadas.
 * Esperada = já venceu ou já foi concluída (pausadas não entram). Sem peso por atividade.
 */
export function efficiencyPercent(all: TaskFact[]): number | null {
  const expected = all.filter((f) => f.status !== 'pausada' && f.expected)
  if (!expected.length) return null
  return Math.round((expected.filter((f) => f.completed).length / expected.length) * 1000) / 10
}

/**
 * Índice 0–100: média ponderada dos componentes disponíveis.
 * Componente sem base (ex.: nada revisado) sai do cálculo e os pesos restantes são renormalizados.
 */
export function efficiencyIndex(
  r: { completionRate: number | null; punctualityRate: number | null; qualityRate: number | null },
  weights: EfficiencyWeights = DEFAULT_WEIGHTS,
): number | null {
  const parts: [number | null, number][] = [
    [r.completionRate, weights.conclusao],
    [r.punctualityRate, weights.pontualidade],
    [r.qualityRate, weights.qualidade],
  ]
  let num = 0, den = 0
  for (const [rate, wt] of parts) {
    if (rate === null || !(wt > 0)) continue
    num += rate * wt
    den += wt
  }
  return den > 0 ? Math.round((num / den) * 1000) / 10 : null
}

/** Dias consecutivos (mais recentes primeiro) em que tudo o que venceu no dia foi pleno. */
export function streak(facts: TaskFact[], today: string): number {
  const byDay = groupBy(facts.filter((f) => f.status !== 'pausada' && f.frequency === 'diaria' && f.ref_date <= today), (f) => f.ref_date)
  const days = [...byDay.keys()].sort().reverse()
  let n = 0
  for (const d of days) {
    const items = byDay.get(d)!
    if (d === today && items.some((f) => !f.expected)) continue // dia ainda em curso
    if (items.every(isPlenary)) n++
    else break
  }
  return n
}

export interface DayProgress {
  day: string
  planned: number
  done: number
  onTime: number
  open: number
}

/** Previsto vs. realizado por dia (contagem simples, inclui o que ainda vai vencer). */
export function dayProgress(facts: TaskFact[], days: string[]): DayProgress[] {
  const byDay = groupBy(facts.filter((f) => f.status !== 'pausada'), (f) => f.ref_date)
  return days.map((day) => {
    const items = byDay.get(day) ?? []
    const done = items.filter((f) => f.completed)
    return {
      day,
      planned: items.length,
      done: done.length,
      onTime: done.filter((f) => f.on_time).length,
      open: items.filter((f) => !f.completed && !f.expected).length,
    }
  })
}

export function trend(
  facts: TaskFact[],
  by: 'semana' | 'mes',
  weights: EfficiencyWeights = DEFAULT_WEIGHTS,
): { period: string; metrics: MetricSet }[] {
  const key = (f: TaskFact) => (by === 'semana' ? startOfWeek(f.ref_date) : startOfMonth(f.ref_date))
  const groups = groupBy(facts, key)
  return [...groups.keys()].sort().map((period) => ({ period, metrics: computeMetrics(groups.get(period)!, weights) }))
}

export function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>()
  for (const x of xs) {
    const k = key(x)
    const arr = m.get(k)
    if (arr) arr.push(x)
    else m.set(k, [x])
  }
  return m
}

export const pct = (r: number | null | undefined, digits = 0) =>
  r === null || r === undefined ? '—' : `${(r * 100).toFixed(digits).replace('.', ',')}%`

export const METRIC_DOCS = {
  conclusao: {
    label: 'Conclusão',
    formula: 'Σ peso das concluídas ÷ Σ peso das esperadas no período.',
    detail: 'Esperada = já venceu ou já foi concluída. Pausadas não entram.',
  },
  pontualidade: {
    label: 'Pontualidade',
    formula: 'Σ peso das concluídas no prazo ÷ Σ peso das concluídas.',
    detail: 'No prazo = enviada até o horário-limite, com as verificações satisfeitas.',
  },
  qualidade: {
    label: 'Qualidade',
    formula: 'Σ peso das revisadas e nunca contestadas ÷ Σ peso das revisadas.',
    detail: 'Calculada sobre a amostra revisada. Sem revisão no período, fica em branco e sai do índice.',
  },
  bloqueio: {
    label: 'Bloqueio por gate',
    formula: 'Atividades com ao menos um envio barrado ÷ atividades com verificação que tiveram envio.',
    detail: 'Mede problema real no catálogo (venda, folga), não só desempenho do analista.',
  },
  eficiencia: {
    label: 'Eficiência',
    formula: 'Atividades concluídas ÷ atividades esperadas no período × 100%.',
    detail: 'Esperada = já venceu ou já foi concluída. Concluída com atraso também conta como feita; o atraso aparece em Pontualidade. Dias de feriado não entram.',
  },
  sequencia: {
    label: 'Sequência',
    formula: 'Dias úteis seguidos, do mais recente para trás, em que todas as diárias foram plenas.',
    detail: 'Pleno = no prazo, com verificações satisfeitas e sem contestação.',
  },
} as const
