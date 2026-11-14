import { Link, useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Button, cx, EmptyState, ErrorNote, PageHeader, Skeleton, table } from '@/components/ui'
import { FREQ_LABEL } from '@/features/tasks/taskText'
import { useAssignments, useTemplates, useTextContext } from '@/data/queries'
import { fmtDay, todayISO, WEEKDAYS_SHORT } from '@/lib/dates'
import { renderText } from '@/lib/fields'
import type { ActivityTemplate } from '@/lib/types'

export function templateState(t: ActivityTemplate, today = todayISO()): { label: string; tone: 'ok' | 'muted' | 'warn' } {
  if (t.paused) return { label: 'Pausada', tone: 'muted' }
  if (t.valid_from && today < t.valid_from) return { label: `Começa ${fmtDay(t.valid_from)}`, tone: 'warn' }
  if (t.valid_to && today > t.valid_to) return { label: 'Fora de vigência', tone: 'muted' }
  return { label: 'Ativa', tone: 'ok' }
}

export default function Templates() {
  const navigate = useNavigate()
  const q = useTemplates()
  const assignments = useAssignments()
  const text = useTextContext()

  return (
    <>
      <PageHeader
        title="Modelos de atividade"
        meta="Cada modelo gera as tarefas dos analistas conforme frequência, vigência e atribuição. Editar não altera tarefas já iniciadas."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate('/admin/modelos/novo')}>Novo modelo</Button>}
      />
      <ErrorNote error={q.error} />
      {q.isLoading ? <Skeleton className="h-64" /> : !q.data?.length ? (
        <EmptyState title="Nenhum modelo" action={<Button onClick={() => navigate('/admin/modelos/novo')}>Criar o primeiro</Button>}>
          Modelos definem o que o analista faz, até que horas e o que precisa registrar.
        </EmptyState>
      ) : (
        <div className={table.wrap}>
          <table className={cx(table.table, 'min-w-[860px]')}>
            <thead>
              <tr>
                <th className={table.th}>Código</th>
                <th className={table.th}>Modelo</th>
                <th className={table.th}>Situação</th>
                <th className={table.th}>Frequência</th>
                <th className={table.thNum}>Peso</th>
                <th className={table.thNum}>Gates</th>
                <th className={table.th}>Atribuição</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((t) => {
                const st = templateState(t)
                const n = (assignments.data ?? []).filter((a) => a.template_id === t.id).length
                return (
                  <tr key={t.id} tabIndex={0} className={table.trClick} onClick={() => navigate(`/admin/modelos/${t.id}`)}
                    onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/admin/modelos/${t.id}`) }}>
                    <td className={cx(table.td, 'font-mono text-sm text-muted')}>{t.code ?? '—'}</td>
                    <td className={table.td}>
                      <Link to={`/admin/modelos/${t.id}`} className="font-medium" onClick={(e) => e.stopPropagation()}>{t.name}</Link>
                      {t.paused && t.pause_reason && <p className="text-sm text-muted">{t.pause_reason}</p>}
                      {!t.paused && t.description && <p className="max-w-md truncate text-sm text-muted">{renderText(t.description, text)}</p>}
                    </td>
                    <td className={table.td}>
                      <span className={cx('inline-flex items-center gap-1.5 text-sm', st.tone === 'muted' && 'text-muted')}>
                        <span className={cx('size-1.5 rounded-full', st.tone === 'ok' ? 'bg-ok' : st.tone === 'warn' ? 'bg-warn' : 'bg-faint')} aria-hidden />
                        {st.label}
                      </span>
                      {(t.valid_from || t.valid_to) && (
                        <p className="text-xs text-muted tnum">{t.valid_from ? fmtDay(t.valid_from) : '…'} – {t.valid_to ? fmtDay(t.valid_to) : '…'}</p>
                      )}
                    </td>
                    <td className={table.td}>
                      {FREQ_LABEL[t.frequency]}
                      {t.frequency !== 'mensal' && <p className="text-xs text-muted">{t.weekdays.map((d) => WEEKDAYS_SHORT[d - 1]).join(' ')}</p>}
                    </td>
                    <td className={table.tdNum}>{Number(t.weight)}</td>
                    <td className={table.tdNum}>{t.gates.length || '—'}</td>
                    <td className={cx(table.td, 'text-sm')}>{t.assign_all ? 'Todos' : `${n} analista${n === 1 ? '' : 's'}`}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
