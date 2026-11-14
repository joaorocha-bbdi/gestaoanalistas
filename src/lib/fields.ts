import type { Deviation, FieldDef, GateAnswer, GateDef, Payload } from './types'

// Espelho de public.is_blank / public.missing_fields. O banco é quem decide;
// aqui serve para orientar o analista antes do envio.

export function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  return false
}

export function missingFields(defs: FieldDef[] = [], data: Payload = {}, prefix = ''): string[] {
  const out: string[] = []
  for (const f of defs) {
    const v = data?.[f.key]
    const label = prefix + f.label
    if (f.type === 'group') {
      const min = f.min_items ?? (f.required ? 1 : 0)
      if (!Array.isArray(v)) {
        if (min > 0) out.push(label)
        continue
      }
      if (v.length < min) out.push(`${label} (mínimo ${min}, informado ${v.length})`)
      v.forEach((item, i) => {
        out.push(...missingFields(f.fields ?? [], (item ?? {}) as Payload, `${f.item_label ?? f.label} ${i + 1} · `))
      })
    } else if (f.required && isBlank(v)) {
      out.push(label)
    }
  }
  return out
}

export interface GateEvaluation {
  /** Todas as perguntas respondidas. */
  answered: boolean
  /** Todas com a resposta esperada. */
  passed: boolean
  failing: GateDef[]
  unanswered: GateDef[]
}

export function evaluateGates(gates: GateDef[] = [], answers: Record<string, GateAnswer | undefined> = {}): GateEvaluation {
  const unanswered = gates.filter((g) => answers[g.key] !== 'sim' && answers[g.key] !== 'nao')
  const failing = gates.filter((g) => answers[g.key] !== undefined && answers[g.key] !== g.expected
    && (answers[g.key] === 'sim' || answers[g.key] === 'nao'))
  return { answered: unanswered.length === 0, passed: unanswered.length === 0 && failing.length === 0, failing, unanswered }
}

export function deviationComplete(d: Deviation | null | undefined): boolean {
  return !!d && Array.isArray(d.skus) && d.skus.length > 0 && !!d.action?.trim()
}

/**
 * O que impede o envio agora. Lista vazia = pode enviar.
 * Gate com resposta inesperada não impede o envio: o envio registra o bloqueio,
 * desde que haja desvio e ação.
 */
export function submitBlockers(args: {
  fields: FieldDef[]
  gates: GateDef[]
  payload: Payload
  answers: Record<string, GateAnswer | undefined>
  deviation: Deviation | null
  /** Etapas ainda não marcadas (o envio só vale com todas marcadas). */
  stepsMissing?: number
}): { mode: 'concluir' | 'bloquear'; blockers: string[] } {
  if (args.stepsMissing && args.stepsMissing > 0) {
    return {
      mode: 'concluir',
      blockers: [`Marque ${args.stepsMissing === 1 ? 'a última etapa' : `as ${args.stepsMissing} etapas restantes`}`],
    }
  }
  const ev = evaluateGates(args.gates, args.answers)
  if (!ev.answered) {
    return { mode: 'concluir', blockers: [`Responda ${ev.unanswered.length === 1 ? 'a verificação' : `as ${ev.unanswered.length} verificações`}`] }
  }
  if (!ev.passed) {
    const b: string[] = []
    if (!args.deviation?.skus?.length) b.push('SKUs em desvio')
    if (!args.deviation?.action?.trim()) b.push('Ação tomada')
    return { mode: 'bloquear', blockers: b }
  }
  return { mode: 'concluir', blockers: missingFields(args.fields, args.payload) }
}

export interface TextContext {
  params?: Record<string, number | string>
  concorrente?: string
}

/** Substitui {limite_venda}, {concorrente} etc. — mesmo papel de public.render_text. */
export function renderText(text: string | null | undefined, ctx: TextContext = {}): string {
  if (!text) return ''
  let out = text
  for (const [k, v] of Object.entries(ctx.params ?? {})) out = out.split(`{${k}}`).join(String(v))
  return out.split('{concorrente}').join(ctx.concorrente ?? 'concorrente')
}

/** Payload inicial: grupos com a quantidade da meta e defaults (ex.: curva do dia). */
export function initialPayload(defs: FieldDef[] = [], ctx: { curve?: string | null } = {}): Payload {
  const out: Payload = {}
  for (const f of defs) {
    if (f.type === 'group') {
      // Grupo opcional (min_items 0) começa vazio; os demais, com a quantidade mínima.
      out[f.key] = Array.from({ length: f.min_items ?? 1 }, () => initialPayload(f.fields, ctx))
    } else if (f.default_from === 'curva_do_dia' && ctx.curve) {
      out[f.key] = ctx.curve
    }
  }
  return out
}

/** Mescla o rascunho salvo sobre o payload inicial (rascunho vence). */
export function mergePayload(defs: FieldDef[], saved: Payload | null | undefined, ctx: { curve?: string | null } = {}): Payload {
  const base = initialPayload(defs, ctx)
  if (!saved || Object.keys(saved).length === 0) return base
  return { ...base, ...saved }
}

export const parseList = (text: string) =>
  text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)

export function resolveOptions(def: FieldDef, settings?: Record<string, unknown>): string[] {
  if (def.options_setting && settings) {
    const v = settings[def.options_setting]
    if (Array.isArray(v)) return v.map(String)
  }
  return def.options ?? []
}

export function slugKey(label: string): string {
  return label
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'campo'
}

/** Valor legível de um campo para telas de leitura e CSV. */
export function displayValue(def: FieldDef, v: unknown): string {
  if (isBlank(v)) return '—'
  if (def.type === 'boolean') return v === true ? 'Sim' : v === false ? 'Não' : String(v)
  if (Array.isArray(v)) return v.join(', ')
  if (def.type === 'date' && typeof v === 'string') return v.split('-').reverse().join('/')
  return String(v)
}

export const FIELD_TYPE_LABEL: Record<FieldDef['type'], string> = {
  number: 'Número',
  text: 'Texto curto',
  textarea: 'Texto longo',
  select: 'Seleção',
  link: 'Link',
  list: 'Lista (SKUs, links)',
  date: 'Data',
  boolean: 'Sim / Não',
  group: 'Grupo repetido (por item)',
}
