import { describe, expect, it } from 'vitest'
import { deliveredOn, summarizeDay } from './daily'
import type { TaskFact } from './types'

const fact = (o: Partial<TaskFact>): TaskFact => ({
  id: Math.random().toString(36), user_id: 'u1', full_name: 'Ana', template_id: 'tp', template_code: 'D1', template_name: 'Bloco',
  frequency: 'diaria', period_key: '', ref_date: '2026-11-16', due_at: '2026-11-16T21:00:00Z', curve: null, weight: 1,
  status: 'pendente', review_status: 'nao_revisada', needs_rework: false, submitted_at: null, completed_at: null,
  expected: false, completed: false, on_time: false, has_gates: false, submission_count: 0, gate_block_count: 0,
  reviewed: false, contested: false, sample_bucket: 0, steps_total: 0, steps_done: 0, sort_order: 0, sequential: true, ...o,
})

describe('resumo do dia', () => {
  it('envio conta no dia do horário de São Paulo', () => {
    // 01:30 UTC do dia 17 = 22:30 do dia 16 em São Paulo
    expect(deliveredOn({ submitted_at: '2026-11-17T01:30:00Z' }, '2026-11-16')).toBe(true)
    expect(deliveredOn({ submitted_at: '2026-11-17T01:30:00Z' }, '2026-11-17')).toBe(false)
    expect(deliveredOn({ submitted_at: null }, '2026-11-16')).toBe(false)
  })

  it('conta previstas, concluídas, atrasadas, não feitas e envios', () => {
    const facts = [
      fact({ status: 'concluida_prazo', completed: true, submitted_at: '2026-11-16T12:00:00Z' }),
      fact({ status: 'concluida_atraso', completed: true, submitted_at: '2026-11-16T22:00:00Z' }),
      fact({ status: 'nao_feita' }),
      fact({ status: 'pausada' }),
      // Mensal com referência no início do mês, enviada no dia: é envio, não prevista
      fact({ user_id: 'u2', frequency: 'mensal', ref_date: '2026-11-01', status: 'concluida_prazo', completed: true, submitted_at: '2026-11-16T15:00:00Z' }),
    ]
    const s = summarizeDay(facts, '2026-11-16')
    expect(s).toMatchObject({ expected: 3, done: 2, late: 1, missed: 1, deliveries: 3, people: 2 })
    expect(s.firstAt).toBe('2026-11-16T12:00:00Z')
    expect(s.lastAt).toBe('2026-11-16T22:00:00Z')
    expect(summarizeDay(facts, '2026-11-16', 'u2')).toMatchObject({ expected: 0, deliveries: 1 })
  })
})
