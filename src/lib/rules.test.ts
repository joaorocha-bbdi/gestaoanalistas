import { describe, expect, it } from 'vitest'
import { deadlineStatus, effectiveStatus, submissionOutcome } from './status'
import { evaluateGates, missingFields, renderText, submitBlockers } from './fields'
import { computeMetrics, efficiencyIndex, streak } from './metrics'
import { addDays, isoWeekday, localDate, startOfWeek } from './dates'
import type { FieldDef, GateDef, TaskFact } from './types'

const D2_GATES: GateDef[] = [
  { key: 'venda_abaixo', question: 'Há algum item com venda abaixo de {limite_venda}%?', expected: 'nao' },
  { key: 'folga_abaixo', question: 'Há algum item com folga abaixo de {limite_folga}?', expected: 'nao' },
]
const FIELDS: FieldDef[] = [
  { key: 'qtd', label: 'Produtos precificados', type: 'number', required: true },
  { key: 'obs', label: 'Observações', type: 'textarea' },
  {
    key: 'produtos', label: 'Produtos', type: 'group', item_label: 'Produto', min_items: 2,
    fields: [{ key: 'sku', label: 'SKU', type: 'text', required: true }],
  },
]

describe('gate de conclusão', () => {
  it('sem resposta não pode enviar', () => {
    const r = submitBlockers({ fields: [], gates: D2_GATES, payload: {}, answers: { venda_abaixo: 'nao' }, deviation: null })
    expect(r.blockers).toHaveLength(1)
    expect(evaluateGates(D2_GATES, { venda_abaixo: 'nao' }).answered).toBe(false)
  })

  it('qualquer SIM vira modo bloqueio e exige SKUs e ação', () => {
    const answers = { venda_abaixo: 'sim', folga_abaixo: 'nao' } as const
    const ev = evaluateGates(D2_GATES, answers)
    expect(ev.passed).toBe(false)
    expect(ev.failing.map((g) => g.key)).toEqual(['venda_abaixo'])
    const r = submitBlockers({ fields: FIELDS, gates: D2_GATES, payload: {}, answers, deviation: null })
    expect(r.mode).toBe('bloquear')
    expect(r.blockers).toEqual(['SKUs em desvio', 'Ação tomada'])
    const ok = submitBlockers({ fields: FIELDS, gates: D2_GATES, payload: {}, answers, deviation: { skus: ['BB-1'], action: 'Corrigido' } })
    expect(ok.blockers).toEqual([])
    expect(submissionOutcome({ gatesPassed: false, submittedAt: '2026-11-13T10:00:00-03:00', dueAt: '2026-11-13T11:00:00-03:00' }))
      .toBe('bloqueada_gate')
  })

  it('todas NÃO + campos completos = pode concluir', () => {
    const r = submitBlockers({
      fields: FIELDS, gates: D2_GATES, deviation: null,
      payload: { qtd: 0, produtos: [{ sku: 'A' }, { sku: 'B' }] },
      answers: { venda_abaixo: 'nao', folga_abaixo: 'nao' },
    })
    expect(r).toEqual({ mode: 'concluir', blockers: [] })
  })

  it('campos obrigatórios e mínimo do grupo', () => {
    expect(missingFields(FIELDS, {})).toEqual(['Produtos precificados', 'Produtos'])
    expect(missingFields(FIELDS, { qtd: 3, produtos: [{ sku: ' ' }] })).toEqual([
      'Produtos (mínimo 2, informado 1)', 'Produto 1 · SKU',
    ])
    expect(missingFields(FIELDS, { qtd: 0, obs: '', produtos: [{ sku: 'X' }, { sku: 'Y' }] })).toEqual([])
  })

  it('perguntas usam os parâmetros configurados', () => {
    expect(renderText(D2_GATES[0].question, { params: { limite_venda: 75 } })).toBe('Há algum item com venda abaixo de 75%?')
    expect(renderText('link {concorrente}', { concorrente: 'BGT' })).toBe('link BGT')
  })
})

describe('status de prazo', () => {
  const due = '2026-11-13T11:00:00-03:00'
  it('até o minuto do prazo é no prazo', () => {
    expect(deadlineStatus('2026-11-13T10:59:59-03:00', due)).toBe('concluida_prazo')
    expect(deadlineStatus('2026-11-13T11:00:00-03:00', due)).toBe('concluida_prazo')
    expect(deadlineStatus('2026-11-13T11:00:01-03:00', due)).toBe('concluida_atraso')
  })
  it('comparação por instante, independente do fuso de quem envia', () => {
    expect(deadlineStatus('2026-11-13T13:59:00Z', due)).toBe('concluida_prazo')
    expect(deadlineStatus('2026-11-13T14:01:00Z', due)).toBe('concluida_atraso')
  })
  it('reenvio após contestação mantém pontualidade original', () => {
    expect(submissionOutcome({
      gatesPassed: true, submittedAt: '2026-11-15T10:00:00-03:00', dueAt: due, previous: 'concluida_prazo', needsRework: true,
    })).toBe('concluida_prazo')
  })
  it('aberta e vencida aparece como não feita', () => {
    const now = new Date('2026-11-13T12:00:00-03:00').getTime()
    expect(effectiveStatus({ status: 'pendente', due_at: due }, now)).toBe('nao_feita')
    expect(effectiveStatus({ status: 'bloqueada_gate', due_at: due }, now)).toBe('nao_feita')
    expect(effectiveStatus({ status: 'concluida_atraso', due_at: due }, now)).toBe('concluida_atraso')
    expect(effectiveStatus({ status: 'pendente', due_at: due }, new Date('2026-11-13T10:00:00-03:00').getTime())).toBe('pendente')
  })
})

