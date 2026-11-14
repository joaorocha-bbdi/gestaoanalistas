/**
 * Camada de adapters para integrações futuras (ex.: hub bb-hub, sistemas de catálogo).
 * Nada aqui é usado na v1. A ideia: cada fonte externa implementa `DataAdapter`
 * e alimenta campos de registro (ex.: pré-preencher SKUs do "ver o que vai mudar hoje")
 * ou verificações automáticas (ex.: remoção de lixos no D3).
 *
 * Regra: um adapter nunca conclui tarefa sozinho. Ele sugere valores; o envio
 * continua passando por submit_task no banco, com gates e auditoria.
 */
import type { Payload, TaskInstance } from '@/lib/types'

export interface AdapterSuggestion {
  /** Valores sugeridos por chave de campo. */
  payload: Partial<Payload>
  /** De onde veio, para exibir ao analista e registrar na auditoria. */
  source: string
  fetchedAt: string
}

export interface DataAdapter {
  id: string
  label: string
  /** Códigos de modelo que este adapter atende (ex.: ['D1', 'D2']). */
  templates: string[]
  suggest(task: TaskInstance): Promise<AdapterSuggestion | null>
}

const registry: DataAdapter[] = []

export function registerAdapter(a: DataAdapter) {
  registry.push(a)
}

export function adaptersFor(task: TaskInstance): DataAdapter[] {
  const code = task.template_snapshot.code ?? ''
  return registry.filter((a) => a.templates.includes(code))
}
