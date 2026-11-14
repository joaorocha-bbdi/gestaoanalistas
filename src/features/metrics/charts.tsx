import { useEffect, useRef, useState } from 'react'
import { cx } from '@/components/ui'

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(600)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

export interface Point { x: string; label: string; y: number | null; detail?: string }

/**
 * Linha única, 2px, escala fixa 0–100. Rótulo direto no último ponto,
 * cruz + tooltip no hover/foco. Sem legenda: o título da seção nomeia a série.
 */
export function LineChart({ points, height = 180, ariaLabel, format = (v) => v.toFixed(0) }: {
  points: Point[]; height?: number; ariaLabel: string; format?: (v: number) => string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const pad = { l: 28, r: 44, t: 12, b: 24 }
  const iw = width - pad.l - pad.r
  const ih = height - pad.t - pad.b
  const n = points.length
  const x = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
  const y = (v: number) => pad.t + ih - (v / 100) * ih

  const segs: string[] = []
  let cur = ''
  points.forEach((p, i) => {
    if (p.y === null) { if (cur) segs.push(cur); cur = ''; return }
    cur += `${cur ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`
  })
  if (cur) segs.push(cur)
  let lastIdx = -1
  points.forEach((p, i) => { if (p.y !== null) lastIdx = i })
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))))

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const i = n <= 1 ? 0 : Math.round(((px - pad.l) / iw) * (n - 1))
    setHover(Math.min(Math.max(i, 0), n - 1))
  }

  const hp = hover !== null ? points[hover] : null

  return (
    <div ref={ref} className="relative">
      <svg
        width={width} height={height} role="img" aria-label={ariaLabel}
        onPointerMove={onMove} onPointerLeave={() => setHover(null)}
        className="block touch-pan-y"
      >
        {[0, 50, 100].map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={width - pad.r} y1={y(g)} y2={y(g)} stroke="rgb(var(--line))" strokeWidth={1} />
            <text x={pad.l - 6} y={y(g)} dy="0.32em" textAnchor="end" className="fill-faint font-mono text-[10px]">{g}</text>
          </g>
        ))}
        {points.map((p, i) => (i % labelEvery === 0 || i === n - 1) && (
          <text key={p.x} x={x(i)} y={height - 6} textAnchor="middle" className="fill-muted text-[11px]">{p.label}</text>
        ))}
        {segs.map((d, i) => <path key={i} d={d} fill="none" stroke="rgb(var(--accent))" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
        {points.map((p, i) => p.y !== null && (
          <circle key={p.x} cx={x(i)} cy={y(p.y)} r={hover === i ? 4.5 : 2.5} fill="rgb(var(--accent))" stroke="rgb(var(--surface))" strokeWidth={2} />
        ))}
        {lastIdx >= 0 && points[lastIdx].y !== null && (
          <text x={x(lastIdx) + 8} y={y(points[lastIdx].y!)} dy="0.32em" className="fill-ink font-mono text-[12px] font-medium">
            {format(points[lastIdx].y!)}
          </text>
        )}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="rgb(var(--line-strong))" strokeDasharray="2 3" />}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded border border-line bg-surface px-2.5 py-1.5 text-xs shadow-pop"
          style={{ left: Math.min(Math.max(x(hover!) - 70, 0), width - 150), width: 150 }}
        >
          <div className="text-muted">{hp.label}</div>
          <div className="font-mono text-sm font-medium tnum">{hp.y === null ? 'sem dados' : format(hp.y)}</div>
          {hp.detail && <div className="text-muted">{hp.detail}</div>}
        </div>
      )}
    </div>
  )
}

/** Barra horizontal fina para comparar uma taxa (0–1). */
export function RateBar({ value, tone = 'accent', className }: { value: number | null; tone?: 'accent' | 'bad' | 'warn' | 'ok'; className?: string }) {
  const w = value === null ? 0 : Math.max(0, Math.min(1, value)) * 100
  return (
    <div className={cx('h-1.5 w-full rounded-full bg-subtle', className)} aria-hidden>
      <div className={cx('h-full rounded-full', tone === 'accent' && 'bg-accent', tone === 'bad' && 'bg-bad', tone === 'warn' && 'bg-warn', tone === 'ok' && 'bg-ok')}
        style={{ width: `${w}%` }} />
    </div>
  )
}

/** Previsto vs. realizado em um dia: trilho = previsto, preenchimento = concluídas. */
export function PlanBar({ planned, done, onTime, max, label }: { planned: number; done: number; onTime: number; max: number; label: string }) {
  const scale = (v: number) => (max ? (v / max) * 100 : 0)
  return (
    <div className="group relative" title={label} aria-label={label} role="img">
      <div className="relative h-2 rounded-full bg-subtle" style={{ width: `${scale(planned)}%`, minWidth: planned ? 4 : 0 }}>
        <div className="absolute inset-y-0 left-0 rounded-full bg-warn" style={{ width: planned ? `${(done / planned) * 100}%` : 0 }} />
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: planned ? `${(onTime / planned) * 100}%` : 0 }} />
      </div>
    </div>
  )
}

/** Mini linha para tabelas (tendência). */
export function Sparkline({ values, width = 72, height = 20 }: { values: (number | null)[]; width?: number; height?: number }) {
  const pts = values.map((v, i) => (v === null ? null : [i, v] as const)).filter(Boolean) as [number, number][]
  if (pts.length < 2) return <span className="text-xs text-faint">—</span>
  const n = values.length - 1
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${((i / n) * (width - 4) + 2).toFixed(1)},${(height - 2 - (v / 100) * (height - 4)).toFixed(1)}`).join('')
  const [li, lv] = pts[pts.length - 1]
  return (
    <svg width={width} height={height} aria-hidden className="inline-block align-middle">
      <path d={d} fill="none" stroke="rgb(var(--muted))" strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={(li / n) * (width - 4) + 2} cy={height - 2 - (lv / 100) * (height - 4)} r={2} fill="rgb(var(--accent))" />
    </svg>
  )
}
