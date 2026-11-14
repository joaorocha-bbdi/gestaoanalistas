import {
  forwardRef, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  Ban, CheckCircle2, Circle, CircleDashed, CircleDot, Clock, Info, Loader2, PauseCircle, ShieldAlert, ShieldCheck,
  ShieldQuestion, X, XCircle,
} from 'lucide-react'
import { REVIEW_META, STATUS_META, type Tone } from '@/lib/status'
import type { ReviewStatus, TaskStatus } from '@/lib/types'

export const cx = clsx

// ---------------------------------------------------------------------
// Botões
// ---------------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md'
  loading?: boolean
  icon?: ReactNode
  kbd?: string
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, kbd, className, children, disabled, ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-sm' : 'h-10 px-4 text-base',
        variant === 'primary' && 'bg-signal font-semibold text-signal-ink shadow-[inset_0_0_0_1px_rgb(var(--signal-ink)/0.25)] hover:brightness-95',
        variant === 'secondary' && 'border border-line bg-surface hover:bg-hover',
        variant === 'ghost' && 'text-muted hover:bg-hover hover:text-ink',
        variant === 'danger' && 'border border-bad/40 bg-surface text-bad hover:bg-bad/5',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
      {kbd && <Kbd className={variant === 'primary' ? 'border-signal-ink/30 bg-transparent text-signal-ink/70' : ''}>{kbd}</Kbd>}
    </button>
  )
})

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx('inline-flex size-8 items-center justify-center rounded text-muted hover:bg-hover hover:text-ink', className)}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cx('hidden rounded-sm border border-line bg-subtle px-1 font-mono text-2xs text-muted sm:inline-block', className)}>
      {children}
    </kbd>
  )
}

// ---------------------------------------------------------------------
// Formulário
// ---------------------------------------------------------------------
const inputBase =
  'w-full rounded border border-line bg-surface px-3 text-base text-ink placeholder:text-faint ' +
  'hover:border-line-strong focus:border-ink focus:outline-none focus:ring-2 focus:ring-signal ' +
  'disabled:cursor-not-allowed disabled:bg-subtle disabled:text-muted aria-[invalid=true]:border-bad'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  function Input({ className, mono, ...rest }, ref) {
    return <input ref={ref} className={cx(inputBase, 'h-10', mono && 'font-mono text-md', className)} {...rest} />
  },
)

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(
  function Textarea({ className, mono, rows = 3, ...rest }, ref) {
    return <textarea ref={ref} rows={rows} className={cx(inputBase, 'py-2 leading-5', mono && 'font-mono text-md', className)} {...rest} />
  },
)

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  const hasWidth = /(^|\s)w-/.test(className ?? '')
  return (
    <select
      className={cx(inputBase.replace('w-full ', hasWidth ? '' : 'w-full '), 'h-10 appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat pr-8', className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='1.5'%3E%3Cpath d='m7 10 5 5 5-5'/%3E%3C/svg%3E\")" }}
      {...rest}
    >
      {children}
    </select>
  )
}

export function Checkbox({ label, checked, onChange, disabled, hint }: {
  label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: ReactNode
}) {
  return (
    <label className={cx('flex cursor-pointer items-start gap-2.5 text-base', disabled && 'cursor-not-allowed opacity-60')}>
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 rounded-sm border-line-strong accent-[rgb(var(--ink))]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint && <span className="block text-sm text-muted">{hint}</span>}
      </span>
    </label>
  )
}

