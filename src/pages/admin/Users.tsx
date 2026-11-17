import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { KeyRound, UserPlus } from 'lucide-react'
import {
  Button, Checkbox, cx, Dialog, ErrorNote, FormField, Input, PageHeader, Segmented, Skeleton, table,
} from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/auth/AuthProvider'
import { useAssignments, useExclusions, useProfiles, useTemplates } from '@/data/queries'
import { DaysOffEditor } from '@/features/daysoff/DaysOff'
import { FREQ_LABEL } from '@/features/tasks/taskText'
import { fmtDay, localDate } from '@/lib/dates'
import { errorMessage } from '@/lib/status'
import { supabase } from '@/lib/supabase'
import type { ActivityTemplate, Frequency, Profile, Role } from '@/lib/types'

const ROLE_LABEL: Record<Role, string> = { analista: 'Analista', admin: 'Gestor' }
const FREQS: Frequency[] = ['diaria', 'semanal', 'mensal']
const FREQ_PLURAL: Record<Frequency, string> = { diaria: 'diárias', semanal: 'semanais', mensal: 'mensais' }

type Pair = { template_id: string; user_id: string }
type Run = (label: string, fn: () => PromiseLike<{ error: unknown }>, ok: string) => Promise<boolean>

const freqsOf = (p: Profile) => p.frequencies ?? FREQS
const assigned = (t: ActivityTemplate, p: Profile, assignments: Pair[]) =>
  t.assign_all || assignments.some((a) => a.template_id === t.id && a.user_id === p.id)

/** O modelo aparece para o analista? Mesma regra de public.template_applies no banco. */
function applies(t: ActivityTemplate, p: Profile, assignments: Pair[], exclusions: Pair[]) {
  if (!freqsOf(p).includes(t.frequency)) return false
  if (exclusions.some((e) => e.template_id === t.id && e.user_id === p.id)) return false
  return assigned(t, p, assignments)
}

/** Resumo para a tabela: "Todas", "Só diárias", "Diárias e semanais · 1 oculta". */
function visibilitySummary(p: Profile, templates: ActivityTemplate[], assignments: Pair[], exclusions: Pair[]) {
  const freqs = FREQS.filter((f) => freqsOf(p).includes(f))
  if (freqs.length === 0) return 'Nenhuma'
  const hidden = templates.filter((t) => freqs.includes(t.frequency) && assigned(t, p, assignments)
    && !applies(t, p, assignments, exclusions)).length
  const words = freqs.map((f) => FREQ_PLURAL[f])
  const base = freqs.length === FREQS.length ? 'Todas'
    : freqs.length === 1 ? `Só ${words[0]}`
    : words.join(' e ').replace(/^./, (c) => c.toUpperCase())
  return hidden ? `${base} · ${hidden} oculta${hidden === 1 ? '' : 's'}` : base
}

/**
 * Logins e papéis. O papel é a coluna profiles.role (user_role) no banco:
 * pode ser trocado aqui ou direto na tabela; o login acompanha sozinho.
 */
export default function Users() {
  const profiles = useProfiles()
  const templates = useTemplates()
  const assignments = useAssignments()
  const exclusions = useExclusions()
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const list = (profiles.data ?? []).filter((p) => showInactive || p.active)
  const editing = profiles.data?.find((p) => p.id === editingId) ?? null

  return (
    <>
      <PageHeader
        title="Usuários e acessos"
        meta="Crie os logins, defina o papel de cada pessoa e quais atividades aparecem para cada analista. Desativar bloqueia o login e tira a pessoa das métricas, guardando os registros."
        actions={<Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setCreating(true)}>Novo usuário</Button>}
      >
        <Checkbox label="Mostrar inativos" checked={showInactive} onChange={setShowInactive} />
      </PageHeader>
      <ErrorNote error={profiles.error} />
      {profiles.isLoading ? <Skeleton className="h-48" /> : (
        <div className={table.wrap}>
          <table className={cx(table.table, 'min-w-[760px]')}>
            <thead>
              <tr>
                <th className={table.th}>Nome</th>
                <th className={table.th}>E-mail (login)</th>
                <th className={table.th}>Papel</th>
                <th className={table.th}>Atividades</th>
                <th className={table.th}>Situação</th>
                <th className={table.th}>Desde</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} tabIndex={0} className={table.trClick} onClick={() => setEditingId(p.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setEditingId(p.id) }}>
                  <td className={cx(table.td, 'font-medium', !p.active && 'text-muted')}>{p.full_name}</td>
                  <td className={cx(table.td, 'text-muted')}>{p.email}</td>
                  <td className={table.td}>{ROLE_LABEL[p.role]}</td>
                  <td className={cx(table.td, 'text-sm', p.role !== 'analista' && 'text-faint')}>
                    {p.role === 'analista'
                      ? visibilitySummary(p, templates.data ?? [], assignments.data ?? [], exclusions.data ?? [])
                      : '—'}
                  </td>
                  <td className={table.td}>
                    <span className="inline-flex items-center gap-1.5 text-sm">
                      <span className={cx('size-1.5 rounded-full', p.active ? 'bg-ok' : 'bg-faint')} aria-hidden />
                      {p.active ? 'Ativo' : 'Inativo'}
                    </span>
                  </td>
                  <td className={cx(table.td, 'text-muted tnum')}>{fmtDay(localDate(p.created_at))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CreateDialog open={creating} onClose={() => setCreating(false)} />
      {editing && <EditDialog key={editing.id} profile={editing} onClose={() => setEditingId(null)} />}
    </>
  )
}

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('analista')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = name.trim() && /\S+@\S+\.\S+/.test(email) && password.length >= 8

  async function create() {
    setBusy(true); setError(null)
    const { error } = await supabase.rpc('admin_create_user', {
      p_email: email.trim(), p_full_name: name.trim(), p_role: role, p_password: password,
    })
    setBusy(false)
    if (error) { setError(errorMessage(error)); return }
    await qc.invalidateQueries({ queryKey: ['profiles'] })
    toast(`Login criado para ${email.trim()}. Passe a senha inicial para a pessoa.`)
    setName(''); setEmail(''); setPassword(''); setRole('analista')
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} title="Novo usuário"
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" icon={<UserPlus className="size-4" />} loading={busy} disabled={!valid} onClick={create}>Criar login</Button></>}>
      <div className="space-y-4">
        <ErrorNote error={error} />
        <FormField label="Nome completo" required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></FormField>
        <FormField label="E-mail (login)" required><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></FormField>
        <FormField label="Senha inicial" required hint="Mínimo de 8 caracteres. A pessoa pode trocar depois, em “Esqueci a senha”.">
          <Input type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </FormField>
        <FormField label="Papel">
          <Segmented<Role> value={role} onChange={setRole} options={[{ value: 'analista', label: 'Analista' }, { value: 'admin', label: 'Gestor' }]} />
        </FormField>
      </div>
    </Dialog>
  )
}

function EditDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { profile: me } = useAuth()
  const [name, setName] = useState(profile.full_name)
  const [role, setRole] = useState<Role>(profile.role)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const self = me?.id === profile.id

  const run: Run = async (label, fn, ok) => {
    setBusy(label); setError(null)
    const { error } = await fn()
    if (error) { setBusy(null); setError(errorMessage(error)); return false }
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['profiles'] }),
      qc.invalidateQueries({ queryKey: ['assignments'] }),
      qc.invalidateQueries({ queryKey: ['exclusions'] }),
    ])
    setBusy(null)
    toast(ok)
    return true
  }

  const saveProfile = async () => {
    const ok = await run('salvar', () => supabase.from('profiles').update({ full_name: name.trim(), role }).eq('id', profile.id),
      role !== profile.role ? `Papel alterado para ${ROLE_LABEL[role]}.` : 'Perfil atualizado.')
    if (ok) onClose()
  }

  return (
    <Dialog open onClose={onClose} title={profile.full_name}
      footer={<><Button variant="ghost" onClick={onClose}>Fechar</Button>
        <Button variant="primary" loading={busy === 'salvar'} onClick={saveProfile}
          disabled={!name.trim() || (name.trim() === profile.full_name && role === profile.role)}>Salvar</Button></>}>
      <div className="space-y-5">
        <ErrorNote error={error} />
        <FormField label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} /></FormField>
        <FormField label="Papel" hint={self ? 'Você não pode mudar o próprio papel.' : 'Também pode ser alterado direto no banco: tabela profiles, coluna role.'}>
          <Segmented<Role> value={role} onChange={setRole} disabled={self}
            options={[{ value: 'analista', label: 'Analista' }, { value: 'admin', label: 'Gestor' }]} />
        </FormField>

        {profile.role === 'analista' && <VisibilityEditor profile={profile} busy={busy !== null} run={run} />}
        {profile.role === 'analista' && profile.active && <DaysOffEditor profile={profile} busy={busy !== null} />}

        <div className="space-y-3 border-t border-line pt-4">
          <p className="text-sm font-medium">Acesso</p>
          <div className="flex flex-wrap items-end gap-2">
            <FormField label="Nova senha" hint="Mínimo de 8 caracteres." className="min-w-48 flex-1">
              <Input type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
            </FormField>
            <Button icon={<KeyRound className="size-4" />} loading={busy === 'senha'} disabled={password.length < 8}
              onClick={async () => {
                if (await run('senha', () => supabase.rpc('admin_set_password', { p_user: profile.id, p_password: password }),
                  `Senha de ${profile.full_name} redefinida.`)) setPassword('')
              }}>Definir senha</Button>
          </div>
          {!self && (
            <Button size="sm" variant={profile.active ? 'danger' : 'secondary'} loading={busy === 'ativo'}
              onClick={async () => {
                if (await run('ativo', () => supabase.from('profiles').update({ active: !profile.active }).eq('id', profile.id),
                  profile.active ? 'Usuário desativado e fora das métricas. Os registros foram guardados.' : 'Usuário reativado. O histórico volta a contar.')) onClose()
              }}>
              {profile.active ? 'Desativar login' : 'Reativar login'}
            </Button>
          )}
          {profile.active && !self && <p className="text-xs text-muted">Ao desativar, o login fica bloqueado e a pessoa sai de todas as métricas, inclusive do histórico. Os registros ficam guardados: se for reativada, tudo volta a contar.</p>}
        </div>
      </div>
    </Dialog>
  )
}

