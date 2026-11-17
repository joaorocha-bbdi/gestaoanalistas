import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cx, ErrorNote, Input, PageHeader, Select, Skeleton, table, EmptyState } from '@/components/ui'
import { useAudit, useProfiles } from '@/data/queries'
import { addDays, fmtDateTime, todayISO } from '@/lib/dates'
import type { AuditEntry } from '@/lib/types'

export const ACTION_LABEL: Record<string, string> = {
  envio: 'Envio', bloqueio_gate: 'Bloqueio pelo gate', rascunho: 'Rascunho', revisao: 'Revisão', leitura: 'Leitura de resultado',
  vencimento: 'Venceu sem conclusão', ressincronizacao: 'Ressincronização', insert: 'Criação', update: 'Edição', delete: 'Exclusão',
  seed: 'Carga de demonstração', etapa: 'Início do bloco', etapa_marcada: 'Etapa marcada', etapa_desmarcada: 'Etapa desmarcada',
  item_aprovado: 'Teste aprovado', item_reprovado: 'Teste reprovado', item_reenviado: 'Teste reenviado',
  teste_solicitado: 'Teste solicitado', teste_aprovado: 'Solicitação aprovada', teste_reprovado: 'Solicitação reprovada', teste_reenviado: 'Solicitação reenviada',
}
const ENTITY_LABEL: Record<string, string> = {
  task_instances: 'Tarefa', reviews: 'Revisão', activity_templates: 'Modelo', template_assignments: 'Atribuição', template_exclusions: 'Exclusão de atividade',
  profiles: 'Usuário', settings: 'Parâmetro', holidays: 'Feriado', task_steps: 'Etapa', task_item_reviews: 'Aprovação de teste', test_requests: 'Solicitação de teste', useful_links: 'Link', user_days_off: 'Dia desativado',
}

export default function Audit() {
  const today = todayISO()
  const [from, setFrom] = useState(addDays(today, -7))
  const [to, setTo] = useState(today)
  const [entity, setEntity] = useState('')
  const [action, setAction] = useState('')
  const [actor, setActor] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const profiles = useProfiles()
  const q = useAudit({ from, to, entity: entity || undefined, action: action || undefined, actor: actor || undefined, limit: 500 })
  const name = (id: string | null) => (id ? profiles.data?.find((p) => p.id === id)?.full_name ?? id.slice(0, 8) : 'Sistema')

  return (
    <>
      <PageHeader title="Auditoria" meta="Registro imutável: ninguém edita nem apaga. Mostra até 500 eventos por consulta.">
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" aria-label="De" className="w-[150px]" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          <span className="text-muted">–</span>
          <Input type="date" aria-label="Até" className="w-[150px]" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
          <Select aria-label="Entidade" className="w-auto" value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">Tudo</option>
            {Object.entries(ENTITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Select aria-label="Ação" className="w-auto" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Todas as ações</option>
            {Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Select aria-label="Autor" className="w-auto" value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">Qualquer autor</option>
            <option value="sistema">Sistema</option>
            {(profiles.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </Select>
        </div>
      </PageHeader>
      <ErrorNote error={q.error} />
      {q.isLoading ? <Skeleton className="h-96" /> : !q.data?.length ? (
        <EmptyState title="Nenhum evento no período">Amplie as datas ou limpe os filtros.</EmptyState>
      ) : (
        <div className={table.wrap}>
          <table className={cx(table.table, 'min-w-[760px]')}>
            <thead>
              <tr>
                <th className={cx(table.th, 'w-6')}><span className="sr-only">Expandir</span></th>
                <th className={table.th}>Quando</th>
                <th className={table.th}>Quem</th>
                <th className={table.th}>Ação</th>
                <th className={table.th}>Onde</th>
                <th className={table.th}>O que mudou</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((e) => (
                <Fragment key={e.id}>
                  <tr tabIndex={0} className={table.trClick} aria-expanded={open === e.id}
                    onClick={() => setOpen(open === e.id ? null : e.id)}
                    onKeyDown={(k) => { if (k.key === 'Enter') setOpen(open === e.id ? null : e.id) }}>
                    <td className={table.td}>{open === e.id ? <ChevronDown className="size-4 text-muted" /> : <ChevronRight className="size-4 text-faint" />}</td>
                    <td className={cx(table.td, 'whitespace-nowrap font-mono text-sm text-muted')}>{fmtDateTime(e.at)}</td>
                    <td className={table.td}>{name(e.actor_id)}</td>
                    <td className={table.td}>{ACTION_LABEL[e.action] ?? e.action}</td>
                    <td className={table.td}>{ENTITY_LABEL[e.entity] ?? e.entity} <span className="text-muted">{describe(e, name)}</span></td>
                    <td className={cx(table.td, 'max-w-xs truncate font-mono text-xs text-muted')}>{(e.changed ?? []).join(', ') || '—'}</td>
                  </tr>
                  {open === e.id && (
                    <tr className="border-b border-line bg-subtle/50">
                      <td />
                      <td colSpan={5} className="py-3 pr-3"><Diff e={e} /></td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function describe(e: AuditEntry, name: (id: string | null) => string): string {
  const r = (e.after ?? e.before ?? {}) as Record<string, unknown>
  if (e.entity === 'task_instances') return `${name(r.user_id as string)} · ${r.period_key ?? ''}`
  if (e.entity === 'activity_templates') return String(r.name ?? '')
  if (e.entity === 'profiles') return String(r.full_name ?? '')
  if (e.entity === 'settings') return String(r.key ?? '')
  if (e.entity === 'holidays') return `${r.day} ${r.label ?? ''}`
  if (e.entity === 'user_days_off') return `${name(r.user_id as string)} · ${r.day}${r.reason ? ' (' + r.reason + ')' : ''}`
  if (e.entity === 'test_requests') return `${r.sku}: ${r.status}${r.review_reason ? ' (' + r.review_reason + ')' : ''}`
  if (e.entity === 'useful_links') return String(r.name ?? '')
  if (e.entity === 'task_item_reviews') return `referência ${Number(r.item_index) + 1}: ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}`
  if (e.entity === 'task_steps') return `etapa ${Number(r.step_index) + 1}`
  if (e.entity === 'reviews') return `${r.status}${r.reason ? ': ' + r.reason : ''}`
  return e.entity_id ?? ''
}

function Diff({ e }: { e: AuditEntry }) {
  const keys = e.changed?.length ? e.changed : Object.keys(e.after ?? e.before ?? {})
  const fmt = (v: unknown) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v, null, 1))
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[160px_1fr_1fr]">
      <dt className="hidden text-xs text-muted sm:block">Campo</dt>
      <dd className="hidden text-xs text-muted sm:block">Antes</dd>
      <dd className="hidden text-xs text-muted sm:block">Depois</dd>
      {keys.map((k) => (
        <Fragment key={k}>
          <dt className="font-mono text-xs">{k}</dt>
          <dd className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted">{fmt(e.before?.[k])}</dd>
          <dd className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{fmt(e.after?.[k])}</dd>
        </Fragment>
      ))}
    </dl>
  )
}
