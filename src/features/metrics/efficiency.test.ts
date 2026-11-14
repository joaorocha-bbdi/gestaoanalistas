import { describe, expect, it } from 'vitest'
import { efficiencyPercent } from '@/lib/metrics'
import { efficiencySeries } from './EfficiencyDashboard'
import type { TaskFact } from '@/lib/types'

const f = (ref_date: string, completed: boolean, extra: Partial<TaskFact> = {}): TaskFact => ({
  id: Math.random().toString(36), user_id: 'u', full_name: 'U', template_id: 't', template_code: 'D1', template_name: 'X',
  frequency: 'diaria', period_key: ref_date, ref_date, due_at: `${ref_date}T23:59:59-03:00`, curve: null, weight: 2,
  status: completed ? 'concluida_prazo' : 'nao_feita', review_status: 'nao_revisada', needs_rework: false,
  submitted_at: null, completed_at: null, expected: true, completed, on_time: completed, has_gates: false,
  submission_count: 0, gate_block_count: 0, reviewed: false, contested: false, sample_bucket: 0,
  steps_total: 0, steps_done: 0, sort_order: 0, sequential: true, ...extra,
})

describe('eficiência em porcentagem', () => {
  it('é concluídas ÷ esperadas, sem peso por atividade', () => {
    expect(efficiencyPercent([f('2026-11-09', true), f('2026-11-09', true), f('2026-11-10', false), f('2026-11-10', true)])).toBe(75)
  })
  it('concluída com atraso conta como feita; pausada e ainda não vencida ficam fora', () => {
    expect(efficiencyPercent([
      f('2026-11-09', true, { status: 'concluida_atraso', on_time: false }),
      f('2026-11-09', false),
      f('2026-11-10', false, { status: 'pausada', expected: false }),
      f('2026-11-13', false, { status: 'pendente', expected: false }),
    ])).toBe(50)
  })
  it('sem nada esperado não inventa número', () => {
    expect(efficiencyPercent([])).toBeNull()
  })
})

describe('gráfico por semana, por mês e de todo o período', () => {
  const facts = [
    f('2026-08-03', true), f('2026-08-04', false),             // semana 3 ago: 50%
    f('2026-10-26', true), f('2026-10-27', true),              // semana 26 out: 100%
    f('2026-11-02', true), f('2026-11-03', false), f('2026-11-04', false), f('2026-11-05', true), // semana 2 nov: 50%
  ]
  it('por semana agrupa de segunda a domingo', () => {
    const s = efficiencySeries(facts, 'semana')
    expect(s.map((x) => [x.period, x.value])).toEqual([['2026-08-03', 50], ['2026-10-26', 100], ['2026-11-02', 50]])
  })
  it('por mês agrupa pelo mês da atividade', () => {
    const s = efficiencySeries(facts, 'mes')
    expect(s.map((x) => [x.period, x.value, x.done, x.expected])).toEqual([
      ['2026-08-01', 50, 1, 2], ['2026-10-01', 100, 2, 2], ['2026-11-01', 50, 2, 4],
    ])
  })
  it('por semana mostra as últimas 12; todo o período mostra todas', () => {
    const many = Array.from({ length: 20 }, (_, i) => f(new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString().slice(0, 10), true))
    expect(efficiencySeries(many, 'semana')).toHaveLength(12)
    expect(efficiencySeries(many, 'total')).toHaveLength(20)
  })
})
