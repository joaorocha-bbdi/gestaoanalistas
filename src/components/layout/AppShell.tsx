import { Suspense, useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Activity, CalendarCheck2, CalendarDays, CalendarRange, Download, FlaskConical, History, Layers, Link2, LayoutDashboard, LogOut, Menu, Monitor, Moon,
  PanelLeftClose, PanelLeftOpen, ScrollText, ShieldCheck, SlidersHorizontal, Sun, UserCog, Users, X,
} from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { useTheme, type Theme } from '@/lib/hooks'
import { cx, IconButton, Spinner } from '@/components/ui'
import { preloadRoute } from '@/pages/lazy'
import { useRefreshTasks } from '@/data/queries'

interface NavItem { to: string; label: string; icon: typeof Activity }

const ANALYST_NAV: NavItem[] = [
  { to: '/hoje', label: 'Hoje', icon: CalendarCheck2 },
  { to: '/semana', label: 'Minha semana', icon: CalendarRange },
  { to: '/historico', label: 'Histórico', icon: History },
  { to: '/desempenho', label: 'Desempenho', icon: Activity },
  { to: '/testes', label: 'Testes', icon: FlaskConical },
  { to: '/links', label: 'Links', icon: Link2 },
]

const ADMIN_NAV: NavItem[] = [
  { to: '/admin', label: 'Visão geral', icon: LayoutDashboard },
  { to: '/admin/diario', label: 'Desempenho diário', icon: CalendarDays },
  { to: '/admin/equipe', label: 'Equipe', icon: Users },
  { to: '/admin/revisao', label: 'Revisão', icon: ShieldCheck },
  { to: '/admin/testes', label: 'Aprovação de testes', icon: FlaskConical },
  { to: '/admin/modelos', label: 'Modelos de atividade', icon: Layers },
  { to: '/admin/usuarios', label: 'Usuários e acessos', icon: UserCog },
  { to: '/admin/parametros', label: 'Parâmetros', icon: SlidersHorizontal },
  { to: '/admin/auditoria', label: 'Auditoria', icon: ScrollText },
  { to: '/admin/exportar', label: 'Exportar', icon: Download },
  { to: '/links', label: 'Links', icon: Link2 },
]

const COLLAPSE_KEY = 'menu-recolhido'

/** Barra lateral recolhida (só ícones) ou completa; lembrada neste navegador. */
function useCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1' } catch { return false }
  })
  const toggle = () => setCollapsed((c) => {
    try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1') } catch { /* armazenamento indisponível */ }
    return !c
  })
  return [collapsed, toggle]
}

export function AppShell() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const nav = isAdmin ? ADMIN_NAV : ANALYST_NAV
  const [menuOpen, setMenuOpen] = useState(false)
  const [collapsed, toggleCollapsed] = useCollapsed()
  const location = useLocation()
  useRefreshTasks()

  useEffect(() => setMenuOpen(false), [location.pathname])

  // Com o navegador ocioso, baixa as telas do menu (celular não tem "passar o mouse").
  useEffect(() => {
    const run = () => nav.forEach((n) => preloadRoute(n.to))
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(run, { timeout: 4000 })
      return () => window.cancelIdleCallback(id)
    }
    const id = setTimeout(run, 2500)
    return () => clearTimeout(id)
  }, [nav])

  return (
    <div className={cx('min-h-dvh transition-[padding] duration-200', collapsed ? 'lg:pl-16' : 'lg:pl-60')}>
      <aside className={cx('fixed inset-y-0 left-0 z-20 hidden bg-rail text-rail-ink transition-[width] duration-200 lg:block',
        collapsed ? 'w-16' : 'w-60')}>
        <Sidebar nav={nav} isAdmin={isAdmin} collapsed={collapsed} onToggle={toggleCollapsed} />
      </aside>

      {/* Barra superior no celular */}
      <div className="sticky top-0 z-20 flex h-12 items-center gap-2 bg-rail px-2 text-rail-ink lg:hidden">
        <IconButton label="Abrir menu" className="text-rail-ink hover:bg-rail-ink/10" onClick={() => setMenuOpen(true)}><Menu className="size-5" /></IconButton>
        <Logo />
        <span className="font-display text-lg font-semibold">Rotina</span>
      </div>
      {menuOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/40 dark:bg-black/60" onClick={() => setMenuOpen(false)} aria-hidden />
          <div className="relative max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-lg bg-rail text-rail-ink shadow-pop">
            <IconButton label="Fechar menu" className="absolute right-2 top-3.5 text-rail-ink/70 hover:bg-rail-ink/10" onClick={() => setMenuOpen(false)}><X className="size-4" /></IconButton>
            <Sidebar nav={nav} isAdmin={isAdmin} collapsed={false} />
          </div>
        </div>
      )}

      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
        <Suspense fallback={<div className="py-10"><Spinner /></div>}>
          <Outlet />
        </Suspense>
      </main>

    </div>
  )
}

/** Dica ao lado do ícone quando a barra está recolhida. */
function RailTip({ children }: { children: ReactNode }) {
  return (
    <span role="tooltip"
      className="pointer-events-none absolute left-full top-1/2 z-30 ml-3 -translate-y-1/2 whitespace-nowrap rounded bg-ink px-2 py-1 text-xs font-medium text-surface opacity-0 shadow-pop transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
      {children}
    </span>
  )
}

