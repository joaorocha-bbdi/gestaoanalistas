import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { must, supabase } from '@/lib/supabase'
import { DEFAULT_WEIGHTS } from '@/lib/metrics'
import { applyStepToggle, stepsByTask } from '@/lib/perf'
import type {
  ActivityTemplate, AuditEntry, DayOff, Deviation, GateAnswer, Holiday, Payload, Profile, Review,
  ItemReview, Settings, Submission, TaskFact, TaskInstance, TaskStep,
} from '@/lib/types'

// ---------------------------------------------------------------------
// Parâmetros
// ---------------------------------------------------------------------
export const DEFAULT_SETTINGS: Settings = {
  gate_params: { limite_venda: 80, limite_folga: 0 },
  curva_por_dia: { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E' },
  curvas: ['A', 'B', 'C', 'D', 'E'],
  rotulo_concorrente: 'BGT',
  dias_uteis: [1, 2, 3, 4, 5],
  pesos_eficiencia: DEFAULT_WEIGHTS,
  amostragem_revisao: 20,
  hub_url: 'https://ceo61.github.io/bb-hub/',
}

export interface SettingRow { key: string; value: unknown; label: string; description: string | null; updated_at: string }

export function useSettingRows() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: async () => must(await supabase.from('settings').select('*').order('key')) as SettingRow[],
    staleTime: 5 * 60_000,
  })
}

export function useSettings(): Settings {
  const { data } = useSettingRows()
  // Mesmo objeto enquanto os parâmetros não mudam (não força redesenho de quem recebe).
  return useMemo(() => {
    const s: Settings = { ...DEFAULT_SETTINGS }
    for (const r of data ?? []) s[r.key] = r.value
    return s
  }, [data])
}

export function useTextContext() {
  const s = useSettings()
  return useMemo(() => ({ params: s.gate_params, concorrente: s.rotulo_concorrente }), [s])
}

export function useSaveSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: unknown }) =>
      must(await supabase.from('settings').update({ value }).eq('key', key).select()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  })
}

export function useHolidays() {
  return useQuery({
    queryKey: ['holidays'],
    queryFn: async () => must(await supabase.from('holidays').select('*').order('day')) as Holiday[],
  })
}

// ---------------------------------------------------------------------
// Dias desativados por analista. RLS: gestor vê e altera todos; analista só lê os seus.
// ---------------------------------------------------------------------
export function useDaysOff(opts: { userId?: string; from?: string; to?: string; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['days_off', opts.userId ?? 'todos', opts.from ?? '', opts.to ?? ''],
    enabled: opts.enabled ?? true,
    queryFn: async () => {
      let q = supabase.from('user_days_off').select('*')
      if (opts.userId) q = q.eq('user_id', opts.userId)
      if (opts.from) q = q.gte('day', opts.from)
      if (opts.to) q = q.lte('day', opts.to)
      return must(await q.order('day', { ascending: false })) as DayOff[]
    },
  })
}

export function useSetDayOff() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (a: { userId: string; day: string; off: boolean; reason?: string | null }) => a.off
      ? must(await supabase.from('user_days_off').upsert({ user_id: a.userId, day: a.day, reason: a.reason || null }, { onConflict: 'user_id,day' }).select())
      : must(await supabase.from('user_days_off').delete().eq('user_id', a.userId).eq('day', a.day).select()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['days_off'] })
      void qc.invalidateQueries({ queryKey: ['facts'] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
  })
}

// ---------------------------------------------------------------------
// Tarefas
// ---------------------------------------------------------------------
export function useRefreshTasks() {
  return useQuery({
    queryKey: ['refresh_tasks'],
    queryFn: async () => { await supabase.rpc('refresh_tasks'); return true },
    staleTime: 10 * 60_000,
  })
}

export function useTasks(opts: { userId?: string; from: string; to: string; enabled?: boolean }) {
  return useQuery({
    queryKey: ['tasks', opts.userId ?? 'todos', opts.from, opts.to],
    enabled: opts.enabled ?? true,
    queryFn: async () => {
      let q = supabase.from('task_instances').select('*').gte('ref_date', opts.from).lte('ref_date', opts.to)
      if (opts.userId) q = q.eq('user_id', opts.userId)
      return must(await q.order('due_at')) as TaskInstance[]
    },
  })
}