/**
 * O que aparece para o analista: liga e desliga frequências inteiras
 * (ex.: só as diárias) e, dentro delas, cada atividade.
 * Atividade "para todos" desmarcada vira exclusão; a de atribuição específica, atribuição.
 */
function VisibilityEditor({ profile, busy, run }: { profile: Profile; busy: boolean; run: Run }) {
  const templates = useTemplates()
  const assignments = useAssignments()
  const exclusions = useExclusions()
  const freqs = freqsOf(profile)
  const all = templates.data ?? []
  const asg = assignments.data ?? []
  const exc = exclusions.data ?? []

  const setFreqs = (next: Frequency[]) => run('frequencia',
    () => supabase.from('profiles').update({ frequencies: FREQS.filter((f) => next.includes(f)) }).eq('id', profile.id),
    next.length === 0 ? 'Nenhuma atividade vai aparecer para este analista.' : 'Frequências atualizadas.')

  const toggle = (t: ActivityTemplate, on: boolean) => {
    const excluded = exc.some((e) => e.template_id === t.id && e.user_id === profile.id)
    return run('atividade', () => {
      // Religar: tira a exclusão (se houver) e, se for específica, atribui.
      if (on) {
        if (excluded) return supabase.from('template_exclusions').delete().eq('template_id', t.id).eq('user_id', profile.id)
        return supabase.from('template_assignments').insert({ template_id: t.id, user_id: profile.id })
      }
      return t.assign_all
        ? supabase.from('template_exclusions').insert({ template_id: t.id, user_id: profile.id })
        : supabase.from('template_assignments').delete().eq('template_id', t.id).eq('user_id', profile.id)
    }, on ? `${t.name} volta a aparecer.` : `${t.name} não aparece mais para ${profile.full_name}.`)
  }

  const presets: { label: string; value: Frequency[] }[] = [
    { label: 'Todas', value: FREQS },
    { label: 'Só diárias', value: ['diaria'] },
    { label: 'Só semanais', value: ['semanal'] },
    { label: 'Só mensais', value: ['mensal'] },
  ]
  const same = (a: Frequency[], b: Frequency[]) => a.length === b.length && a.every((x) => b.includes(x))

  return (
    <div className="space-y-4 border-t border-line pt-4">
      <div>
        <p className="text-sm font-medium">Atividades que aparecem</p>
        <p className="text-sm text-muted">Vale de hoje em diante. Tarefas já começadas ficam pausadas e voltam se a atividade for religada.</p>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Atalhos de frequência">
        {presets.map((p) => {
          const active = same(freqs, p.value)
          return (
            <button key={p.label} type="button" disabled={busy || active} aria-pressed={active}
              onClick={() => void setFreqs(p.value)}
              className={cx('h-8 rounded border px-3 text-sm transition-colors',
                active ? 'border-ink bg-ink font-medium text-surface' : 'border-line-strong text-muted hover:bg-hover hover:text-ink',
                busy && !active && 'opacity-60')}>
              {p.label}
            </button>
          )
        })}
      </div>

      {templates.isLoading || assignments.isLoading || exclusions.isLoading ? <Skeleton className="h-32" /> : (
        <div className="space-y-3">
          {FREQS.map((f) => {
            const on = freqs.includes(f)
            const list = all.filter((t) => t.frequency === f)
            return (
              <fieldset key={f} className="overflow-hidden rounded border border-line">
                <legend className="sr-only">{FREQ_LABEL[f]}</legend>
                <div className="flex items-center justify-between gap-2 border-b border-line bg-subtle/60 px-3 py-2">
                  <Checkbox label={<span className="font-medium capitalize">{FREQ_PLURAL[f]}</span>} checked={on} disabled={busy}
                    onChange={(v) => void setFreqs(v ? [...freqs, f] : freqs.filter((x) => x !== f))} />
                  <span className="text-xs text-muted tnum">
                    {on ? `${list.filter((t) => applies(t, profile, asg, exc)).length} de ${list.length}` : 'desligadas'}
                  </span>
                </div>
                {list.length === 0
                  ? <p className="px-3 py-2 text-sm text-faint">Nenhuma atividade {FREQ_LABEL[f].toLowerCase()} cadastrada.</p>
                  : (
                    <div className={cx('space-y-2 px-3 py-2.5', !on && 'opacity-50')}>
                      {list.map((t) => (
                        <Checkbox key={t.id}
                          label={`${t.code ? t.code + ' · ' : ''}${t.name}`}
                          hint={[!t.assign_all && 'atribuição específica', t.paused && 'modelo pausado'].filter(Boolean).join(' · ') || undefined}
                          checked={on && applies(t, profile, asg, exc)}
                          disabled={busy || !on}
                          onChange={(v) => void toggle(t, v)} />
                      ))}
                    </div>
                  )}
              </fieldset>
            )
          })}
        </div>
      )}
    </div>
  )
}