describe('datas em America/Sao_Paulo', () => {
  it('data local vira o dia às 03:00 UTC', () => {
    expect(localDate('2026-11-14T02:59:00Z')).toBe('2026-11-13')
    expect(localDate('2026-11-14T03:00:00Z')).toBe('2026-11-14')
  })
  it('semana começa na segunda', () => {
    expect(isoWeekday('2026-11-13')).toBe(5)
    expect(startOfWeek('2026-11-15')).toBe('2026-11-09')
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
  })
})

function fact(p: Partial<TaskFact>): TaskFact {
  return {
    id: Math.random().toString(36), user_id: 'u', full_name: 'U', template_id: 't', template_code: 'D2',
    template_name: 'X', frequency: 'diaria', period_key: '', ref_date: '2026-11-10', due_at: '', curve: null,
    weight: 1, status: 'concluida_prazo', review_status: 'nao_revisada', needs_rework: false, submitted_at: null,
    completed_at: null, expected: true, completed: true, on_time: true, has_gates: false, submission_count: 1,
    gate_block_count: 0, reviewed: false, contested: false, sample_bucket: 50,
    steps_total: 0, steps_done: 0, sort_order: 0, sequential: false, ...p,
  }
}

describe('índice de eficiência', () => {
  it('composição 40/30/30 padrão', () => {
    expect(efficiencyIndex({ completionRate: 1, punctualityRate: 0.5, qualityRate: 1 })).toBe(85)
    expect(efficiencyIndex({ completionRate: 0.8, punctualityRate: 0.75, qualityRate: 0.5 })).toBe(69.5)
  })
  it('componente sem base sai e os pesos são renormalizados', () => {
    // (1×40 + 0.5×30) / 70 = 78,57
    expect(efficiencyIndex({ completionRate: 1, punctualityRate: 0.5, qualityRate: null })).toBe(78.6)
    expect(efficiencyIndex({ completionRate: null, punctualityRate: null, qualityRate: null })).toBeNull()
  })
  it('pesos configuráveis', () => {
    expect(efficiencyIndex({ completionRate: 1, punctualityRate: 0, qualityRate: 0 }, { conclusao: 1, pontualidade: 0, qualidade: 0 })).toBe(100)
  })

  it('taxas ponderadas pelo peso da atividade; pausadas não contam', () => {
    const facts = [
      fact({ weight: 2, template_code: 'D2' }),                                                       // concluída no prazo
      fact({ weight: 1, status: 'concluida_atraso', on_time: false }),                                // atrasada
      fact({ weight: 1, status: 'nao_feita', completed: false, on_time: false, submission_count: 0 }), // não feita
      fact({ weight: 5, status: 'pausada', completed: false, on_time: false, expected: false }),       // ignorada
      fact({ weight: 1, status: 'pendente', completed: false, on_time: false, expected: false }),      // ainda não venceu
    ]
    const m = computeMetrics(facts)
    expect(m.counts.expected).toBe(3)
    expect(m.completionRate).toBeCloseTo(3 / 4)      // (2+1)/(2+1+1)
    expect(m.punctualityRate).toBeCloseTo(2 / 3)     // 2/(2+1)
    expect(m.qualityRate).toBeNull()
    // (0,75×40 + 0,6667×30)/70 = 71,43
    // Eficiência = concluídas ÷ esperadas (sem peso): 2 de 3
    expect(m.efficiency).toBe(66.7)
  })

  it('qualidade e bloqueio por gate', () => {
    const facts = [
      fact({ reviewed: true }),
      fact({ reviewed: true, contested: true }),
      fact({ has_gates: true, gate_block_count: 2 }),
      fact({ has_gates: true }),
      fact({ has_gates: true, status: 'nao_feita', completed: false, on_time: false, submission_count: 0 }),
    ]
    const m = computeMetrics(facts)
    expect(m.qualityRate).toBe(0.5)
    expect(m.gateBlockRate).toBe(0.5) // 1 de 2 com envio
    expect(m.counts.gateBlockEvents).toBe(2)
  })

  it('sequência para no primeiro dia não pleno e ignora o dia em curso', () => {
    const facts = [
      fact({ ref_date: '2026-11-13', status: 'pendente', completed: false, on_time: false, expected: false }),
      fact({ ref_date: '2026-11-12' }),
      fact({ ref_date: '2026-11-11' }),
      fact({ ref_date: '2026-11-10', contested: true }),
      fact({ ref_date: '2026-11-09' }),
    ]
    expect(streak(facts, '2026-11-13')).toBe(2)
  })
})
