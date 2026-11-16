import { useEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { Button, cx, ErrorNote, FormField, IconButton, Input, PageHeader, Section, Select, Skeleton, table } from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { useHolidays, useSaveSetting, useSettingRows, useSettings } from '@/data/queries'
import { fmtDay, fmtWeekday, todayISO, WEEKDAYS_SHORT } from '@/lib/dates'
import { errorMessage } from '@/lib/status'
import { supabase } from '@/lib/supabase'

export default function SettingsPage() {
  const rows = useSettingRows()
  const s = useSettings()
  if (rows.isLoading) return <Skeleton className="h-96" />
  return (
    <>
      <PageHeader title="Parâmetros" meta="Toda alteração fica registrada na auditoria." />
      <ErrorNote error={rows.error} />

      <Section title="Rotação de curvas" meta="qual curva cada dia precifica">
        <CurveMap />
      </Section>

      <Section title="Rótulos e revisão">
        <div className="grid gap-5 sm:grid-cols-2">
          <TextSetting settingKey="rotulo_concorrente" label="Concorrente de referência" hint="Substitui {concorrente} em instruções e perguntas." value={s.rotulo_concorrente} />
          <TextSetting settingKey="amostragem_revisao" label="Amostra de revisão (%)" hint="Percentual estável sorteado para a fila de revisão." value={String(s.amostragem_revisao)} numeric />
          <TextSetting settingKey="hub_url" label="Endereço do hub" value={s.hub_url} />
        </div>
      </Section>

      <Section title="Listas de opções" meta="usadas por campos de seleção">
        <div className="grid gap-5 sm:grid-cols-2">
          {(rows.data ?? []).filter((r) => r.key.endsWith('_opcoes') || r.key === 'curvas').map((r) => (
            <ListSetting key={r.key} settingKey={r.key} label={r.label} value={r.value as string[]} />
          ))}
        </div>
      </Section>

      <Section title="Expediente">
        <Workdays />
      </Section>

      <Section title="Feriados e dias sem expediente" meta="não geram tarefas nem contam ponto">
        <Holidays />
      </Section>
    </>
  )
}

function useSave() {
  const save = useSaveSetting()
  const toast = useToast()
  return {
    pending: save.isPending,
    run: async (key: string, value: unknown) => {
      try { await save.mutateAsync({ key, value }); toast('Parâmetro salvo.') } catch (e) { toast(errorMessage(e), 'bad') }
    },
  }
}

function Row({ children, onSave, dirty, pending }: { children: ReactNode; onSave: () => void; dirty: boolean; pending: boolean }) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      {children}
      <Button size="md" disabled={!dirty} loading={pending} onClick={onSave}>Salvar</Button>
    </div>
  )
}