/** Abertas fora do intervalo de hoje (semanais/mensais e pendências recentes). */
export function useOpenTasks(userId: string | undefined, since: string) {
  return useQuery({
    queryKey: ['tasks', 'abertas', userId, since],
    enabled: !!userId,
    queryFn: async () => must(await supabase.from('task_instances').select('*')
      .eq('user_id', userId!).gte('ref_date', since)
      .or('status.in.(pendente,em_andamento,bloqueada_gate,nao_feita),needs_rework.eq.true')
      .order('due_at')) as TaskInstance[],
  })
}

export function useTask(id: string | null | undefined) {
  return useQuery({
    queryKey: ['task', id],
    enabled: !!id,
    queryFn: async () => must(await supabase.from('task_instances').select('*').eq('id', id!).single()) as TaskInstance,
  })
}

export function useSubmissions(taskId: string | null | undefined) {
  return useQuery({
    queryKey: ['submissions', taskId],
    enabled: !!taskId,
    queryFn: async () => must(await supabase.from('task_submissions')
      .select('*, gate_answers(gate_key, question, answer, expected, ok)')
      .eq('task_id', taskId!).order('submitted_at', { ascending: false })) as Submission[],
  })
}

export function useReviews(taskId: string | null | undefined) {
  return useQuery({
    queryKey: ['reviews', taskId],
    enabled: !!taskId,
    queryFn: async () => must(await supabase.from('reviews').select('*')
      .eq('task_id', taskId!).order('created_at', { ascending: false })) as Review[],
  })
}

/** Etapas marcadas de várias tarefas (quem e quando). Admin lê todas; analista, só as suas. */
export function useSteps(taskIds: string[]) {
  const key = [...taskIds].sort().join(',')
  return useQuery({
    queryKey: ['steps', key],
    enabled: taskIds.length > 0,
    queryFn: async () => must(await supabase.from('task_steps')
      .select('id, task_id, step_index, checked_at, checked_by, user:profiles!checked_by(full_name)')
      .in('task_id', taskIds).order('step_index')) as unknown as TaskStep[],
  })
}

/** Quantas etapas cada tarefa já tem marcadas. */
export function stepCounts(steps: TaskStep[] | undefined): Map<string, number> {
  const m = new Map<string, number>()
  for (const s of steps ?? []) m.set(s.task_id, (m.get(s.task_id) ?? 0) + 1)
  return m
}

/**
 * Marcar/desmarcar etapa com resposta imediata: a tela muda na hora e o banco
 * confirma em seguida. Se o banco recusar (ordem, bloqueio), tudo volta como estava.
 */
export function useSetStep(who?: { id: string; name: string }) {
  const qc = useQueryClient()
  type Snapshot = [readonly unknown[], unknown][]
  return useMutation({
    mutationKey: ['set_step'],
    mutationFn: async (a: { taskId: string; index: number; checked: boolean }) =>
      must(await supabase.rpc('set_step', { p_task: a.taskId, p_index: a.index, p_checked: a.checked })) as TaskInstance,
    onMutate: async (a) => {
      await qc.cancelQueries({ queryKey: ['steps'] })
      await qc.cancelQueries({ queryKey: ['tasks', 'dashboard'] })
      const snap: Snapshot = [
        ...qc.getQueriesData({ queryKey: ['steps'] }),
        ...qc.getQueriesData({ queryKey: ['tasks', 'dashboard'] }),
      ]
      const me = who ?? { id: '', name: '' }
      // Cada cache de etapas que contém esta tarefa
      for (const [key, data] of qc.getQueriesData<TaskStep[]>({ queryKey: ['steps'] })) {
        const ids = String(key[1] ?? '').split(',')
        if (ids.includes(a.taskId)) qc.setQueryData(key, applyStepToggle(data, a.taskId, a.index, a.checked, me))
      }
      for (const [key, data] of qc.getQueriesData<Dashboard>({ queryKey: ['tasks', 'dashboard'] })) {
        if (data) qc.setQueryData(key, { ...data, steps: applyStepToggle(data.steps, a.taskId, a.index, a.checked, me) })
      }
      return { snap }
    },
    onError: (_e, _a, ctx) => {
      for (const [key, data] of ctx?.snap ?? []) qc.setQueryData(key, data)
    },
    onSuccess: (t) => {
      qc.setQueryData(['task', t.id], t)
    },
    onSettled: (_t, _e, a) => {
      // Cliques em sequência: só a última marcação recarrega. Uma recarga no meio
      // traria o banco sem as marcações ainda em envio e a caixa "piscaria".
      if (qc.isMutating({ mutationKey: ['set_step'] }) > 1) return
      void qc.invalidateQueries({ queryKey: ['steps', a.taskId] })
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      void qc.invalidateQueries({ queryKey: ['facts'], refetchType: 'none' })
      void qc.invalidateQueries({ queryKey: ['audit'], refetchType: 'none' })
    },
  })
}

