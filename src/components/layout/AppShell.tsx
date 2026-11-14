import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity, CalendarCheck2, CalendarRange, Download, FlaskConical, History, Layers, Link2, LayoutDashboard, LogOut, Menu, Monitor, Moon,
  ScrollText, ShieldCheck, SlidersHorizontal, Sun, UserCog, Users, X,
} from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { useHotkeys, useTheme, type Theme } from '@/lib/hooks'
import { cx, Dialog, IconButton, Kbd } from '@/components/ui'
import { useRefreshTasks } from '@/data/queries'

interface NavItem { to: string; label: string; icon: typeof Activity; key?: string }

const ANALYST_NAV: NavItem[] = [
  { to: '/hoje', label: 'Hoje', icon: CalendarCheck2, key: '1' },
  { to: '/semana', label: 'Minha semana', icon: CalendarRange, key: '2' },
  { to: '/historico', label: 'Histórico', icon: History, key: '3' },
  { to: '/desempenho', label: 'Desempenho', icon: Activity, key: '4' },
  { to: '/testes', label: 'Testes', icon: FlaskConical, key: '5' },
  { to: '/links', label: 'Links', icon: Link2, key: '6' },
]

const ADMIN_NAV: NavItem[] = [
  { to: '/admin', label: 'Visão geral', icon: LayoutDashboard, key: '1' },
  { to: '/admin/equipe', label: 'Equipe', icon: Users, key: '2' },
  { to: '/admin/revisao', label: 'Revisão', icon: ShieldCheck, key: '3' },
  { to: '/admin/testes', label: 'Aprovação de testes', icon: FlaskConical, key: '4' },
  { to: '/admin/modelos', label: 'Modelos de atividade', icon: Layers, key: '5' },
  { to: '/admin/usuarios', label: 'Usuários e acessos', icon: UserCog, key: '6' },
  { to: '/admin/parametros', label: 'Parâmetros', icon: SlidersHorizontal, key: '7' },
  { to: '/admin/auditoria', label: 'Auditoria', icon: ScrollText, key: '8' },
  { to: '/admin/exportar', label: 'Exportar', icon: Download, key: '9' },
  { to: '/links', label: 'Links', icon: Link2, key: '0' },
]

