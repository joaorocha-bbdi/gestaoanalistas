import { describe, expect, it } from 'vitest'
import { blockProgress, dayProgress, sequenceStates } from './sequence'
import { initialPayload, missingFields, submitBlockers } from './fields'
import type { FieldDef, TaskInstance } from './types'

function block(id: string, order: number, steps: number, status: TaskInstance['status'] = 'pendente', seq = true): TaskInstance {
  return {
    id, template_id: id, user_id: 'u', period_key: '', ref_date: '2026-11-13', period_start: '2026-11-13', period_end: '2026-11-13',
    due_at: `2026-11-13T${String(10 + order / 10).padStart(2, '0')}:00:00-03:00`, curve: null, weight: 1, status,
    review_status: 'nao_revisada', needs_rework: false, payload: {}, gate_draft: {}, deviation: null, followup: null,
    followup_at: null, started_at: null, submitted_at: null, completed_at: null,
    template_snapshot: {
      id, code: id, name: `Bloco ${id}`, description: null, instructions: Array.from({ length: steps }, (_, i) => `Etapa ${i + 1}`),
      frequency: 'diaria', weekdays: [1], cutoff_time: '10:00', target_qty: null, target_label: null, weight: 1, valid_from: null,
      valid_to: null, paused: false, pause_reason: null, assign_all: true, shows_curve: false, sequential: seq, fields: [], gates: [],
      followup_fields: [], sort_order: order,
    },
  }
}

describe('blocos em sequência', () => {
  it('só o primeiro bloco fica liberado; os demais mostram quem bloqueia', () => {
    const st = sequenceStates([block('D3', 30, 5), block('D1', 10, 3), block('D2', 20, 5)], new Map())
    expect(st.map((s) => s.task.id)).toEqual(['D1', 'D2', 'D3'])
    expect(st.map((s) => s.locked)).toEqual([false, true, true])
    expect(st[1].blockedBy).toBe('Bloco D1')
    expect(st.map((s) => s.current)).toEqual([true, false, false])
    expect(st.map((s) => s.position)).toEqual([1, 2, 3])
  })

  it('concluir o bloco 1 libera o 2; concluída com atraso também libera', () => {
    const st = sequenceStates([block('D1', 10, 3, 'concluida_atraso'), block('D2', 20, 5), block('D3', 30, 5)], new Map())
    expect(st.map((s) => s.locked)).toEqual([false, false, true])
    expect(st[1].current).toBe(true)
    expect(st[2].blockedBy).toBe('Bloco D2')
  })

  it('bloco vencido e não feito continua bloqueando os seguintes', () => {
    const st = sequenceStates([block('D1', 10, 3, 'nao_feita'), block('D2', 20, 5)], new Map())
    expect(st[1].locked).toBe(true)
  })

  it('atividades fora da sequência (semanal, mensal, pausada) nunca bloqueiam nem são bloqueadas', () => {
    const st = sequenceStates([block('D1', 10, 3), block('S1', 60, 3, 'pendente', false), block('D4', 35, 2, 'pausada', false)], new Map())
    expect(st.find((s) => s.task.id === 'S1')!.locked).toBe(false)
    expect(st.find((s) => s.task.id === 'D4')!.locked).toBe(false)
  })
})

describe('progresso por etapas', () => {
  it('marcar todas as etapas dá 100%', () => {
    expect(blockProgress(4, 0, false)).toBe(0)
    expect(blockProgress(4, 2, false)).toBeCloseTo(2 / 4)
    expect(blockProgress(4, 4, false)).toBe(1) // todas as etapas marcadas, mesmo antes do envio
    expect(blockProgress(4, 4, true)).toBe(1)
    expect(blockProgress(0, 0, false)).toBe(0)
    expect(blockProgress(0, 0, true)).toBe(1) // sem etapas: conta quando concluído
  })

  it('progresso do dia soma os pontos de todos os blocos', () => {
    const blocks = [
      { task: block('D1', 10, 3, 'concluida_prazo'), stepsDone: 3, stepsTotal: 3 }, // 3 de 3
      { task: block('D2', 20, 5), stepsDone: 2, stepsTotal: 5 },                   // 2 de 5
    ]
    expect(dayProgress(blocks)).toBeCloseTo(5 / 8)
  })

  it('envio sem todas as etapas marcadas é barrado e diz quantas faltam', () => {
    const base = { fields: [], gates: [], payload: {}, answers: {}, deviation: null }
    expect(submitBlockers({ ...base, stepsMissing: 2 }).blockers).toEqual(['Marque as 2 etapas restantes'])
    expect(submitBlockers({ ...base, stepsMissing: 1 }).blockers).toEqual(['Marque a última etapa'])
    expect(submitBlockers({ ...base, stepsMissing: 0 }).blockers).toEqual([])
  })

  it('grupo opcional começa vazio; grupo obrigatório começa com o mínimo', () => {
    const defs: FieldDef[] = [
      { key: 'alteracoes', label: 'Alterações', type: 'group', item_label: 'Alteração', min_items: 0, fields: [{ key: 'sku', label: 'SKU', type: 'text', required: true }] },
      { key: 'produtos', label: 'Produtos', type: 'group', min_items: 2, fields: [{ key: 'sku', label: 'SKU', type: 'text', required: true }] },
    ]
    const p = initialPayload(defs)
    expect(p.alteracoes).toEqual([])
    expect((p.produtos as unknown[]).length).toBe(2)
    expect(missingFields(defs, { alteracoes: [], produtos: [{ sku: 'A' }, { sku: 'B' }] })).toEqual([])
    // Item opcional adicionado precisa ser preenchido por inteiro.
    expect(missingFields(defs, { alteracoes: [{ sku: '' }], produtos: [{ sku: 'A' }, { sku: 'B' }] })).toEqual(['Alteração 1 · SKU'])
  })
})

describe('marcos do mensal e do semanal', () => {
  it('cada período tem a sua sequência: marcos de meses diferentes não se bloqueiam', () => {
    const mk = (id: string, order: number, period: string, freq: 'mensal' | 'semanal', status: TaskInstance['status'] = 'pendente') => {
      const t = block(id, order, 1, status)
      t.period_key = period
      t.template_snapshot.frequency = freq
      return t
    }
    const st = sequenceStates([
      mk('M1', 70, '2026-11', 'mensal', 'concluida_prazo'), mk('M2', 80, '2026-11', 'mensal'), mk('M3', 90, '2026-11', 'mensal'),
      mk('M1b', 70, '2026-12', 'mensal'), mk('S1', 60, '2026-W46', 'semanal'),
    ], new Map())
    const by = Object.fromEntries(st.map((s) => [s.task.id, s]))
    expect(by.M2.locked).toBe(false)           // M1 do mês concluído
    expect(by.M3.locked).toBe(true)            // M2 ainda aberto
    expect(by.M3.blockedBy).toBe('Bloco M2')
    expect(by.M1b.locked).toBe(false)          // outro mês: sequência própria
    expect(by.S1.locked).toBe(false)
    expect(by.M2.position).toBe(2)             // numeração por grupo: M1=1, M2=2, M3=3
    expect(by.M1b.position).toBe(1)
    expect(by.M2.current).toBe(true)
    expect(by.M1b.current).toBe(true)          // um "atual" por grupo
  })
})
