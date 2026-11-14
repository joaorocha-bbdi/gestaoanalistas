import type { ReviewStatus, TaskInstance, TaskStatus } from './types'

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'muted'

export const STATUS_META: Record<TaskStatus, { label: string; short: string; tone: Tone }> = {
  pendente:         { label: 'Pendente',             short: 'Pendente',  tone: 'neutral' },
  em_andamento:     { label: 'Em andamento',         short: 'Andamento', tone: 'accent' },
  concluida_prazo:  { label: 'Concluída no prazo',   short: 'No prazo',  tone: 'ok' },
  concluida_atraso: { label: 'Concluída com atraso', short: 'Atrasada',  tone: 'warn' },
  bloqueada_gate:   { label: 'Bloqueada pelo gate',  short: 'Bloqueada', tone: 'bad' },
  nao_feita:        { label: 'Não feita',            short: 'Não feita', tone: 'bad' },
  pausada:          { label: 'Pausada',              short: 'Pausada',   tone: 'muted' },
}

export const REVIEW_META: Record<ReviewStatus, { label: string; tone: Tone }> = {
  nao_revisada: { label: 'Não revisada', tone: 'muted' },
  validada:     { label: 'Validada',     tone: 'ok' },
  contestada:   { label: 'Contestada',   tone: 'bad' },
}

export const isCompleted = (s: TaskStatus) => s === 'concluida_prazo' || s === 'concluida_atraso'
export const isOpen = (s: TaskStatus) => s === 'pendente' || s === 'em_andamento' || s === 'bloqueada_gate'

/** Mesmo critério de public.deadline_status: no minuto do prazo ainda conta como no prazo. */
export function deadlineStatus(submittedAt: Date | string, dueAt: Date | string): TaskStatus {
  return new Date(submittedAt).getTime() <= new Date(dueAt).getTime() ? 'concluida_prazo' : 'concluida_atraso'
}

/**
 * Resultado de um envio, espelhando public.submit_task:
 * gate falhou → bloqueada; reenvio de contestada mantém a pontualidade original;
 * caso contrário, compara horário de envio com o prazo.
 */
export function submissionOutcome(args: {
  gatesPassed: boolean
  submittedAt: Date | string
  dueAt: Date | string
  previous?: TaskStatus
  needsRework?: boolean
}): TaskStatus {
  if (!args.gatesPassed) return 'bloqueada_gate'
  if (args.needsRework && args.previous && isCompleted(args.previous)) return args.previous
  return deadlineStatus(args.submittedAt, args.dueAt)
}

/**
 * Status para exibir agora. O banco marca "não feita" pelo job; até lá,
 * uma tarefa aberta com prazo vencido já aparece como vencida.
 */
export function effectiveStatus(t: Pick<TaskInstance, 'status' | 'due_at'>, now = Date.now()): TaskStatus {
  if (isOpen(t.status) && new Date(t.due_at).getTime() < now) return 'nao_feita'
  return t.status
}

/** Pleno = concluída no prazo (logo, gate satisfeito) e nunca contestada. */
export function isPlenary(f: { status: TaskStatus; contested: boolean }) {
  return f.status === 'concluida_prazo' && !f.contested
}

/** Mensagem de erro do Postgres/PostgREST em português legível. */
export function errorMessage(e: unknown): string {
  if (!e) return 'Erro desconhecido.'
  if (typeof e === 'string') return e
  const m = (e as { message?: string }).message ?? String(e)
  if (/Failed to fetch/i.test(m)) return 'Sem conexão com o servidor. Verifique a internet e tente de novo.'
  if (/JWT expired/i.test(m)) return 'Sua sessão expirou. Entre de novo.'
  if (/Invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.'
  if (/Email not confirmed/i.test(m)) return 'E-mail ainda não confirmado. Use o link do convite.'
  return m
}