function Sidebar({ nav, isAdmin, collapsed, onToggle }: {
  nav: NavItem[]; isAdmin: boolean; collapsed: boolean; onToggle?: () => void
}) {
  const { profile, signOut } = useAuth()
  const quiet = 'text-rail-ink/60 hover:bg-rail-ink/[0.07] hover:text-rail-ink'

  return (
    <nav aria-label="Principal" className="flex h-full flex-col">
      <div className={cx('flex h-16 shrink-0 items-center gap-2.5', collapsed ? 'justify-center px-0' : 'px-5')}>
        <Logo />
        {!collapsed && (
          <>
            <span className="font-display text-xl font-semibold">Rotina</span>
            <span className="ml-auto text-xs text-rail-ink/55">{isAdmin ? 'Gestor' : 'Analista'}</span>
          </>
        )}
      </div>

      <ul className={cx('flex-1 space-y-0.5 py-3', collapsed ? 'px-2' : 'overflow-y-auto px-3 scrollbar-thin')}>
        {nav.map((n) => (
          <li key={n.to}>
            <NavLink
              to={n.to}
              end={n.to === '/admin'}
              aria-label={collapsed ? n.label : undefined}
              onMouseEnter={() => preloadRoute(n.to)}
              onFocus={() => preloadRoute(n.to)}
              className={({ isActive }) => cx(
                'group relative flex h-9 items-center rounded text-base',
                collapsed ? 'justify-center' : 'gap-2.5 px-3',
                isActive ? 'bg-rail-accent/10 font-medium text-rail-ink' : 'text-rail-ink/70 hover:bg-rail-ink/[0.06] hover:text-rail-ink',
              )}
            >
              {({ isActive }) => (
                <>
                  {isActive && <span className="absolute inset-y-1.5 left-0 w-1 rounded-r bg-rail-accent" aria-hidden />}
                  <n.icon className={cx('size-4 shrink-0', isActive ? 'text-rail-accent' : 'text-rail-ink/55 group-hover:text-rail-ink/85')} strokeWidth={1.75} aria-hidden />
                  {collapsed ? <RailTip>{n.label}</RailTip> : (
<span className="flex-1 truncate">{n.label}</span>
                  )}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>

      {collapsed ? (
        <div className="flex flex-col items-center gap-1 py-3">
          <ThemeCycle />
          <button onClick={() => void signOut()} aria-label="Sair" className={cx('group relative flex size-9 items-center justify-center rounded', quiet)}>
            <LogOut className="size-4" /><RailTip>Sair · {profile?.full_name}</RailTip>
          </button>
          {onToggle && (
            <button onClick={onToggle} aria-label="Expandir menu" aria-expanded={false} className={cx('group relative mt-1 flex size-9 items-center justify-center rounded', quiet)}>
              <PanelLeftOpen className="size-4" /><RailTip>Expandir menu</RailTip>
            </button>
          )}
        </div>
      ) : (
        <div className="mx-3 mb-3 space-y-3 rounded-lg bg-rail-ink/[0.045] p-3">
          <ThemeSwitch />
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{profile?.full_name}</p>
              <p className="truncate text-xs text-rail-ink/55">{profile?.email}</p>
            </div>
            <IconButton label="Sair" className={quiet} onClick={() => void signOut()}><LogOut className="size-4" /></IconButton>
          </div>
          {onToggle && (
          <div className="flex items-center justify-end gap-2">
              <IconButton label="Recolher menu" aria-expanded className={quiet} onClick={onToggle}>
                <PanelLeftClose className="size-4" />
              </IconButton>
          </div>
          )}
        </div>
      )}
    </nav>
  )
}

const THEME_OPTS: { v: Theme; icon: ReactNode; label: string }[] = [
  { v: 'claro', icon: <Sun className="size-3.5" />, label: 'Tema claro' },
  { v: 'escuro', icon: <Moon className="size-3.5" />, label: 'Tema escuro' },
  { v: 'sistema', icon: <Monitor className="size-3.5" />, label: 'Seguir o sistema' },
]

function ThemeSwitch() {
  const [theme, setTheme] = useTheme()
  return (
    <div role="radiogroup" aria-label="Tema" className="flex rounded bg-rail-ink/[0.07] p-0.5">
      {THEME_OPTS.map((o) => (
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

/** Barra recolhida: um botão só, que alterna claro → escuro → sistema. */
function ThemeCycle() {
  const [theme, setTheme] = useTheme()
  const i = THEME_OPTS.findIndex((o) => o.v === theme)
  const cur = THEME_OPTS[i] ?? THEME_OPTS[2]
  const next = THEME_OPTS[(i + 1) % THEME_OPTS.length]
  return (
    <button onClick={() => setTheme(next.v)} aria-label={`${cur.label}. Trocar para: ${next.label.toLowerCase()}`}
      className="group relative flex size-9 items-center justify-center rounded text-rail-ink/60 hover:bg-rail-ink/[0.07] hover:text-rail-ink">
      {cur.icon}<RailTip>{cur.label} · clique para {next.label.toLowerCase()}</RailTip>
    </button>
  )
}

export function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="size-7 shrink-0" aria-hidden>
      <rect x="1" y="3" width="22" height="18" rx="4.5" fill="rgb(var(--signal))" />
      <rect x="2.9" y="4.9" width="18.2" height="14.2" rx="3" fill="none" stroke="rgb(var(--signal-ink))" strokeWidth="1.3" />
      <path d="M7.5 12.2l3 3 6-6.2" stroke="rgb(var(--signal-ink))" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
