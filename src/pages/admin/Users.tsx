import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { KeyRound, UserPlus } from 'lucide-react'
import {
  Button, Checkbox, cx, Dialog, ErrorNote, FormField, Input, PageHeader, Segmented, Skeleton, table,
} from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/auth/AuthProvider'
import { useAssignments, useProfiles, useTemplates } from '@/data/queries'
import { fmtDay, localDate } from '@/lib/dates'
import { errorMessage } from '@/lib/status'
import { supabase } from '@/lib/supabase'
import type { Profile, Role } from '@/lib/types'

const ROLE_LABEL: Record<Role, string> = { analista: 'Analista', admin: 'Gestor' }

/**
 * Logins e papéis. O papel é a coluna profiles.role (user_role) no banco:
 * pode ser trocado aqui ou direto na tabela; o login acompanha sozinho.
 */
export default function Users() {
  const profiles = useProfiles()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Profile | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const list = (profiles.data ?? []).filter((p) => showInactive || p.active)

  return (
    <>
      <PageHeader
        title="Usuários e acessos"
        meta="Crie os logins e defina o papel de cada pessoa. Desativar bloqueia o login e preserva todo o histórico."
        actions={<Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setCreating(true)}>Novo usuário</Button>}
      >
        <Checkbox label="Mostrar inativos" checked={showInactive} onChange={setShowInactive} />
      </PageHeader>
      <ErrorNote error={profiles.error} />
      {profiles.isLoading ? <Skeleton className="h-48" /> : (
        <div className={table.wrap}>
          <table className={cx(table.table, 'min-w-[640px]')}>
            <thead>
              <tr>
                <th className={table.th}>Nome</th>
                <th className={table.th}>E-mail (login)</th>
                <th className={table.th}>Papel</th>
                <th className={table.th}>Situação</th>
                <th className={table.th}>Desde</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} tabIndex={0} className={table.trClick} onClick={() => setEditing(p)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setEditing(p) }}>
                  <td className={cx(table.td, 'font-medium', !p.active && 'text-muted')}>{p.full_name}</td>
                  <td className={cx(table.td, 'text-muted')}>{p.email}</td>
                  <td className={table.td}>{ROLE_LABEL[p.role]}</td>
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
      {editing && <EditDialog profile={editing} onClose={() => setEditing(null)} />}
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
  const templates = useTemplates()
  const assignments = useAssignments()
  const [name, setName] = useState(profile.full_name)
  const [role, setRole] = useState<Role>(profile.role)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const self = me?.id === profile.id
  const specific = (templates.data ?? []).filter((t) => !t.assign_all)
  const mine = new Set((assignments.data ?? []).filter((a) => a.user_id === profile.id).map((a) => a.template_id))

  async function run(label: string, fn: () => PromiseLike<{ error: unknown }>, ok: string) {
    setBusy(label); setError(null)
    const { error } = await fn()
    setBusy(null)
    if (error) { setError(errorMessage(error)); return false }
    await qc.invalidateQueries({ queryKey: ['profiles'] })
    await qc.invalidateQueries({ queryKey: ['assignments'] })
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

        {profile.role === 'analista' && specific.length > 0 && (
          <FormField label="Atividades com atribuição específica" hint="As demais valem para todos os analistas.">
            <div className="space-y-2">
              {specific.map((t) => (
                <Checkbox key={t.id} label={`${t.code ? t.code + ' · ' : ''}${t.name}`} checked={mine.has(t.id)} disabled={busy !== null}
                  onChange={(v) => void run('atribuir',
                    () => v ? supabase.from('template_assignments').insert({ template_id: t.id, user_id: profile.id })
                      : supabase.from('template_assignments').delete().eq('template_id', t.id).eq('user_id', profile.id),
                    v ? 'Atividade atribuída.' : 'Atribuição removida.')} />
              ))}
            </div>
          </FormField>
        )}

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
                  profile.active ? 'Usuário desativado. O histórico foi mantido.' : 'Usuário reativado.')) onClose()
              }}>
              {profile.active ? 'Desativar login' : 'Reativar login'}
            </Button>
          )}
          {profile.active && !self && <p className="text-xs text-muted">Ao desativar, o login fica bloqueado e as tarefas futuras saem do cálculo; as passadas continuam nas métricas.</p>}
        </div>
      </div>
    </Dialog>
  )
}
