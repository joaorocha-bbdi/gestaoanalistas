import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { Profile } from '@/lib/types'

interface AuthState {
  session: Session | null
  profile: Profile | null
  loading: boolean
  /** Chegou por link de convite/recuperação: precisa definir senha. */
  recovery: boolean
  clearRecovery: () => void
  signOut: () => Promise<void>
  reloadProfile: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

// O perfil fica guardado no navegador para a tela abrir sem esperar o servidor.
// É só para exibir: quem decide o acesso é o banco (RLS), sempre.
const PROFILE_KEY = 'rotina-profile'
const CACHE_KEY = 'rotina-cache'

function readCachedProfile(): Profile | null {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null') as Profile | null } catch { return null }
}
function writeCachedProfile(p: Profile | null) {
  try { if (p) localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); else localStorage.removeItem(PROFILE_KEY) } catch { /* sem armazenamento */ }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [recovery, setRecovery] = useState(
    () => /type=(invite|recovery)/.test(window.location.hash) || /type=(invite|recovery)/.test(window.location.search),
  )

  /** Dados guardados de outro usuário nunca aparecem para quem entrou agora. */
  function forgetCachedData() {
    qc.clear()
    writeCachedProfile(null)
    try { localStorage.removeItem(CACHE_KEY) } catch { /* sem armazenamento */ }
  }

  async function loadProfile(s: Session | null) {
    if (!s) { setProfile(null); return }
    const { data } = await supabase.from('profiles').select('*').eq('id', s.user.id).maybeSingle()
    const p = (data as Profile) ?? null
    setProfile(p)
    writeCachedProfile(p)
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      const s = data.session
      setSession(s)
      const cached = readCachedProfile()
      if (s && cached?.id === s.user.id) {
        // Abre na hora com o perfil guardado e confirma em segundo plano.
        setProfile(cached)
        setLoading(false)
        void loadProfile(s)
      } else {
        if (cached && cached.id !== s?.user.id) forgetCachedData()
        await loadProfile(s)
        setLoading(false)
      }
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true)
      if (event === 'SIGNED_IN' && readCachedProfile()?.id && readCachedProfile()?.id !== s?.user.id) forgetCachedData()
      setSession(s)
      // Evita chamar o Supabase dentro do callback (deadlock conhecido do auth-js).
      setTimeout(() => { void loadProfile(s) }, 0)
    })
    return () => sub.subscription.unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value: AuthState = {
    session, profile, loading, recovery,
    clearRecovery: () => setRecovery(false),
    signOut: async () => { await supabase.auth.signOut(); forgetCachedData(); setProfile(null) },
    reloadProfile: () => loadProfile(session),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAuth fora do AuthProvider')
  return c
}

export const useIsAdmin = () => useAuth().profile?.role === 'admin'