export function FormField({ label, hint, required, error, children, htmlFor, className }: {
  label: ReactNode; hint?: ReactNode; required?: boolean; error?: string; children: ReactNode; htmlFor?: string; className?: string
}) {
  return (
    <div className={cx('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
        {required && <span className="ml-1 text-muted" aria-label="obrigatório">*</span>}
      </label>
      {children}
      {hint && !error && <p className="text-sm text-muted">{hint}</p>}
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  )
}

/** Controle segmentado (Sim/Não, períodos…). */
export function Segmented<T extends string>({ value, onChange, options, size = 'md', ariaLabel, disabled }: {
  value: T | null | undefined
  onChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
  size?: 'sm' | 'md'
  ariaLabel?: string
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex rounded border border-line bg-subtle p-0.5">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cx(
              'rounded-sm font-medium transition-colors disabled:cursor-not-allowed',
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
              active ? 'bg-signal font-semibold text-signal-ink shadow-[inset_0_0_0_1px_rgb(var(--signal-ink)/0.3)]' : 'text-muted hover:text-ink',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------
export const toneText: Record<Tone, string> = {
  neutral: 'text-muted', accent: 'text-accent', ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', muted: 'text-faint',
}

const STATUS_ICON: Record<TaskStatus, typeof Circle> = {
  pendente: Circle,
  em_andamento: CircleDot,
  concluida_prazo: CheckCircle2,
  concluida_atraso: Clock,
  bloqueada_gate: Ban,
  nao_feita: XCircle,
  pausada: PauseCircle,
}

export function StatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const Icon = STATUS_ICON[status]
  return <Icon aria-hidden className={cx('size-4 shrink-0', toneText[STATUS_META[status].tone], className)} strokeWidth={1.75} />
}

export function StatusLabel({ status, short, className }: { status: TaskStatus; short?: boolean; className?: string }) {
  const m = STATUS_META[status]
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap text-sm', className)}>
      <StatusIcon status={status} />
      <span className={status === 'pendente' || status === 'pausada' ? 'text-muted' : 'text-ink'}>{short ? m.short : m.label}</span>
    </span>
  )
}

const REVIEW_ICON: Record<ReviewStatus, typeof Circle> = {
  nao_revisada: ShieldQuestion, validada: ShieldCheck, contestada: ShieldAlert,
}

export function ReviewLabel({ status, className }: { status: ReviewStatus; className?: string }) {
  const m = REVIEW_META[status]
  const Icon = REVIEW_ICON[status]
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap text-sm', className)}>
      <Icon aria-hidden className={cx('size-4', toneText[m.tone])} strokeWidth={1.75} />
      <span className={status === 'nao_revisada' ? 'text-muted' : 'text-ink'}>{m.label}</span>
    </span>
  )
}

export function Spinner({ label = 'Carregando' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-10 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}…
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded bg-subtle', className)} />
}

export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 border border-dashed border-line px-5 py-8 sm:items-center sm:text-center rounded">
      {icon ?? <CircleDashed className="size-5 text-faint" aria-hidden strokeWidth={1.5} />}
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  const msg = error instanceof Error ? error.message : String(error)
  return (
    <div role="alert" className="flex items-start gap-2 rounded border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
      <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> <span>{msg}</span>
    </div>
  )
}

// ---------------------------------------------------------------------
// Estrutura de página
// ---------------------------------------------------------------------
export function PageHeader({ title, meta, actions, children }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-6 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold">{title}</h1>
          {meta && <div className="mt-1 text-sm text-muted">{meta}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  )
}

export function Section({ title, meta, actions, children, className }: {
  title: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <section className={cx('mb-12', className)}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t-2 border-ink pt-3">
        <h2 className="text-xl font-semibold">{title}</h2>
        {meta && <p className="min-w-0 basis-full text-sm text-muted sm:flex-1 sm:basis-0">{meta}</p>}
        {actions}
      </div>
      {children}
    </section>
  )
}

/** Tooltip de explicação (ícone de informação). Funciona com teclado e toque. */
export function InfoTip({ children, label = 'Como é calculado' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <span ref={ref} className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex size-5 items-center justify-center rounded-sm text-faint hover:text-ink"
      >
        <Info className="size-3.5" aria-hidden />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute left-1/2 top-full z-30 mt-1 w-64 -translate-x-1/2 rounded border border-line bg-surface p-3 text-left text-sm font-normal text-ink shadow-pop"
        >
          {children}
        </span>
      )}
    </span>
  )
}

// ---------------------------------------------------------------------
// Camadas: painel lateral e diálogo
// ---------------------------------------------------------------------
function useEscape(onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, active])
}

