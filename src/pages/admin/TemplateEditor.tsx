import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowLeft, ArrowUp, Eye, Plus, Trash2 } from 'lucide-react'
import {
  Button, Checkbox, cx, ErrorNote, FormField, IconButton, Input, PageHeader, Section, Segmented, Select, Skeleton, Textarea,
} from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { FieldList } from '@/features/tasks/FieldInput'
import { useAnalysts, useAssignments, useSettingRows, useSettings, useTemplates, useTextContext } from '@/data/queries'
import { FIELD_TYPE_LABEL, initialPayload, renderText, slugKey } from '@/lib/fields'
import { WEEKDAYS_SHORT } from '@/lib/dates'
import { useHotkeys } from '@/lib/hooks'
import { errorMessage } from '@/lib/status'
import { supabase } from '@/lib/supabase'
import type { ActivityTemplate, FieldDef, FieldType, Frequency, GateDef, Payload } from '@/lib/types'

const EMPTY: Omit<ActivityTemplate, 'id'> = {
  code: '', name: '', description: '', instructions: [], frequency: 'diaria', weekdays: [1, 2, 3, 4, 5],
  cutoff_time: '23:59:59', target_qty: null, target_label: null, weight: 1, valid_from: null, valid_to: null,
  paused: false, pause_reason: null, assign_all: true, shows_curve: false, sequential: false, fields: [], gates: [], followup_fields: [],
  sort_order: 100,
}

export default function TemplateEditor() {
  const { id } = useParams()
  const isNew = id === 'novo'
  const templates = useTemplates()
  const assignments = useAssignments()
  const existing = templates.data?.find((t) => t.id === id)
  if (!isNew && (templates.isLoading || assignments.isLoading)) return <Skeleton className="h-96" />
  if (!isNew && !existing) return <ErrorNote error="Modelo não encontrado." />
  const assigned = (assignments.data ?? []).filter((a) => a.template_id === id).map((a) => a.user_id)
  return <Editor key={id} initial={existing ?? { ...EMPTY, id: '' }} initialAssigned={assigned} isNew={isNew} />
}