// ---------------------------------------------------------------------
// Tela "Hoje" numa chamada só (tarefas, etapas, aprovações e solicitações)
// ---------------------------------------------------------------------
export interface Dashboard {
  tasks: TaskInstance[]
  steps: TaskStep[]
  item_reviews: ItemReview[]
  test_requests: import('@/lib/types').TestRequest[]
}

export function useDashboard(userId: string | undefined, today: string, since: string) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: ['tasks', 'dashboard', userId, today],
    enabled: !!userId,
    queryFn: async () => {
      const d = must(await supabase.rpc('dashboard_today', { p_today: today, p_since: since })) as Dashboard
      // Pré-carrega o que o painel da atividade usa: abre sem esperar o servidor.
      const byTask = stepsByTask(d.steps)
      for (const t of d.tasks) {
        qc.setQueryData(['task', t.id], t)
        qc.setQueryData(['steps', t.id], byTask.get(t.id) ?? [])
      }
      qc.setQueryData(['test_requests'], d.test_requests)
      return d
    },
  })
}

/** Decisões do gestor sobre itens (referências de teste) de várias tarefas. */
export function useItemReviews(taskIds: string[]) {
  const key = [...taskIds].sort().join(',')
  return useQuery({
    queryKey: ['item_reviews', key],
    enabled: taskIds.length > 0,
    queryFn: async () => must(await supabase.from('task_item_reviews').select('*')
      .in('task_id', taskIds).order('created_at', { ascending: false })) as ItemReview[],
  })
}

export function useReviewItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (a: { taskId: string; group: string; index: number; status: 'aprovada' | 'reprovada'; reason?: string }) =>
      must(await supabase.rpc('review_item', {
        p_task: a.taskId, p_group: a.group, p_index: a.index, p_status: a.status, p_reason: a.reason ?? null,
      })) as ItemReview,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['item_reviews'] })
      void qc.invalidateQueries({ queryKey: ['tests_queue'] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
  })
}

export function useResubmitItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (a: { taskId: string; group: string; index: number; item: Payload }) =>
      must(await supabase.rpc('resubmit_item', { p_task: a.taskId, p_group: a.group, p_index: a.index, p_item: a.item })) as TaskInstance,
    onSuccess: (t) => {
      qc.setQueryData(['task', t.id], t)
      void qc.invalidateQueries({ queryKey: ['item_reviews'] })
      void qc.invalidateQueries({ queryKey: ['tests_queue'] })
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
  })
}

/** Fila do gestor: tarefas concluídas que têm itens para aprovar (ex.: testes do mensal). */
export function useTestsQueue() {
  return useQuery({
    queryKey: ['tests_queue'],
    queryFn: async () => must(await supabase.from('task_instances')
      .select('*, user:profiles!user_id(full_name, active)')
      .in('status', ['concluida_prazo', 'concluida_atraso'])
      .eq('template_snapshot->>frequency', 'mensal')
      .order('submitted_at', { ascending: false }).limit(60)) as unknown as (TaskInstance & { user: { full_name: string; active: boolean } | null })[],
    // Usuário desativado sai das filas do gestor.
    select: (rows) => rows.filter((r) => r.user?.active !== false),
  })
}

