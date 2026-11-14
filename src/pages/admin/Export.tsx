import { useState } from 'react'
import { Download } from 'lucide-react'
import { Button, ErrorNote, FormField, Input, PageHeader, Segmented } from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { addDays, todayISO } from '@/lib/dates'
import { downloadCsv, toCsv } from '@/lib/csv'
import { errorMessage } from '@/lib/status'
import { supabase } from '@/lib/supabase'

type Dataset = 'tarefas' | 'envios' | 'revisoes' | 'auditoria'

const DATASETS: Record<Dataset, { label: string; detail: string }> = {
  tarefas: { label: 'Tarefas', detail: 'Uma linha por tarefa (fatos usados nas métricas): status, prazo, envio, revisão, bloqueios, peso.' },
  envios: { label: 'Envios', detail: 'Cada tentativa de envio, inclusive as barradas pelo gate, com respostas e desvio.' },
  revisoes: { label: 'Revisões', detail: 'Validações e contestações com motivo.' },
  auditoria: { label: 'Auditoria', detail: 'Log completo de alterações no período.' },
}

async function fetchAll(build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>) {
  const out: Record<string, unknown>[] = []
  for (let i = 0; ; i += 1000) {
    const { data, error } = await build(i, i + 999)
    if (error) throw new Error(error.message)
    out.push(...((data ?? []) as Record<string, unknown>[]))
    if (!data || data.length < 1000) return out
  }
}

export default function Export() {
  const today = todayISO()
  const toast = useToast()
  const [ds, setDs] = useState<Dataset>('tarefas')
  const [from, setFrom] = useState(addDays(today, -29))
  const [to, setTo] = useState(today)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setBusy(true); setError(null)
    try {
      const fromTs = `${from}T00:00:00-03:00`, toTs = `${to}T23:59:59.999-03:00`
      let rows: Record<string, unknown>[] = []
      if (ds === 'tarefas') {
        rows = await fetchAll((a, b) => supabase.from('v_task_facts').select('*').gte('ref_date', from).lte('ref_date', to).order('ref_date').order('id').range(a, b))
      } else if (ds === 'envios') {
        const subs = await fetchAll((a, b) => supabase.from('task_submissions')
          .select('id, submitted_at, gate_passed, result_status, deviation, payload, task:task_instances(ref_date, period_key, template_snapshot->>name, user:profiles(full_name)), gate_answers(gate_key, answer, expected)')
          .gte('submitted_at', fromTs).lte('submitted_at', toTs).order('submitted_at').range(a, b))
        rows = subs.map((s) => {
          const t = s.task as Record<string, unknown> | null
          return {
            enviado_em: s.submitted_at, analista: (t?.user as { full_name?: string } | null)?.full_name, atividade: t?.name,
            dia: t?.ref_date, periodo: t?.period_key, gate_ok: s.gate_passed, resultado: s.result_status,
            respostas_gate: ((s.gate_answers as { gate_key: string; answer: string }[]) ?? []).map((g) => `${g.gate_key}=${g.answer}`).join('; '),
            skus_desvio: ((s.deviation as { skus?: string[] } | null)?.skus ?? []).join(' '),
            acao_desvio: (s.deviation as { action?: string } | null)?.action ?? '',
            registro: s.payload,
          }
        })
      } else if (ds === 'revisoes') {
        const rv = await fetchAll((a, b) => supabase.from('reviews')
          .select('created_at, status, reason, reviewer:profiles(full_name), task:task_instances(ref_date, template_snapshot->>name, user:profiles(full_name))')
          .gte('created_at', fromTs).lte('created_at', toTs).order('created_at').range(a, b))
        rows = rv.map((r) => {
          const t = r.task as Record<string, unknown> | null
          return {
            revisado_em: r.created_at, revisor: (r.reviewer as { full_name?: string } | null)?.full_name,
            analista: (t?.user as { full_name?: string } | null)?.full_name, atividade: t?.name, dia: t?.ref_date,
            resultado: r.status, motivo: r.reason,
          }
        })
      } else {
        rows = await fetchAll((a, b) => supabase.from('audit_log').select('*').gte('at', fromTs).lte('at', toTs).order('at').range(a, b))
      }
      if (!rows.length) { setError('Nenhum registro no período.'); return }
      downloadCsv(`${ds}_${from}_${to}.csv`, toCsv(rows))
      toast(`${rows.length} linhas exportadas.`)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }

  return (
    <>
      <PageHeader title="Exportar dados" meta="CSV com separador ponto e vírgula e UTF-8, pronto para abrir no Excel." />
      <div className="max-w-xl space-y-6">
        <FormField label="Conjunto" hint={DATASETS[ds].detail}>
          <Segmented<Dataset> value={ds} onChange={setDs} options={(Object.keys(DATASETS) as Dataset[]).map((k) => ({ value: k, label: DATASETS[k].label }))} />
        </FormField>
        <div className="flex flex-wrap gap-3">
          <FormField label="De"><Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></FormField>
          <FormField label="Até"><Input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></FormField>
        </div>
        <ErrorNote error={error} />
        <Button variant="primary" icon={<Download className="size-4" />} loading={busy} onClick={run}>Baixar CSV</Button>
      </div>
    </>
  )
}
