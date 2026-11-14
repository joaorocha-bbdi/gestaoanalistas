import { useId, useState } from 'react'
import { Lightbulb, Plus, Trash2 } from 'lucide-react'
import { Button, cx, FormField, IconButton, Input, Segmented, Select, Textarea } from '@/components/ui'
import { displayValue, initialPayload, parseList, renderText, resolveOptions, type TextContext } from '@/lib/fields'
import type { FieldDef, Payload } from '@/lib/types'

interface Ctx {
  text: TextContext
  settings: Record<string, unknown>
  readOnly?: boolean
  /** Rótulos de campo com erro (após tentativa de envio). */
  errors?: Set<string>
}

export function FieldList({ defs, value, onChange, ctx, prefix = '' }: {
  defs: FieldDef[]; value: Payload; onChange: (v: Payload) => void; ctx: Ctx; prefix?: string
}) {
  const Wrap = ctx.readOnly ? 'dl' : 'div'
  return (
    <Wrap className={ctx.readOnly ? 'space-y-3' : 'space-y-5'}>
      {defs.map((f) => (
        <FieldInput
          key={f.key}
          def={f}
          value={value?.[f.key]}
          onChange={(v) => onChange({ ...value, [f.key]: v })}
          ctx={ctx}
          errorKey={prefix + f.label}
        />
      ))}
    </Wrap>
  )
}

function Note({ children }: { children: string }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-muted">
      <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

export function FieldInput({ def, value, onChange, ctx, errorKey }: {
  def: FieldDef; value: unknown; onChange: (v: unknown) => void; ctx: Ctx; errorKey: string
}) {
  const id = useId()
  const label = renderText(def.label, ctx.text)
  const invalid = ctx.errors?.has(errorKey) || ctx.errors?.has(label)

  if (def.type === 'group') return <GroupInput def={def} value={value} onChange={onChange} ctx={ctx} />

  if (ctx.readOnly) {
    return (
      <div className="grid gap-1 sm:grid-cols-[minmax(0,220px)_1fr] sm:gap-4">
        <dt className="text-sm text-muted">{label}</dt>
        <dd className={cx('whitespace-pre-wrap break-words', def.mono && 'font-mono text-sm')}>{displayValue(def, value)}</dd>
      </div>
    )
  }

  let control: React.ReactNode
  switch (def.type) {
    case 'number':
      control = (
        <Input
          id={id} type="number" inputMode="numeric" className="max-w-40 tnum" aria-invalid={invalid}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      )
      break
    case 'text':
    case 'link':
      control = (
        <Input
          id={id} type={def.type === 'link' ? 'url' : 'text'} mono={def.mono} aria-invalid={invalid}
          placeholder={def.type === 'link' ? 'https://' : undefined}
          value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)}
        />
      )
      break
    case 'textarea':
      control = <Textarea id={id} aria-invalid={invalid} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
      break
    case 'date':
      control = <Input id={id} type="date" className="max-w-48" aria-invalid={invalid} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)} />
      break
    case 'select': {
      const opts = resolveOptions(def, ctx.settings)
      control = (
        <Select id={id} className="max-w-72" aria-invalid={invalid} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Escolha…</option>
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      )
      break
    }
    case 'boolean':
      control = (
        <Segmented<'sim' | 'nao'>
          ariaLabel={label}
          value={value === true ? 'sim' : value === false ? 'nao' : null}
          onChange={(v) => onChange(v === 'sim')}
          options={[{ value: 'sim', label: 'Sim' }, { value: 'nao', label: 'Não' }]}
        />
      )
      break
    case 'list':
      control = <ListInput id={id} value={value} onChange={onChange} mono={def.mono} invalid={invalid} />
      break
  }

  if (def.type === 'boolean') {
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <span className={cx('text-base', invalid && 'text-bad')}>
            {label}{def.required && <span className="ml-1 text-muted" aria-label="obrigatório">*</span>}
          </span>
          {control}
        </div>
        {def.note && <Note>{def.note}</Note>}
      </div>
    )
  }

  return (
    <FormField
      label={label}
      htmlFor={id}
      required={def.required}
      hint={def.help ? renderText(def.help, ctx.text) : undefined}
      error={invalid ? 'Obrigatório' : undefined}
    >
      {control}
      {def.note && <Note>{def.note}</Note>}
    </FormField>
  )
}

function ListInput({ id, value, onChange, mono, invalid }: {
  id: string; value: unknown; onChange: (v: string[]) => void; mono?: boolean; invalid?: boolean
}) {
  const items = Array.isArray(value) ? (value as string[]) : []
  // Texto livre enquanto digita; vira lista ao sair do campo.
  const [text, setText] = useState(items.join('\n'))
  const count = parseList(text).length
  return (
    <div>
      <Textarea
        id={id} mono={mono} rows={Math.min(8, Math.max(3, items.length + 1))} aria-invalid={invalid}
        value={text}
        placeholder="Um por linha"
        onChange={(e) => { setText(e.target.value); onChange(parseList(e.target.value)) }}
      />
      <p className="mt-1 text-xs text-muted tnum">{count} {count === 1 ? 'item' : 'itens'}</p>
    </div>
  )
}

function GroupInput({ def, value, onChange, ctx }: { def: FieldDef; value: unknown; onChange: (v: unknown) => void; ctx: Ctx }) {
  const items = (Array.isArray(value) ? value : []) as Payload[]
  const min = def.min_items ?? 0
  const itemLabel = def.item_label ?? def.label
  const set = (i: number, v: Payload) => onChange(items.map((x, j) => (j === i ? v : x)))
  return (
    <div className="space-y-4">
      <div>
        <p className="text-md font-semibold">{renderText(def.label, ctx.text)}</p>
        {def.help && <p className="text-sm text-muted">{renderText(def.help, ctx.text)}</p>}
        {ctx.readOnly && items.length === 0 && <p className="text-sm text-muted">Nenhum item informado.</p>}
      </div>
      {items.map((item, i) => (
        <fieldset key={i} className="rounded border border-line">
          <legend className="sr-only">{itemLabel} {i + 1}</legend>
          <div className="flex items-center justify-between border-b border-line bg-subtle/60 px-4 py-2">
            <span className="text-sm font-medium">
              {itemLabel} {i + 1}
              {min > 0 && <span className="ml-1.5 font-normal text-muted tnum">de {Math.max(min, items.length)}</span>}
            </span>
            {!ctx.readOnly && items.length > min && (
              <IconButton label={`Remover ${itemLabel.toLowerCase()} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </IconButton>
            )}
          </div>
          <div className="px-4 py-4">
            <FieldList defs={def.fields ?? []} value={item ?? {}} onChange={(v) => set(i, v)} ctx={ctx} prefix={`${itemLabel} ${i + 1} · `} />
          </div>
        </fieldset>
      ))}
      {!ctx.readOnly && (
        <Button size="sm" variant="ghost" icon={<Plus className="size-4" />}
          onClick={() => onChange([...items, initialPayload(def.fields)])}>
          Adicionar {itemLabel.toLowerCase()}
        </Button>
      )}
    </div>
  )
}
