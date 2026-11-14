import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { Button, ErrorNote, FormField, Input } from '@/components/ui'
import { Logo } from '@/components/layout/AppShell'
import { errorMessage } from '@/lib/status'
import { appUrl, hasSupabaseConfig, supabase } from '@/lib/supabase'

function AuthFrame({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2"><Logo /><span className="font-semibold">Rotina</span></div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  )
}

export function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) setError(errorMessage(error))
    setBusy(false)
  }

  return (
    <AuthFrame title="Entrar" subtitle="Acompanhamento da rotina diária da equipe.">
      {!hasSupabaseConfig && (
        <div className="mb-4"><ErrorNote error="Configuração ausente: defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no .env.local (veja o README)." /></div>
      )}
      <form onSubmit={submit} className="space-y-4">
        <ErrorNote error={error} />
        <FormField label="E-mail" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
        </FormField>
        <FormField label="Senha" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </FormField>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>Entrar</Button>
      </form>
      <p className="mt-6 text-sm text-muted">
        <Link to="/esqueci-senha" className="hover:text-ink hover:underline">Esqueci a senha</Link>
        <span className="mx-2">·</span>Sem acesso? Peça um convite ao gestor.
      </p>
    </AuthFrame>
  )
}

export function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: appUrl('/definir-senha') })
    if (error) setError(errorMessage(error))
    else setSent(true)
    setBusy(false)
  }

  return (
    <AuthFrame title="Redefinir senha" subtitle="Enviamos um link para o seu e-mail.">
      {sent ? (
        <p className="text-sm">Se <span className="font-medium">{email}</span> tiver cadastro, o link chega em alguns minutos. Confira também o spam.</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <ErrorNote error={error} />
          <FormField label="E-mail" htmlFor="email">
            <Input id="email" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </FormField>
          <Button type="submit" variant="primary" className="w-full" loading={busy}>Enviar link</Button>
        </form>
      )}
      <p className="mt-6 text-sm"><Link to="/entrar" className="text-muted hover:text-ink hover:underline">Voltar para o login</Link></p>
    </AuthFrame>
  )
}

export function SetPassword() {
  const { session, loading, clearRecovery } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (password.length < 8) { setError('Use pelo menos 8 caracteres.'); return }
    if (password !== confirm) { setError('As senhas não conferem.'); return }
    setBusy(true); setError(null)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) { setError(errorMessage(error)); return }
    clearRecovery()
    navigate('/', { replace: true })
  }

  if (loading) return null
  if (!session) {
    return (
      <AuthFrame title="Link expirado ou inválido" subtitle="Peça um novo link ao gestor ou use “Esqueci a senha”.">
        <Link to="/esqueci-senha" className="text-sm text-accent hover:underline">Pedir novo link</Link>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame title="Defina sua senha" subtitle={session.user.email}>
      <form onSubmit={submit} className="space-y-4">
        <ErrorNote error={error} />
        <FormField label="Nova senha" htmlFor="pw" hint="Mínimo de 8 caracteres.">
          <Input id="pw" type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </FormField>
        <FormField label="Repita a senha" htmlFor="pw2">
          <Input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </FormField>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>Salvar e entrar</Button>
      </form>
    </AuthFrame>
  )
}