function useFocusOnOpen(ref: React.RefObject<HTMLElement>, open: boolean) {
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const html = document.documentElement
    const before = html.style.overflow
    html.style.overflow = 'hidden'
    return () => { html.style.overflow = before; prev?.focus?.() }
  }, [open, ref])
}

/** Modal grande e centralizado (não é aba lateral). No celular ocupa a tela inteira. */
export function Sheet({ open, onClose, title, children, footer, width = 'max-w-3xl', labelledBy }: {
  open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string; labelledBy?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEscape(onClose, open)
  useFocusOnOpen(ref, open)
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-stretch justify-center sm:items-center sm:p-6">
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cx('relative flex h-full w-full flex-col bg-surface shadow-pop outline-none sm:h-auto sm:max-h-[90vh] sm:rounded-lg', width, 'animate-[slidein_160ms_ease-out]')}
      >
        {title !== undefined && (
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1">{title}</div>
            <IconButton label="Fechar (Esc)" onClick={onClose}><X className="size-4" /></IconButton>
          </div>
        )}
        <div className="flex-1 overflow-y-auto scrollbar-thin">{children}</div>
        {footer && <div className="border-t border-line bg-surface px-5 py-3 pb-[max(12px,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
      <style>{'@keyframes slidein{from{transform:translateY(10px) scale(.99);opacity:.5}to{transform:none;opacity:1}}'}</style>
    </div>,
    document.body,
  )
}

/**
 * Tela cheia: a atividade ocupa a página inteira (não é aba lateral).
 * Barra superior com "Voltar" (Esc), conteúdo centralizado e rolagem própria.
 */
export function FullPage({ open, onClose, title, children, labelledBy, backLabel = 'Voltar' }: {
  open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; labelledBy?: string; backLabel?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEscape(onClose, open)
  useFocusOnOpen(ref, open)
  if (!open) return null
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      className="fixed inset-0 z-40 flex flex-col bg-bg outline-none animate-[pagein_160ms_ease-out]"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 bg-rail px-2 text-rail-ink sm:px-4">
        <button type="button" onClick={onClose}
          className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-sm font-medium text-rail-ink/80 hover:bg-white/10 hover:text-rail-ink">
          <X className="size-4" aria-hidden /> {backLabel}
          <Kbd className="ml-1 border-white/20 bg-transparent text-rail-ink/60">Esc</Kbd>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col bg-surface sm:my-6 sm:min-h-0 sm:rounded-lg sm:border sm:border-line">
          {title !== undefined && <div className="border-b border-line px-5 py-5 sm:px-8">{title}</div>}
          <div className="flex-1">{children}</div>
        </div>
      </div>
      <style>{'@keyframes pagein{from{opacity:.4;transform:translateY(8px)}to{opacity:1;transform:none}}'}</style>
    </div>,
    document.body,
  )
}

export function Dialog({ open, onClose, title, children, footer }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  useEscape(onClose, open)
  useFocusOnOpen(ref, open)
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-start sm:p-4 sm:pt-[12vh]">
      <div className="absolute inset-0 bg-black/25 dark:bg-black/55" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        className="relative w-full max-w-lg rounded-t-lg border border-line bg-surface shadow-pop outline-none sm:rounded-lg"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 id={id} className="font-semibold">{title}</h2>
          <IconButton label="Fechar (Esc)" onClick={onClose}><X className="size-4" /></IconButton>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------
// Tabela
// ---------------------------------------------------------------------
export const table = {
  wrap: 'overflow-x-auto scrollbar-thin -mx-4 px-4 sm:mx-0 sm:px-0',
  table: 'w-full border-collapse text-base',
  th: 'h-9 whitespace-nowrap border-b-2 border-line-strong px-3 text-left text-sm font-medium text-muted first:pl-0 last:pr-0',
  thNum: 'h-9 whitespace-nowrap border-b-2 border-line-strong px-3 text-right text-sm font-medium text-muted last:pr-0',
  tr: 'border-b border-line last:border-0',
  trClick: 'cursor-pointer border-b border-line last:border-0 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none',
  td: 'h-11 px-3 py-2 align-middle first:pl-0 last:pr-0',
  tdNum: 'h-11 px-3 py-2 text-right align-middle tnum last:pr-0',
}