interface SubmitArgs { id: string; payload: Payload; gates: Record<string, GateAnswer>; deviation: Deviation | null }

function useTaskMutation<A>(fn: (a: A) => Promise<TaskInstance>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (t) => {
      qc.setQueryData(['task', t.id], t)
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      void qc.invalidateQueries({ queryKey: ['facts'] })
      void qc.invalidateQueries({ queryKey: ['steps'] })
      void qc.invalidateQueries({ queryKey: ['submissions', t.id] })
      void qc.invalidateQueries({ queryKey: ['reviews', t.id] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
  })
}

export const useSaveDraft = () => useTaskMutation(async (a: SubmitArgs) =>
  must(await supabase.rpc('save_draft', { p_task: a.id, p_payload: a.payload, p_gates: a.gates, p_deviation: a.deviation })) as TaskInstance)

export const useSubmitTask = () => useTaskMutation(async (a: SubmitArgs) =>
  must(await supabase.rpc('submit_task', { p_task: a.id, p_payload: a.payload, p_gates: a.gates, p_deviation: a.deviation })) as TaskInstance)

export const useRecordFollowup = () => useTaskMutation(async (a: { id: string; data: Payload }) =>
  must(await supabase.rpc('record_followup', { p_task: a.id, p_data: a.data })) as TaskInstance)

export const useReviewTask = () => useTaskMutation(async (a: { id: string; status: 'validada' | 'contestada'; reason?: string }) =>
  must(await supabase.rpc('review_task', { p_task: a.id, p_status: a.status, p_reason: a.reason ?? null })) as TaskInstance)

// ---------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------
export interface FactFilter { from: string; to: string; userId?: string; templateId?: string }

export function useFacts(f: FactFilter) {
  return useQuery({
    queryKey: ['facts', f.from, f.to, f.userId ?? '', f.templateId ?? ''],
    queryFn: async () => {
      // PostgREST devolve até 1000 linhas por chamada: a 1ª página traz o total
      // e as demais são buscadas em paralelo (em vez de uma depois da outra).
      const PAGE = 1000
      const build = (count = false) => {
        let q = supabase.from('v_task_facts').select('*', count ? { count: 'exact' } : undefined)
          .gte('ref_date', f.from).lte('ref_date', f.to)
        if (f.userId) q = q.eq('user_id', f.userId)
        if (f.templateId) q = q.eq('template_id', f.templateId)
        return q.order('ref_date').order('id')
      }
      const first = await build(true).range(0, PAGE - 1)
      if (first.error) throw new Error(first.error.message)
      const rows = [...(first.data as TaskFact[])]
      const total = first.count ?? rows.length
      const rest = await Promise.all(
        Array.from({ length: Math.max(0, Math.ceil(total / PAGE) - 1) }, (_, i) => build().range((i + 1) * PAGE, (i + 2) * PAGE - 1)),
      )
      for (const r of rest) rows.push(...(must(r) as TaskFact[]))
      return rows
    },
  })
}

// ---------------------------------------------------------------------
// Admin: pessoas, modelos, auditoria
// ---------------------------------------------------------------------
export function useProfiles() {
  return useQuery({
    queryKey: ['profiles'],
    queryFn: async () => must(await supabase.from('profiles').select('*').order('full_name')) as Profile[],
  })
}

export function useAnalysts(includeInactive = false) {
  const q = useProfiles()
  const data = (q.data ?? []).filter((p) => p.role === 'analista' && (includeInactive || p.active))
  return { ...q, data }
}

export function useTemplates() {
  return useQuery({
    queryKey: ['templates'],
    queryFn: async () => must(await supabase.from('activity_templates').select('*')
      .order('sort_order').order('name')) as ActivityTemplate[],
  })
}

export function useAssignments() {
  return useQuery({
    queryKey: ['assignments'],
    queryFn: async () => must(await supabase.from('template_assignments').select('*')) as { template_id: string; user_id: string }[],
  })
}

export function useExclusions() {
  return useQuery({
    queryKey: ['exclusions'],
    queryFn: async () => must(await supabase.from('template_exclusions').select('template_id, user_id')) as { template_id: string; user_id: string }[],
  })
}

export interface AuditFilter { from: string; to: string; entity?: string; action?: string; actor?: string; entityId?: string; limit?: number }

export function useAudit(f: AuditFilter) {
  return useQuery({
    queryKey: ['audit', f],
    queryFn: async () => {
      let q = supabase.from('audit_log').select('*')
        .gte('at', `${f.from}T00:00:00-03:00`).lte('at', `${f.to}T23:59:59.999-03:00`)
      if (f.entity) q = q.eq('entity', f.entity)
      if (f.action) q = q.eq('action', f.action)
      if (f.actor === 'sistema') q = q.is('actor_id', null)
      else if (f.actor) q = q.eq('actor_id', f.actor)
      if (f.entityId) q = q.eq('entity_id', f.entityId)
      return must(await q.order('at', { ascending: false }).limit(f.limit ?? 300)) as AuditEntry[]
    },
  })
}

// ---------------------------------------------------------------------
// Links das ferramentas (todos leem; só o gestor escreve — RLS)
// ---------------------------------------------------------------------
export function useLinks() {
  return useQuery({
    queryKey: ['links'],
    queryFn: async () => must(await supabase.from('useful_links').select('*')
      .order('sort_order').order('name')) as import('@/lib/types').UsefulLink[],
  })
}

export function useSaveLink() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (l: { id?: string; name: string; url: string; description: string | null }) => {
      const row = { name: l.name, url: l.url, description: l.description }
      const res = l.id
        ? await supabase.from('useful_links').update(row).eq('id', l.id).select()
        : await supabase.from('useful_links').insert(row).select()
      return must(res)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['links'] }),
  })
}

