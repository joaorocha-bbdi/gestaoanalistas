export type Role = 'analista' | 'admin'
export type Frequency = 'diaria' | 'semanal' | 'mensal'
export type TaskStatus =
  | 'pendente' | 'em_andamento' | 'concluida_prazo' | 'concluida_atraso'
  | 'bloqueada_gate' | 'nao_feita' | 'pausada'
export type ReviewStatus = 'nao_revisada' | 'validada' | 'contestada'
export type GateAnswer = 'sim' | 'nao'

export type FieldType = 'number' | 'text' | 'textarea' | 'select' | 'link' | 'list' | 'date' | 'boolean' | 'group'

export interface FieldDef {
  key: string
  label: string
  type: FieldType
  required?: boolean
  options?: string[]
  /** Lê as opções de um parâmetro (settings.key com array de strings). */
  options_setting?: string
  help?: string
  /** Nota de produto exibida junto ao campo (ex.: candidato a integração). */
  note?: string
  default_from?: 'curva_do_dia'
  mono?: boolean
  /** type = group */
  fields?: FieldDef[]
  min_items?: number
  item_label?: string
  /** Grupo cujos itens o gestor aprova ou reprova um a um (ex.: sugestões de teste). */
  reviewable?: boolean
}

export interface GateDef {
  key: string
  question: string
  expected: GateAnswer
}

export interface Profile {
  id: string
  full_name: string
  email: string
  role: Role
  active: boolean
  created_at: string
}

export interface ActivityTemplate {
  id: string
  code: string | null
  name: string
  description: string | null
  instructions: string[]
  frequency: Frequency
  weekdays: number[]
  cutoff_time: string
  target_qty: number | null
  target_label: string | null
  weight: number
  valid_from: string | null
  valid_to: string | null
  paused: boolean
  pause_reason: string | null
  assign_all: boolean
  shows_curve: boolean
  /** Bloco da sequência do dia: só libera depois de concluir o anterior. */
  sequential?: boolean
  fields: FieldDef[]
  gates: GateDef[]
  followup_fields: FieldDef[]
  sort_order: number
  created_at?: string
  updated_at?: string
}

export type TemplateSnapshot = Omit<ActivityTemplate, 'created_at' | 'updated_at'>

export type Payload = Record<string, unknown>
export interface Deviation { skus: string[]; action: string }

export interface TaskInstance {
  id: string
  template_id: string
  user_id: string
  period_key: string
  ref_date: string
  period_start: string
  period_end: string
  due_at: string
  curve: string | null
  weight: number
  template_snapshot: TemplateSnapshot
  status: TaskStatus
  review_status: ReviewStatus
  needs_rework: boolean
  payload: Payload
  gate_draft: Record<string, GateAnswer>
  deviation: Deviation | null
  followup: Payload | null
  followup_at: string | null
  started_at: string | null
  submitted_at: string | null
  completed_at: string | null
}

/** Linha de public.v_task_facts — base de todas as métricas. */
export interface TaskFact {
  id: string
  user_id: string
  full_name: string
  template_id: string
  template_code: string | null
  template_name: string
  frequency: Frequency
  period_key: string
  ref_date: string
  due_at: string
  curve: string | null
  weight: number
  status: TaskStatus
  review_status: ReviewStatus
  needs_rework: boolean
  submitted_at: string | null
  completed_at: string | null
  expected: boolean
  completed: boolean
  on_time: boolean
  has_gates: boolean
  submission_count: number
  gate_block_count: number
  reviewed: boolean
  contested: boolean
  sample_bucket: number
  steps_total: number
  steps_done: number
  sort_order: number
  sequential: boolean
}

export interface GateAnswerRow {
  gate_key: string
  question: string
  answer: GateAnswer
  expected: GateAnswer
  ok: boolean
}

/** Decisão do gestor sobre UM item de um grupo revisável (uma referência de teste). */
export interface ItemReview {
  id: string
  task_id: string
  group_key: string
  item_index: number
  status: 'aprovada' | 'reprovada' | 'reenviada'
  reason: string | null
  reviewer_id: string
  created_at: string
}

/** Etapa marcada: quem, quando. */
export interface TaskStep {
  id: string
  task_id: string
  step_index: number
  checked_at: string
  checked_by: string
  user?: { full_name: string } | null
}

export interface Submission {
  id: string
  task_id: string
  submitted_at: string
  payload: Payload
  gate_passed: boolean
  deviation: Deviation | null
  result_status: TaskStatus
  gate_answers?: GateAnswerRow[]
}

export interface Review {
  id: string
  task_id: string
  reviewer_id: string
  status: ReviewStatus
  reason: string | null
  created_at: string
}

export interface AuditEntry {
  id: number
  at: string
  actor_id: string | null
  action: string
  entity: string
  entity_id: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  changed: string[] | null
}

export interface Holiday { day: string; label: string }

export interface EfficiencyWeights { conclusao: number; pontualidade: number; qualidade: number }

export interface Settings {
  gate_params: Record<string, number>
  curva_por_dia: Record<string, string>
  curvas: string[]
  rotulo_concorrente: string
  dias_uteis: number[]
  pesos_eficiencia: EfficiencyWeights
  amostragem_revisao: number
  hub_url: string
  [key: string]: unknown
}

/** Card da página Links: ferramenta usada nas atividades. */
export interface UsefulLink {
  id: string
  name: string
  url: string
  description: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

/** Solicitação de teste (bloco opcional do analista), aprovada ou reprovada pelo gestor. */
export interface TestRequest {
  id: string
  user_id: string
  sku: string
  analysis: string
  explanation: string
  start_date: string
  end_date: string
  status: 'pendente' | 'aprovada' | 'reprovada'
  review_reason: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  created_at: string
  updated_at: string
  user?: { full_name: string } | null
}