function Editor({ initial, initialAssigned, isNew }: { initial: ActivityTemplate; initialAssigned: string[]; isNew: boolean }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const analysts = useAnalysts()
  const [t, setT] = useState<ActivityTemplate>(initial)
  const [assigned, setAssigned] = useState<string[]>(initialAssigned)
  const [instructions, setInstructions] = useState(initial.instructions.join('\n'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [preview, setPreview] = useState(false)
  const set = <K extends keyof ActivityTemplate>(k: K, v: ActivityTemplate[K]) => setT((x) => ({ ...x, [k]: v }))

  async function save() {
    setError(null)
    if (!t.name.trim()) { setError('Dê um nome ao modelo.'); return }
    if (t.frequency !== 'mensal' && !t.weekdays.length) { setError('Escolha ao menos um dia da semana.'); return }
    const keys = new Set<string>()
    for (const f of [...t.fields, ...t.gates]) {
      if (keys.has(f.key)) { setError(`Chave repetida: ${f.key}. Cada campo e verificação precisa de uma chave única.`); return }
      keys.add(f.key)
    }
    setSaving(true)
    try {
      const row = {
        code: t.code?.trim() || null, name: t.name.trim(), description: t.description?.trim() || null,
        instructions: instructions.split('\n').map((s) => s.trim()).filter(Boolean),
        frequency: t.frequency, weekdays: t.frequency === 'mensal' ? [1, 2, 3, 4, 5] : [...t.weekdays].sort(),
        cutoff_time: t.cutoff_time, target_qty: t.target_qty || null, target_label: t.target_label?.trim() || null,
        weight: Number(t.weight) || 1, valid_from: t.valid_from || null, valid_to: t.valid_to || null,
        paused: t.paused, pause_reason: t.paused ? t.pause_reason?.trim() || null : null,
        assign_all: t.assign_all, shows_curve: t.shows_curve,
        sequential: !!t.sequential,
        fields: t.fields, gates: t.gates, followup_fields: t.followup_fields, sort_order: t.sort_order,
      }
      let id = t.id
      if (isNew) {
        const { data, error } = await supabase.from('activity_templates').insert(row).select('id').single()
        if (error) throw error
        id = data.id
      } else {
        const { error } = await supabase.from('activity_templates').update(row).eq('id', id)
        if (error) throw error
      }
      // Atribuições específicas
      const target = t.assign_all ? [] : assigned
      const remove = initialAssigned.filter((u) => !target.includes(u))
      const add = target.filter((u) => !initialAssigned.includes(u))
      if (remove.length) {
        const { error } = await supabase.from('template_assignments').delete().eq('template_id', id).in('user_id', remove)
        if (error) throw error
      }
      if (add.length) {
        const { error } = await supabase.from('template_assignments').insert(add.map((u) => ({ template_id: id, user_id: u })))
        if (error) throw error
      }
      await qc.invalidateQueries({ queryKey: ['templates'] })
      await qc.invalidateQueries({ queryKey: ['assignments'] })
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      toast(isNew ? 'Modelo criado. As tarefas desta semana já foram geradas.' : 'Modelo salvo. Tarefas ainda não iniciadas foram atualizadas.')
      navigate('/admin/modelos')
    } catch (e) {
      setError(errorMessage(e).includes('duplicate key') ? 'Já existe um modelo com esse código.' : errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  useHotkeys({ 'mod+s': () => void save(), 'mod+enter': () => void save() })

  return (
    <>
      <Link to="/admin/modelos" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Modelos
      </Link>
      <PageHeader
        title={isNew ? 'Novo modelo' : t.name || 'Modelo'}
        meta={isNew ? 'Sem código: tudo aqui vira tarefa para os analistas.' : 'Mudanças valem para tarefas ainda não iniciadas. O histórico guarda a versão usada em cada dia.'}
        actions={
          <>
            <Button variant="ghost" icon={<Eye className="size-4" />} onClick={() => setPreview((p) => !p)}>{preview ? 'Fechar prévia' : 'Prévia'}</Button>
            <Button variant="primary" loading={saving} onClick={save} kbd="Ctrl S">Salvar</Button>
          </>
        }
      />
      <ErrorNote error={error} />

      <div className={cx('grid gap-10', preview && 'xl:grid-cols-[1fr_380px]')}>
        <div className="min-w-0">
          <Section title="Identificação">
            <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
              <FormField label="Código" hint="Ex.: D6">
                <Input mono value={t.code ?? ''} onChange={(e) => set('code', e.target.value.toUpperCase())} maxLength={8} />
              </FormField>
              <FormField label="Nome" required>
                <Input value={t.name} onChange={(e) => set('name', e.target.value)} />
              </FormField>
            </div>
            <FormField label="Descrição" className="mt-4" hint="Uma frase sobre o objetivo. Aceita {concorrente}.">
              <Input value={t.description ?? ''} onChange={(e) => set('description', e.target.value)} />
            </FormField>
            <FormField label="Etapas" className="mt-4" hint="Uma etapa por linha. O analista marca uma a uma, em ordem, e cada marcação registra data, horário e usuário. Links viram clicáveis.">
              <Textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            </FormField>
          </Section>

          <Section title="Agenda e meta">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField label="Frequência">
                <Segmented<Frequency> value={t.frequency} onChange={(v) => set('frequency', v)}
                  options={[{ value: 'diaria', label: 'Diária' }, { value: 'semanal', label: 'Semanal' }, { value: 'mensal', label: 'Mensal' }]} />
              </FormField>
              {t.frequency !== 'mensal' ? (
                <FormField label={t.frequency === 'diaria' ? 'Dias da semana' : 'Vence até'}
                  hint={t.frequency === 'semanal' ? 'Vence no último dia útil até o dia mais tarde marcado.' : undefined}>
                  <div className="flex flex-wrap gap-1" role="group" aria-label="Dias da semana">
                    {WEEKDAYS_SHORT.map((d, i) => {
                      const v = i + 1, on = t.weekdays.includes(v)
                      return (
                        <button key={d} type="button" aria-pressed={on}
                          onClick={() => set('weekdays', on ? t.weekdays.filter((x) => x !== v) : [...t.weekdays, v])}
                          className={cx('h-8 w-10 rounded border text-sm', on ? 'border-accent bg-accent-soft text-ink' : 'border-line text-muted hover:bg-hover')}>
                          {d}
                        </button>
                      )
                    })}
                  </div>
                </FormField>
              ) : <p className="self-end text-sm text-muted">Vence no último dia útil do mês.</p>}
              <p className="self-end text-sm text-muted">
                Sem horário: o prazo vale até o fim do dia de vencimento.
                {t.frequency === 'diaria' && ' Vence no próprio dia.'}
                {t.frequency === 'semanal' && ' Vence no último dia útil da semana.'}
                {t.frequency === 'mensal' && ' Abre no dia 1 e vence no último dia do mês.'}
              </p>
              <FormField label="Peso na eficiência" hint="Atividade com peso 2 conta o dobro nas taxas.">
                <Input type="number" min={0.25} step={0.25} className="max-w-28 tnum" value={t.weight} onChange={(e) => set('weight', Number(e.target.value))} />
              </FormField>
              <FormField label="Meta de quantidade" hint="Opcional. Ex.: 2 produtos.">
                <div className="flex gap-2">
                  <Input type="number" min={1} className="w-24 tnum" value={t.target_qty ?? ''} onChange={(e) => set('target_qty', e.target.value ? Number(e.target.value) : null)} />
                  <Input placeholder="produtos" value={t.target_label ?? ''} onChange={(e) => set('target_label', e.target.value)} />
                </div>
              </FormField>
              {(
                <div className="space-y-3 self-end">
                  <Checkbox label="Faz parte da sequência" hint="Só libera depois que a atividade anterior da sequência (mesmo dia, semana ou mês) for concluída."
                    checked={!!t.sequential} onChange={(v) => set('sequential', v)} />
                  {t.sequential && (
                    <FormField label="Posição na sequência" hint="Menor número vem primeiro. Ex.: 10, 20, 30.">
                      <Input type="number" min={1} step={5} className="max-w-28 tnum" value={t.sort_order}
                        onChange={(e) => set('sort_order', Number(e.target.value))} />
                    </FormField>
                  )}
                </div>
              )}
              <div className="self-end">
                <Checkbox label="Mostrar a curva do dia no card" hint="Usa o mapeamento dia → curva dos Parâmetros."
                  checked={t.shows_curve} onChange={(v) => set('shows_curve', v)} />
              </div>
            </div>
          </Section>

          <Section title="Vigência e situação">
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="flex gap-3">
                <FormField label="Vale de"><Input type="date" value={t.valid_from ?? ''} onChange={(e) => set('valid_from', e.target.value || null)} /></FormField>
                <FormField label="até"><Input type="date" value={t.valid_to ?? ''} onChange={(e) => set('valid_to', e.target.value || null)} /></FormField>
              </div>
              <div className="space-y-3">
                <Checkbox label="Pausada" hint="Não gera tarefas e não entra nas métricas até reativar."
                  checked={t.paused} onChange={(v) => set('paused', v)} />
                {t.paused && <Input placeholder="Motivo (ex.: segurar para a próxima onda)" value={t.pause_reason ?? ''} onChange={(e) => set('pause_reason', e.target.value)} />}
              </div>
            </div>
          </Section>

          <Section title="Atribuição">
            <Segmented<'todos' | 'especificos'> value={t.assign_all ? 'todos' : 'especificos'} onChange={(v) => set('assign_all', v === 'todos')}
              options={[{ value: 'todos', label: 'Todos os analistas' }, { value: 'especificos', label: 'Analistas específicos' }]} />
            {!t.assign_all && (
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {analysts.data.map((a) => (
                  <Checkbox key={a.id} label={a.full_name} checked={assigned.includes(a.id)}
                    onChange={(v) => setAssigned((xs) => v ? [...xs, a.id] : xs.filter((x) => x !== a.id))} />
                ))}
                {!analysts.data.length && <p className="text-sm text-muted">Nenhum analista ativo.</p>}
              </div>
            )}
          </Section>

          <Section title="Campos de registro" meta="o que o analista preenche">
            <FieldsEditor fields={t.fields} onChange={(v) => set('fields', v)} />
          </Section>

          <Section title="Verificações (gates)" meta="a atividade só conclui com todas na resposta esperada">
            <GatesEditor gates={t.gates} onChange={(v) => set('gates', v)} />
          </Section>

          <Section title="Leitura posterior" meta="opcional: registrado depois da conclusão, sem afetar o prazo">
            <FieldsEditor fields={t.followup_fields} onChange={(v) => set('followup_fields', v)} />
          </Section>
        </div>

        {preview && (
          <aside className="xl:sticky xl:top-6 xl:self-start">
            <Preview t={{ ...t, instructions: instructions.split('\n').filter((s) => s.trim()) }} />
          </aside>
        )}
      </div>
    </>
  )
}

function Preview({ t }: { t: ActivityTemplate }) {
  const settings = useSettings()
  const text = useTextContext()
  const curve = t.shows_curve ? settings.curva_por_dia['1'] : null
  const [payload, setPayload] = useState<Payload>(() => initialPayload(t.fields, { curve }))
  useEffect(() => setPayload((p) => ({ ...initialPayload(t.fields, { curve }), ...p })), [t.fields, curve])
  return (
    <div className="rounded border border-line bg-surface">
      <div className="border-b border-line px-4 py-3">
        <p className="font-mono text-xs text-muted">{t.code || 'SEM CÓDIGO'} · prévia</p>
        <p className="font-semibold">{t.name || 'Sem nome'}</p>
        <p className="text-sm text-muted">{[curve && `Curva ${curve}`, t.target_qty ? `Meta de ${t.target_qty} ${t.target_label ?? ''}` : ''].filter(Boolean).join(', ') || 'Pré-visualização do que o analista vê'}</p>
      </div>
      <div className="max-h-[70vh] space-y-6 overflow-y-auto px-4 py-4">
        {t.instructions.length > 0 && (
          <ol className="list-decimal space-y-1 pl-5 text-sm">{t.instructions.map((s, i) => <li key={i}>{renderText(s, text)}</li>)}</ol>
        )}
        <FieldList defs={t.fields} value={payload} onChange={setPayload} ctx={{ text, settings }} />
        {t.gates.map((g) => (
          <div key={g.key} className="flex items-center justify-between gap-3 text-sm">
            <span>{renderText(g.question, text) || 'Pergunta sem texto'}</span>
            <Segmented value={null} onChange={() => {}} options={[{ value: 'sim', label: 'Sim' }, { value: 'nao', label: 'Não' }]} size="sm" />
          </div>
        ))}
      </div>
    </div>
  )
}

const TYPES = Object.keys(FIELD_TYPE_LABEL) as FieldType[]

function move<T>(xs: T[], i: number, d: number): T[] {
  const j = i + d
  if (j < 0 || j >= xs.length) return xs
  const out = [...xs]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

function FieldsEditor({ fields, onChange, nested }: { fields: FieldDef[]; onChange: (v: FieldDef[]) => void; nested?: boolean }) {
  const settingRows = useSettingRows()
  const listSettings = (settingRows.data ?? []).filter((r) => Array.isArray(r.value))
  const upd = (i: number, patch: Partial<FieldDef>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const types = nested ? TYPES.filter((x) => x !== 'group') : TYPES

  return (
    <div className="space-y-3">
      {fields.map((f, i) => (
        <div key={i} className="rounded border border-line">
          <div className="grid gap-3 p-3 sm:grid-cols-[1fr_190px_auto]">
            <div className="space-y-1">
              <Input aria-label="Rótulo do campo" placeholder="Rótulo (ex.: Produtos precificados)" value={f.label}
                onChange={(e) => {
                  const label = e.target.value
                  // Chave acompanha o rótulo enquanto o campo é novo (sem chave definida manualmente).
                  const auto = !f.key || f.key === slugKey(f.label)
                  upd(i, auto ? { label, key: slugKey(label) } : { label })
                }} />
              <div className="flex items-center gap-1 text-xs text-muted">
                chave <input aria-label="Chave" className="w-40 rounded-sm bg-transparent font-mono text-xs text-muted focus:bg-subtle focus:outline-none"
                  value={f.key} onChange={(e) => upd(i, { key: slugKey(e.target.value) })} />
              </div>
            </div>
            <Select aria-label="Tipo" value={f.type} onChange={(e) => {
              const type = e.target.value as FieldType
              upd(i, type === 'group' ? { type, fields: f.fields ?? [], min_items: f.min_items ?? 1, item_label: f.item_label ?? 'Item' } : { type })
            }}>
              {types.map((ty) => <option key={ty} value={ty}>{FIELD_TYPE_LABEL[ty]}</option>)}
            </Select>
            <div className="flex items-start gap-0.5">
              <IconButton label="Subir" onClick={() => onChange(move(fields, i, -1))}><ArrowUp className="size-4" /></IconButton>
              <IconButton label="Descer" onClick={() => onChange(move(fields, i, 1))}><ArrowDown className="size-4" /></IconButton>
              <IconButton label="Remover campo" onClick={() => onChange(fields.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line px-3 py-2.5">
            {f.type !== 'group' && <Checkbox label="Obrigatório" checked={!!f.required} onChange={(v) => upd(i, { required: v })} />}
            {(f.type === 'text' || f.type === 'list') && <Checkbox label="Fonte mono (SKUs)" checked={!!f.mono} onChange={(v) => upd(i, { mono: v })} />}
            {f.type === 'select' && (
              <>
                <Select aria-label="Origem das opções" className="h-8 w-auto text-sm" value={f.options_setting ?? ''}
                  onChange={(e) => upd(i, { options_setting: e.target.value || undefined })}>
                  <option value="">Opções fixas</option>
                  {listSettings.map((r) => <option key={r.key} value={r.key}>Parâmetro: {r.label}</option>)}
                </Select>
                {!f.options_setting && (
                  <Input aria-label="Opções" className="h-8 min-w-60 flex-1 text-sm" placeholder="Opções separadas por vírgula"
                    value={(f.options ?? []).join(', ')}
                    onChange={(e) => upd(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
                )}
              </>
            )}
            {f.type === 'group' && (
              <>
                <label className="flex items-center gap-2 text-sm">Mínimo de itens
                  <Input type="number" min={0} className="h-8 w-16 tnum" value={f.min_items ?? 0} onChange={(e) => upd(i, { min_items: Number(e.target.value) })} />
                </label>
                <Checkbox label="Cada item passa pela aprovação do gestor" hint="O gestor aprova ou reprova cada item de forma independente; o analista vê o retorno."
                  checked={!!f.reviewable} onChange={(v) => upd(i, { reviewable: v })} />
                <label className="flex items-center gap-2 text-sm">Nome do item
                  <Input className="h-8 w-32" value={f.item_label ?? ''} onChange={(e) => upd(i, { item_label: e.target.value })} />
                </label>
              </>
            )}
            {f.type !== 'group' && (
              <Input aria-label="Ajuda" className="h-8 min-w-48 flex-1 text-sm" placeholder="Texto de ajuda (opcional)"
                value={f.help ?? ''} onChange={(e) => upd(i, { help: e.target.value || undefined })} />
            )}
          </div>
          {f.type === 'group' && (
            <div className="border-t border-line bg-subtle/50 p-3">
              <p className="mb-2 text-xs font-medium text-muted">Campos de cada {f.item_label?.toLowerCase() || 'item'}</p>
              <FieldsEditor nested fields={f.fields ?? []} onChange={(v) => upd(i, { fields: v })} />
            </div>
          )}
        </div>
      ))}
      <Button size="sm" variant="ghost" icon={<Plus className="size-4" />}
        onClick={() => onChange([...fields, { key: '', label: '', type: 'text', required: true }])}>
        Adicionar campo
      </Button>
    </div>
  )
}

function GatesEditor({ gates, onChange }: { gates: GateDef[]; onChange: (v: GateDef[]) => void }) {
  const settings = useSettings()
  const upd = (i: number, patch: Partial<GateDef>) => onChange(gates.map((g, j) => (j === i ? { ...g, ...patch } : g)))
  return (
    <div className="space-y-3">
      {gates.map((g, i) => (
        <div key={i} className="flex flex-wrap items-start gap-3 rounded border border-line p-3">
          <div className="min-w-60 flex-1 space-y-1">
            <Input aria-label="Pergunta" placeholder="Há algum item com venda abaixo de {limite_venda}%?" value={g.question}
              onChange={(e) => upd(i, { question: e.target.value, key: g.key || slugKey(e.target.value).slice(0, 24) })} />
            <p className="text-xs text-muted">
              Parâmetros disponíveis: {Object.keys(settings.gate_params).map((k) => <code key={k} className="mr-1 font-mono">{`{${k}}`}</code>)}
              <code className="font-mono">{'{concorrente}'}</code>
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            Esperado
            <Segmented value={g.expected} onChange={(v) => upd(i, { expected: v })} size="sm"
              options={[{ value: 'nao', label: 'Não' }, { value: 'sim', label: 'Sim' }]} />
          </div>
          <IconButton label="Remover verificação" onClick={() => onChange(gates.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
        </div>
      ))}
      <Button size="sm" variant="ghost" icon={<Plus className="size-4" />}
        onClick={() => onChange([...gates, { key: `gate_${gates.length + 1}`, question: '', expected: 'nao' }])}>
        Adicionar verificação
      </Button>
    </div>
  )
}
