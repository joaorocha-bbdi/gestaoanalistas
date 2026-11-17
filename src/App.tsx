import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { AppShell } from '@/components/layout/AppShell'
import { ErrorNote, Spinner } from '@/components/ui'
import { ForgotPassword, Login, SetPassword } from '@/pages/auth/AuthPages'
import Today from '@/pages/analyst/Today'
import {
  AnalystDetail, Audit, Daily, Export, History, Links, Overview, Performance, Review, Settings, Team, TemplateEditor, Templates,
  TestApprovals, Tests, Users, Week,
} from '@/pages/lazy'

// "Hoje" (tela inicial do analista) vai no pacote principal; as demais são
// carregadas sob demanda (ver pages/lazy.ts). O Suspense fica no AppShell,
// para o menu continuar na tela enquanto a página chega.

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, profile, loading, recovery, signOut } = useAuth()
  const location = useLocation()
  if (loading) return <div className="p-8"><Spinner /></div>
  if (!session) return <Navigate to="/entrar" replace state={{ from: location }} />
  if (recovery) return <Navigate to="/definir-senha" replace />
  if (!profile) return <div className="p-8"><Spinner label="Carregando perfil" /></div>
  if (!profile.active) {
    return (
      <div className="mx-auto max-w-sm p-8">
        <ErrorNote error="Seu acesso está desativado. Fale com o gestor." />
        <button className="mt-4 text-sm text-muted hover:underline" onClick={() => void signOut()}>Sair</button>
      </div>
    )
  }
  return <>{children}</>
}

/** A interface também esconde, mas quem garante é o RLS no banco. */
function RequireRole({ role, children }: { role: 'admin' | 'analista'; children: ReactNode }) {
  const { profile } = useAuth()
  if (profile?.role !== role) return <Navigate to="/" replace />
  return <>{children}</>
}

function Home() {
  const { profile } = useAuth()
  return <Navigate to={profile?.role === 'admin' ? '/admin' : '/hoje'} replace />
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { session, loading, recovery } = useAuth()
  if (loading) return null
  if (session && !recovery) return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  const a = (el: ReactNode) => <RequireRole role="admin">{el}</RequireRole>
  const n = (el: ReactNode) => <RequireRole role="analista">{el}</RequireRole>
  return (
    <BrowserRouter basename={base || '/'}>
      <Routes>
        <Route path="/entrar" element={<PublicOnly><Login /></PublicOnly>} />
        <Route path="/esqueci-senha" element={<PublicOnly><ForgotPassword /></PublicOnly>} />
        <Route path="/definir-senha" element={<SetPassword />} />
        <Route element={<RequireAuth><AppShell /></RequireAuth>}>
          <Route index element={<Home />} />
          <Route path="hoje" element={n(<Today />)} />
          <Route path="semana" element={n(<Week />)} />
          <Route path="historico" element={n(<History />)} />
          <Route path="desempenho" element={n(<Performance />)} />
          <Route path="testes" element={n(<Tests />)} />
          <Route path="links" element={<Links />} />
          <Route path="admin" element={a(<Overview />)} />
          <Route path="admin/diario" element={a(<Daily />)} />
          <Route path="admin/equipe" element={a(<Team />)} />
          <Route path="admin/equipe/:id" element={a(<AnalystDetail />)} />
          <Route path="admin/revisao" element={a(<Review />)} />
          <Route path="admin/testes" element={a(<TestApprovals />)} />
          <Route path="admin/modelos" element={a(<Templates />)} />
          <Route path="admin/modelos/:id" element={a(<TemplateEditor />)} />
          <Route path="admin/usuarios" element={a(<Users />)} />
          <Route path="admin/parametros" element={a(<Settings />)} />
          <Route path="admin/auditoria" element={a(<Audit />)} />
          <Route path="admin/exportar" element={a(<Export />)} />
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
