import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { EmptyState, ErrorNote, PageHeader, Skeleton, table, cx } from '@/components/ui'
import { RateBar } from '@/features/metrics/charts'
import { useAnalysts, useFacts, useProfiles, useSettings } from '@/data/queries'
import { computeMetrics, groupBy, pct } from '@/lib/metrics'
import { addDays, startOfWeek, todayISO } from '@/lib/dates'
import { effectiveStatus, isOpen } from '@/lib/status'
import { useNow } from '@/lib/hooks'
import { PerformanceView } from '../analyst/Performance'
import { WeekView } from '../analyst/Week'

export default function Team() {
  const now = useNow()
  const today = todayISO()
  const settings = useSettings()
  const navigate = useNavigate()
  const analysts = useAnalysts()
  const week = useFacts({ from: startOfWeek(today), to: addDays(startOfWeek(today), 6) })
  const byUser = groupBy(week.data ?? [], (f) => f.user_id)

  return (
    <>
      <PageHeader title="Equipe" meta="Semana corrente. Clique em um analista para ver o detalhe." />
      <ErrorNote error={week.error || analysts.error} />
      {analysts.isLoading || week.isLoading ? <Skeleton className="h-48" /> : analysts.data.length === 0 ? (
        <EmptyState title="Nenhum analista ativo" action={<Link className="text-accent hover:underline" to="/admin/usuarios">Convidar analistas</Link>}>
          Convide a equipe em Usuários e acessos.
        </EmptyState>
      ) : (
        <div className={table.wrap}>
          <table className={cx(table.table, 'min-w-[640px]')}>
            <thead>
              <tr>
                <th className={table.th}>Analista</th>
                <th className={cx(table.th, 'w-44')}>Eficiência da semana</th>
                <th className={table.thNum}>Pendentes hoje</th>
                <th className={table.thNum}>Atrasadas na semana</th>
                <th className={table.thNum}>Conclusão</th>
              </tr>
            </thead>
            <tbody>
              {analysts.data.map((a) => {
                const xs = byUser.get(a.id) ?? []
                const m = computeMetrics(xs, settings.pesos_eficiencia)
                const pendingToday = xs.filter((f) => f.ref_date === today && isOpen(f.status) && new Date(f.due_at).getTime() > now).length
                const late = xs.filter((f) => ['nao_feita', 'concluida_atraso', 'bloqueada_gate'].includes(effectiveStatus(f, now))).length
                return (
                  <tr key={a.id} tabIndex={0} className={table.trClick} onClick={() => navigate(`/admin/equipe/${a.id}`)}
                    onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/admin/equipe/${a.id}`) }}>
                    <td className={table.td}><span className="font-medium">{a.full_name}</span><span className="ml-2 text-sm text-muted">{a.email}</span></td>
                    <td className={table.td}>
                      <div className="flex items-center gap-2">
                        <span className="w-10 text-right font-mono text-sm tnum">{m.efficiency === null ? '—' : m.efficiency.toFixed(0)}</span>
                        <RateBar value={m.efficiency === null ? null : m.efficiency / 100} />
                      </div>
                    </td>
                    <td className={table.tdNum}>{pendingToday}</td>
                    <td className={cx(table.tdNum, late > 0 && 'text-bad')}>{late}</td>
                    <td className={table.tdNum}>{pct(m.completionRate)}</td>
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

export function AnalystDetail() {
  const { id } = useParams()
  const profiles = useProfiles()
  const p = profiles.data?.find((x) => x.id === id)
  return (
    <>
      <Link to="/admin/equipe" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Equipe
      </Link>
      <PageHeader title={p?.full_name ?? '…'} meta={p ? `${p.email}${p.active ? '' : ' · inativo'}` : undefined} />
      <div className="mb-12"><WeekView userId={id} title="Semana" embedded /></div>
      <PerformanceView userId={id} title="Desempenho" embedded />
    </>
  )
}