export function useDeleteLink() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => must(await supabase.from('useful_links').delete().eq('id', id).select()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['links'] }),
  })
}

// ---------------------------------------------------------------------
// Solicitações de teste (bloco opcional). RLS: analista vê as suas; gestor vê todas.
// ---------------------------------------------------------------------
type TR = import('@/lib/types').TestRequest
export interface TestRequestInput { sku: string; analysis: string; explanation: string; start: string; end: string }

export function useTestRequests() {
  return useQuery({
    queryKey: ['test_requests'],
    queryFn: async () => must(await supabase.from('test_requests')
      .select('*, user:profiles!user_id(full_name, active)')
      .order('created_at', { ascending: false })) as unknown as (TR & { user: { active?: boolean } | null })[],
    // Usuário desativado sai das filas do gestor.
    select: (rows) => rows.filter((r) => r.user?.active !== false) as TR[],
  })
}

function useTestRequestMutation<A>(fn: (a: A) => Promise<TR>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['test_requests'] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
  })
}

export const useCreateTestRequest = () => useTestRequestMutation(async (a: TestRequestInput) =>
  must(await supabase.rpc('create_test_request', {
    p_sku: a.sku, p_analysis: a.analysis, p_explanation: a.explanation, p_start: a.start, p_end: a.end,
  })) as TR)

export const useResubmitTestRequest = () => useTestRequestMutation(async (a: TestRequestInput & { id: string }) =>
  must(await supabase.rpc('resubmit_test_request', {
    p_id: a.id, p_sku: a.sku, p_analysis: a.analysis, p_explanation: a.explanation, p_start: a.start, p_end: a.end,
  })) as TR)

export const useReviewTestRequest = () => useTestRequestMutation(async (a: { id: string; status: 'aprovada' | 'reprovada'; reason?: string }) =>
  must(await supabase.rpc('review_test_request', { p_id: a.id, p_status: a.status, p_reason: a.reason ?? null })) as TR)
