import { Input, Segmented, Select } from '@/components/ui'
import { useAnalysts, useTemplates } from '@/data/queries'
import { PERIOD_LABEL, presetRange, type PeriodPreset } from '@/lib/dates'
import { useSearchParamState } from '@/lib/hooks'

export interface FilterState {
  preset: PeriodPreset
  from: string
  to: string
  userId?: string
  templateId?: string
}

/** Filtros guardados na URL: dá para compartilhar o link de uma visão filtrada. */
export function useFilters(defaultPreset: PeriodPreset = 'semana'): [FilterState, {
  setPreset: (p: PeriodPreset) => void
  setRange: (from: string, to: string) => void
  setUser: (id: string | null) => void
  setTemplate: (id: string | null) => void
}] {
  const [p, setP] = useSearchParamState('periodo')
  const [de, setDe] = useSearchParamState('de')
  const [ate, setAte] = useSearchParamState('ate')
  const [u, setU] = useSearchParamState('analista')
  const [tp, setTp] = useSearchParamState('atividade')
  const preset = (p as PeriodPreset) || defaultPreset
  const range = preset === 'custom' && de && ate ? { from: de, to: ate } : presetRange(preset)
  return [
    { preset, ...range, userId: u ?? undefined, templateId: tp ?? undefined },
    {
      setPreset: (x) => {
        if (x === 'custom') { const r = presetRange(preset); setDe(r.from); setAte(r.to) }
        setP(x)
      },
      setRange: (f, t) => { setDe(f); setAte(t) },
      setUser: setU,
      setTemplate: setTp,
    },
  ]
}

export function FilterBar({ state, actions, showUser = true, showTemplate = true, presets = ['hoje', 'semana', 'mes', '30d', 'custom'] }: {
  state: FilterState
  actions: ReturnType<typeof useFilters>[1]
  showUser?: boolean
  showTemplate?: boolean
  presets?: PeriodPreset[]
}) {
  // Usuário desativado não entra nas métricas, então também sai do filtro.
  const analysts = useAnalysts()
  const templates = useTemplates()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented<PeriodPreset>
        ariaLabel="Período"
        value={state.preset}
        onChange={actions.setPreset}
        options={presets.map((p) => ({ value: p, label: PERIOD_LABEL[p] }))}
      />
      {state.preset === 'custom' && (
        <div className="flex items-center gap-1.5">
          <Input type="date" aria-label="De" className="h-9 w-[150px]" value={state.from} max={state.to}
            onChange={(e) => e.target.value && actions.setRange(e.target.value, state.to)} />
          <span className="text-muted">–</span>
          <Input type="date" aria-label="Até" className="h-9 w-[150px]" value={state.to} min={state.from}
            onChange={(e) => e.target.value && actions.setRange(state.from, e.target.value)} />
        </div>
      )}
      {showUser && (
        <Select aria-label="Analista" className="w-auto min-w-40" value={state.userId ?? ''} onChange={(e) => actions.setUser(e.target.value || null)}>
          <option value="">Todos os analistas</option>
          {analysts.data.map((a) => <option key={a.id} value={a.id}>{a.full_name}{a.active ? '' : ' (inativo)'}</option>)}
        </Select>
      )}
      {showTemplate && (
        <Select aria-label="Atividade" className="w-auto min-w-44" value={state.templateId ?? ''} onChange={(e) => actions.setTemplate(e.target.value || null)}>
          <option value="">Todas as atividades</option>
          {(templates.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.code ? `${t.code} · ` : ''}{t.name}</option>)}
        </Select>
      )}
    </div>
  )
}
