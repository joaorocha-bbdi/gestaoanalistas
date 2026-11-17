import { lazy, type ComponentType } from 'react'

/**
 * Telas carregadas sob demanda. Cada uma vira um arquivo separado: o analista
 * não baixa as telas do gestor e vice-versa. `preloadRoute` baixa o código
 * quando o mouse passa no menu, então a navegação continua instantânea.
 */
type Loader = () => Promise<{ default: ComponentType }>

const loaders = {
  '/semana': () => import('@/pages/analyst/Week'),
  '/historico': () => import('@/pages/analyst/History'),
  '/desempenho': () => import('@/pages/analyst/Performance'),
  '/testes': () => import('@/pages/analyst/Tests'),
  '/links': () => import('@/pages/Links'),
  '/admin': () => import('@/pages/admin/Overview'),
  '/admin/diario': () => import('@/pages/admin/Daily'),
  '/admin/equipe': () => import('@/pages/admin/Team'),
  '/admin/revisao': () => import('@/pages/admin/Review'),
  '/admin/testes': () => import('@/pages/admin/TestApprovals'),
  '/admin/modelos': () => import('@/pages/admin/Templates'),
  '/admin/usuarios': () => import('@/pages/admin/Users'),
  '/admin/parametros': () => import('@/pages/admin/Settings'),
  '/admin/auditoria': () => import('@/pages/admin/Audit'),
  '/admin/exportar': () => import('@/pages/admin/Export'),
} satisfies Record<string, Loader>

const started = new Set<string>()
export function preloadRoute(path: string) {
  const load = (loaders as Record<string, Loader | undefined>)[path]
  if (!load || started.has(path)) return
  started.add(path)
  void load().catch(() => started.delete(path))
}

export const Week = lazy(loaders['/semana'])
export const History = lazy(loaders['/historico'])
export const Performance = lazy(loaders['/desempenho'])
export const Tests = lazy(loaders['/testes'])
export const Links = lazy(loaders['/links'])
export const Overview = lazy(loaders['/admin'])
export const Daily = lazy(loaders['/admin/diario'])
export const Team = lazy(loaders['/admin/equipe'])
export const AnalystDetail = lazy(() => import('@/pages/admin/Team').then((m) => ({ default: m.AnalystDetail })))
export const Review = lazy(loaders['/admin/revisao'])
export const TestApprovals = lazy(loaders['/admin/testes'])
export const Templates = lazy(loaders['/admin/modelos'])
export const TemplateEditor = lazy(() => import('@/pages/admin/TemplateEditor'))
export const Users = lazy(loaders['/admin/usuarios'])
export const Settings = lazy(loaders['/admin/parametros'])
export const Audit = lazy(loaders['/admin/auditoria'])
export const Export = lazy(loaders['/admin/exportar'])