export function AppShell() {
  const { profile, signOut } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const nav = isAdmin ? ADMIN_NAV : ANALYST_NAV
  const [menuOpen, setMenuOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  useRefreshTasks()

  useEffect(() => setMenuOpen(false), [location.pathname])

  useGoHotkeys(nav, navigate)
  useHotkeys({ '?': () => setHelpOpen(true) })

  const sidebar = (
    <nav aria-label="Principal" className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2.5 px-5">
        <Logo />
        <span className="font-display text-xl font-semibold">Rotina</span>
        <span className="ml-auto text-xs text-rail-ink/60">{isAdmin ? 'Gestor' : 'Analista'}</span>
      </div>
      <ul className="flex-1 space-y-0.5 px-3 py-3">
        {nav.map((n) => (
          <li key={n.to}>
            <NavLink
              to={n.to}
              end={n.to === '/admin'}
              className={({ isActive }) => cx(
                'group relative flex h-9 items-center gap-2.5 rounded px-3 text-base',
                isActive ? 'bg-white/10 font-medium text-rail-ink' : 'text-rail-ink/65 hover:bg-white/5 hover:text-rail-ink',
              )}
            >
              {({ isActive }) => (
                <>
                  {isActive && <span className="absolute inset-y-1.5 left-0 w-1 rounded-r bg-rail-accent" aria-hidden />}
                  <n.icon className={cx('size-4', isActive ? 'text-rail-accent' : 'text-rail-ink/50 group-hover:text-rail-ink/80')} strokeWidth={1.75} aria-hidden />
                  <span className="flex-1 truncate">{n.label}</span>
                  {n.key && <span className="hidden text-xs text-rail-ink/45 group-hover:inline">g {n.key}</span>}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="space-y-3 border-t border-white/10 p-4">
        <ThemeSwitch />
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{profile?.full_name}</p>
            <p className="truncate text-xs text-rail-ink/55">{profile?.email}</p>
          </div>
          <IconButton label="Sair" className="text-rail-ink/60 hover:bg-white/10 hover:text-rail-ink" onClick={() => void signOut()}><LogOut className="size-4" /></IconButton>
        </div>
        <button onClick={() => setHelpOpen(true)} className="flex w-full items-center gap-2 text-xs text-rail-ink/55 hover:text-rail-ink">
          <Kbd className="border-white/20 bg-transparent text-rail-ink/70">?</Kbd> Atalhos de teclado
        </button>
      </div>
    </nav>
  )

  return (
    <div className="min-h-dvh lg:pl-60">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 bg-rail text-rail-ink lg:block">{sidebar}</aside>

      {/* Barra superior no celular */}
      <div className="sticky top-0 z-20 flex h-12 items-center gap-2 bg-rail px-2 text-rail-ink lg:hidden">
        <IconButton label="Abrir menu" className="text-rail-ink hover:bg-white/10" onClick={() => setMenuOpen(true)}><Menu className="size-5" /></IconButton>
        <Logo />
        <span className="font-display text-lg font-semibold">Rotina</span>
      </div>
      {menuOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMenuOpen(false)} aria-hidden />
          <div className="relative max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-lg bg-rail text-rail-ink shadow-pop">
            <IconButton label="Fechar menu" className="absolute right-2 top-3.5 text-rail-ink/70 hover:bg-white/10" onClick={() => setMenuOpen(false)}><X className="size-4" /></IconButton>
            {sidebar}
          </div>
        </div>
      )}

      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
        <Outlet />
      </main>

      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} title="Atalhos de teclado">
        <ShortcutList items={[
          ...nav.filter((n) => n.key).map((n) => [`g ${n.key}`, `Ir para ${n.label}`] as [string, string]),
          ['j / k', 'Próximo / anterior na lista'],
          ['Enter', 'Abrir item selecionado'],
          ['Ctrl + Enter', 'Enviar a atividade aberta'],
          ['Ctrl + S', 'Salvar rascunho'],
          ...(isAdmin ? [['v', 'Validar (na revisão)'], ['c', 'Contestar (na revisão)']] as [string, string][] : []),
          ['Esc', 'Fechar painel'],
        ]} />
      </Dialog>
    </div>
  )
}

/** "g" seguido de número navega entre seções. */
function useGoHotkeys(nav: NavItem[], navigate: (to: string) => void) {
  useEffect(() => {
    let armed = 0
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'g') { armed = Date.now(); return }
      if (armed && Date.now() - armed < 1200) {
        const item = nav.find((n) => n.key === e.key)
        armed = 0
        if (item) { e.preventDefault(); navigate(item.to) }
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [nav, navigate])
}

function ShortcutList({ items }: { items: [string, string][] }) {
  return (
    <dl className="divide-y divide-line">
      {items.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between py-2">
          <dt className="text-sm text-muted">{v}</dt>
          <dd className="font-mono text-xs">{k}</dd>
        </div>
      ))}
    </dl>
  )
}

function ThemeSwitch() {
  const [theme, setTheme] = useTheme()
  const opts: { v: Theme; icon: ReactNode; label: string }[] = [
    { v: 'claro', icon: <Sun className="size-3.5" />, label: 'Tema claro' },
    { v: 'escuro', icon: <Moon className="size-3.5" />, label: 'Tema escuro' },
    { v: 'sistema', icon: <Monitor className="size-3.5" />, label: 'Seguir o sistema' },
  ]
  return (
    <div role="radiogroup" aria-label="Tema" className="flex rounded border border-white/15 p-0.5">
      {opts.map((o) => (
        <button
          key={o.v}
          role="radio"
          aria-checked={theme === o.v}
          title={o.label}
          aria-label={o.label}
          onClick={() => setTheme(o.v)}
          className={cx('flex h-7 flex-1 items-center justify-center rounded-sm',
            theme === o.v ? 'bg-signal text-signal-ink' : 'text-rail-ink/55 hover:text-rail-ink')}
        >
          {o.icon}
        </button>
      ))}
    </div>
  )
}

export function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="size-7" aria-hidden>
      <rect x="1" y="3" width="22" height="18" rx="4.5" fill="rgb(var(--signal))" />
      <rect x="2.9" y="4.9" width="18.2" height="14.2" rx="3" fill="none" stroke="rgb(var(--signal-ink))" strokeWidth="1.3" />
      <path d="M7.5 12.2l3 3 6-6.2" stroke="rgb(var(--signal-ink))" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
