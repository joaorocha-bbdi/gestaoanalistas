import type { ReactNode } from 'react'
import { cx, InfoTip } from '@/components/ui'
import { METRIC_DOCS, pct, type MetricSet } from '@/lib/metrics'
import { RateBar } from './charts'

type DocKey = keyof typeof METRIC_DOCS

function Doc({ k }: { k: DocKey }) {
  const d = METRIC_DOCS[k]
  return (
    <InfoTip label={`Como é calculado: ${d.label}`}>
      <span className="block font-semibold">{d.label}</span>
      <span className="mt-1 block text-sm leading-5">{d.formula}</span>
      <span className="mt-1.5 block text-muted">{d.detail}</span>
    </InfoTip>
  )
}

/** Linha da lista de indicadores: nome, valor, barra (quando é taxa) e contexto. */
export function Metric({ label, doc, value, rate, sub, tone }: {
  label: string; doc?: DocKey; value: ReactNode; rate?: number | null; sub?: ReactNode; tone?: 'bad' | 'warn' | 'ok'
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 border-b border-line py-3 last:border-0 sm:grid-cols-[11rem_5rem_1fr]">
      <div className="flex items-center gap-1 text-md">{label}{doc && <Doc k={doc} />}</div>
      <div className={cx('text-right font-display text-2xl font-semibold tnum sm:text-left',
        tone === 'bad' && 'text-bad', tone === 'warn' && 'text-warn', tone === 'ok' && 'text-ok')}>{value}</div>
      <div className="col-span-2 flex items-center gap-3 sm:col-span-1">
        {rate !== undefined && <RateBar value={rate} className="max-w-48 flex-1" />}
        {sub && <span className="text-sm text-muted tnum">{sub}</span>}
      </div>
    </div>
  )
}

/**
 * Eficiência como número principal (a pergunta do gestor) e os componentes
 * em lista, para ler de cima para baixo e comparar as taxas pela barra.
 */
export function MetricStrip({ m, streak }: { m: MetricSet; streak?: number }) {
  const c = m.counts
  const eff = m.efficiency
  return (
    <div className="grid gap-x-12 gap-y-6 lg:grid-cols-[16rem_1fr]">
      <div>
        <div className="flex items-center gap-1 text-md">Eficiência<Doc k="eficiencia" /></div>
        <p className="font-display text-5xl font-semibold tnum" aria-label={eff === null ? 'sem dados' : `${eff.toFixed(0)}% de eficiência`}>
          {eff === null ? '—' : `${eff.toFixed(0)}%`}
        </p>
        <p className="text-sm text-muted tnum">{c.expected - c.missed} de {c.expected} atividades concluídas</p>
        <RateBar value={eff === null ? null : eff / 100} className="mt-3 h-2" />
      </div>
      <div>
        <Metric label="Pontualidade" doc="pontualidade" value={pct(m.punctualityRate)} rate={m.punctualityRate}
          sub={`${c.late} com atraso`} />
        <Metric label="Qualidade" doc="qualidade" value={pct(m.qualityRate)} rate={m.qualityRate}
          sub={`${c.contested} contestada${c.contested === 1 ? '' : 's'} de ${c.reviewed} revisadas`} />
        <Metric label="Bloqueio por gate" doc="bloqueio" value={pct(m.gateBlockRate)}
          sub={`${c.gateBlockEvents} envio${c.gateBlockEvents === 1 ? '' : 's'} barrado${c.gateBlockEvents === 1 ? '' : 's'}`} />
        <Metric label="Sequência" doc="sequencia" value={streak ?? '—'} sub="dias plenos seguidos" />
      </div>
    </div>
  )
}
