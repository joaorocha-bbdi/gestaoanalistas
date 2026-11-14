import type { ItemReview } from './types'

export type ItemState = 'pendente' | 'aprovada' | 'reprovada'

export interface ItemStatus {
  state: ItemState
  /** Motivo da reprovação (quando houver). */
  reason: string | null
  /** Quando o gestor decidiu. */
  decidedAt: string | null
}

/**
 * Situação atual de um item: vale a decisão mais recente. Sem decisão, ou depois
 * que o analista reenviou a referência, o item volta a ficar pendente.
 * Espelha public.item_review_state.
 */
export function itemStatus(reviews: ItemReview[] | undefined, taskId: string, group: string, index: number): ItemStatus {
  const mine = (reviews ?? [])
    .filter((r) => r.task_id === taskId && r.group_key === group && r.item_index === index)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const last = mine[0]
  if (!last || last.status === 'reenviada') return { state: 'pendente', reason: null, decidedAt: null }
  return { state: last.status, reason: last.reason, decidedAt: last.created_at }
}

export const ITEM_STATE_LABEL: Record<ItemState, string> = {
  pendente: 'Aguardando aprovação',
  aprovada: 'Teste aprovado',
  reprovada: 'Teste reprovado',
}

/** Grupos revisáveis de um modelo. */
export function reviewableGroups<T extends { type: string; reviewable?: boolean; key: string }>(fields: T[] | undefined): T[] {
  return (fields ?? []).filter((f) => f.type === 'group' && f.reviewable)
}