function CurveMap() {
  const s = useSettings()
  const [v, setV] = useState(s.curva_por_dia)
  useEffect(() => setV(s.curva_por_dia), [s.curva_por_dia])
  const { run, pending } = useSave()
  const dirty = JSON.stringify(v) !== JSON.stringify(s.curva_por_dia)
  const today = todayISO()
  return (
    <Row dirty={dirty} pending={pending} onSave={() => run('curva_por_dia', v)}>
      {s.dias_uteis.map((d) => (
        <FormField key={d} label={<span className={fmtWeekday(today) === WEEKDAYS_SHORT[d - 1] ? 'text-accent' : ''}>{WEEKDAYS_SHORT[d - 1]}</span>}>
          <Select className="w-20" value={v[String(d)] ?? ''} onChange={(e) => {
            const n = { ...v }
            if (e.target.value) n[String(d)] = e.target.value
            else delete n[String(d)]
            setV(n)
          }}>
            <option value="">—</option>
            {s.curvas.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </FormField>
      ))}
    </Row>
  )
}

function TextSetting({ settingKey, label, hint, value, numeric }: { settingKey: string; label: string; hint?: string; value: string; numeric?: boolean }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const { run, pending } = useSave()
  return (
    <Row dirty={v !== value && v.trim() !== ''} pending={pending} onSave={() => run(settingKey, numeric ? Number(v) : v.trim())}>
      <FormField label={label} hint={hint} className="min-w-0 flex-1">
        <Input type={numeric ? 'number' : 'text'} value={v} onChange={(e) => setV(e.target.value)} />
      </FormField>
    </Row>
  )
}

function ListSetting({ settingKey, label, value }: { settingKey: string; label: string; value: string[] }) {
  const text = value.join('\n')
  const [v, setV] = useState(text)
  useEffect(() => setV(text), [text])
  const { run, pending } = useSave()
  return (
    <div className="space-y-2">
      <FormField label={label} hint="Uma opção por linha.">
        <textarea rows={5} className="w-full rounded border border-line bg-surface px-3 py-2 text-base focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
          value={v} onChange={(e) => setV(e.target.value)} />
      </FormField>
      <Button size="sm" disabled={v === text} loading={pending}
        onClick={() => run(settingKey, v.split('\n').map((s) => s.trim()).filter(Boolean))}>Salvar</Button>
    </div>
  )
}

function Workdays() {
  const s = useSettings()
  const [v, setV] = useState(s.dias_uteis)
  useEffect(() => setV(s.dias_uteis), [s.dias_uteis])
  const { run, pending } = useSave()
  const dirty = JSON.stringify([...v].sort()) !== JSON.stringify([...s.dias_uteis].sort())
  return (
    <Row dirty={dirty && v.length > 0} pending={pending} onSave={() => run('dias_uteis', [...v].sort())}>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Dias de expediente">
        {WEEKDAYS_SHORT.map((d, i) => {
          const n = i + 1, on = v.includes(n)
          return (
            <button key={d} type="button" aria-pressed={on} onClick={() => setV(on ? v.filter((x) => x !== n) : [...v, n])}
              className={cx('h-9 w-11 rounded border text-sm', on ? 'border-accent bg-accent-soft' : 'border-line text-muted hover:bg-hover')}>
              {d}
            </button>
          )
        })}
      </div>
    </Row>
  )
}

function Holidays() {
  const q = useHolidays()
  const qc = useQueryClient()
  const toast = useToast()
  const [day, setDay] = useState('')
  const [label, setLabel] = useState('')
  const today = todayISO()
  const list = (q.data ?? []).filter((h) => h.day >= today.slice(0, 4) + '-01-01')

  async function add() {
    const { error } = await supabase.from('holidays').upsert({ day, label: label.trim() })
    if (error) { toast(errorMessage(error), 'bad'); return }
    setDay(''); setLabel('')
    await qc.invalidateQueries({ queryKey: ['holidays'] })
    toast('Feriado adicionado. Tarefas intocadas desse dia não serão mais geradas.')
  }
  async function remove(d: string) {
    const { error } = await supabase.from('holidays').delete().eq('day', d)
    if (error) { toast(errorMessage(error), 'bad'); return }
    await qc.invalidateQueries({ queryKey: ['holidays'] })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <FormField label="Data"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></FormField>
        <FormField label="Descrição" className="min-w-48 flex-1"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ex.: Ponte de feriado" /></FormField>
        <Button icon={<Plus className="size-4" />} disabled={!day || !label.trim()} onClick={add}>Adicionar</Button>
      </div>
      <table className={table.table}>
        <tbody>
          {list.map((h) => (
            <tr key={h.day} className={cx(table.tr, h.day < today && 'text-muted')}>
              <td className={cx(table.td, 'w-32 font-mono text-sm tnum')}>{fmtDay(h.day)} <span className="text-faint">{h.day.slice(0, 4)}</span></td>
              <td className={cx(table.td, 'w-14 text-muted')}>{fmtWeekday(h.day)}</td>
              <td className={table.td}>{h.label}</td>
              <td className={cx(table.td, 'w-10')}><IconButton label={`Remover ${h.label}`} onClick={() => remove(h.day)}><Trash2 className="size-4" /></IconButton></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
