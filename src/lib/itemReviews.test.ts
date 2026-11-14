import { describe, expect, it } from 'vitest'
import { itemStatus } from './itemReviews'
import type { ItemReview } from './types'

const r = (index: number, status: ItemReview['status'], at: string, reason: string | null = null): ItemReview => ({
  id: `${index}${status}${at}`, task_id: 't', group_key: 'testes', item_index: index, status, reason, reviewer_id: 'a', created_at: at,
})

describe('aprovação por referência', () => {
  const rows = [
    r(0, 'aprovada', '2026-11-13T10:00:00Z'),
    r(1, 'reprovada', '2026-11-13T10:01:00Z', 'Hipótese genérica'),
  ]
  it('cada referência tem a sua situação, de forma independente', () => {
    expect(itemStatus(rows, 't', 'testes', 0).state).toBe('aprovada')
    const second = itemStatus(rows, 't', 'testes', 1)
    expect(second.state).toBe('reprovada')
    expect(second.reason).toBe('Hipótese genérica')
  })
  it('sem decisão fica pendente', () => {
    expect(itemStatus([], 't', 'testes', 0).state).toBe('pendente')
    expect(itemStatus(rows, 'outra', 'testes', 0).state).toBe('pendente')
  })
  it('depois de reenviada, a referência volta a ficar pendente e a reprovação antiga some', () => {
    const again = [...rows, r(1, 'reenviada', '2026-11-14T09:00:00Z')]
    expect(itemStatus(again, 't', 'testes', 1)).toEqual({ state: 'pendente', reason: null, decidedAt: null })
    expect(itemStatus(again, 't', 'testes', 0).state).toBe('aprovada')
  })
  it('vale a decisão mais recente', () => {
    const later = [...rows, r(1, 'reenviada', '2026-11-14T09:00:00Z'), r(1, 'aprovada', '2026-11-14T10:00:00Z')]
    expect(itemStatus(later, 't', 'testes', 1).state).toBe('aprovada')
  })
})
