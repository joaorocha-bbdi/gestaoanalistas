import { describe, expect, it } from 'vitest'
import { applyStepToggle, coveringRange, sliceFacts, stepsByTask } from './perf'
import type { TaskFact, TaskStep } from './types'

const who = { id: 'u1', name: 'Ana' }
const step = (task: string, i: number): TaskStep => ({
  id: `${task}${i}`, task_id: task, step_index: i, checked_at: '2026-11-13T10:00:00Z', checked_by: 'u1', user: { full_name: 'Ana' },
})

describe('etapas otimistas', () => {
  it('marcar acrescenta a etapa na hora, com quem marcou', () => {
    const r = applyStepToggle([step('t', 0)], 't', 1, true, who, '2026-11-13T11:00:00Z')
    expect(r.map((s) => s.step_index)).toEqual([0, 1])
    expect(r[1]).toMatchObject({ task_id: 't', checked_by: 'u1', user: { full_name: 'Ana' }, checked_at: '2026-11-13T11:00:00Z' })
  })
  it('desmarcar remove só aquela etapa daquela tarefa', () => {
    const r = applyStepToggle([step('t', 0), step('t', 1), step('x', 1)], 't', 1, false, who)
    expect(r.map((s) => `${s.task_id}${s.step_index}`)).toEqual(['t0', 'x1'])
  })
  it('marcar duas vezes não duplica', () => {
    const r = applyStepToggle(applyStepToggle([], 't', 0, true, who), 't', 0, true, who)
    expect(r).toHaveLength(1)
  })
  it('agrupa por tarefa', () => {
    const m = stepsByTask([step('a', 0), step('b', 0), step('a', 1)])
    expect(m.get('a')?.length).toBe(2)
    expect(m.get('b')?.length).toBe(1)
  })
})

describe('uma busca de fatos para vários recortes', () => {
  it('o intervalo cobre todos os recortes', () => {
    expect(coveringRange([
      { from: '2026-11-07', to: '2026-11-13' },
      { from: '2026-11-09', to: '2026-11-15' },
      { from: '2026-08-21', to: '2026-11-13' },
    ])).toEqual({ from: '2026-08-21', to: '2026-11-15' })
  })
  it('recortar no navegador devolve exatamente o que uma busca separada devolveria', () => {
    const rows = ['2026-11-06', '2026-11-07', '2026-11-10', '2026-11-13', '2026-11-14'].map((d) => ({ ref_date: d }) as TaskFact)
    expect(sliceFacts(rows, '2026-11-07', '2026-11-13').map((r) => r.ref_date)).toEqual(['2026-11-07', '2026-11-10', '2026-11-13'])
    expect(sliceFacts(undefined, '2026-11-07', '2026-11-13')).toEqual([])
  })
})
