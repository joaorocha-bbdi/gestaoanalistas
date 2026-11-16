import { useSearchParams } from 'react-router-dom'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

const isTyping = (el: EventTarget | null) => {
  const t = el as HTMLElement | null
  return !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
}

/**
 * Atalhos de teclado. Chave no formato 'j', 'shift+?', 'mod+enter' (mod = Ctrl/⌘).
 * Teclas simples são ignoradas enquanto o foco está num campo de texto.
 */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true) {
  const ref = useRef(map)
  ref.current = map
  useEffect(() => {
    if (!enabled) return
    const h = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      const combo = `${mod ? 'mod+' : ''}${e.shiftKey && key.length > 1 ? 'shift+' : ''}${key}`
      const fn = ref.current[combo]
      if (!fn) return
      if (!mod && isTyping(e.target)) return
      if (document.querySelector('[role="dialog"]') && !combo.startsWith('mod+') && !(e.target as HTMLElement)?.closest?.('[role="dialog"]')) return
      e.preventDefault()
      fn(e)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [enabled])
}

// Relógio único do app: um só timer, compartilhado por quem mostra "vence em…".
const TICK = 30_000
let clockNow = Date.now()
let clockTimer: ReturnType<typeof setInterval> | undefined
const clockSubs = new Set<() => void>()
function subscribeClock(cb: () => void) {
  clockSubs.add(cb)
  if (!clockTimer) {
    clockNow = Date.now()
    clockTimer = setInterval(() => { clockNow = Date.now(); clockSubs.forEach((f) => f()) }, TICK)
  }
  return () => {
    clockSubs.delete(cb)
    if (!clockSubs.size && clockTimer) { clearInterval(clockTimer); clockTimer = undefined }
  }
}

/**
 * Hora atual, atualizada a cada 30 s. Use no menor componente que mostra
 * prazo (linha, placa): assim só ele redesenha, não a página inteira.
 */
export function useNow() {
  return useSyncExternalStore(subscribeClock, () => clockNow)
}

export type Theme = 'claro' | 'escuro' | 'sistema'

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return (localStorage.getItem('tema') as Theme) || 'sistema' } catch { return 'sistema' }
  })
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'escuro' || (theme === 'sistema' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    try {
      if (theme === 'sistema') localStorage.removeItem('tema')
      else localStorage.setItem('tema', theme)
    } catch { /* armazenamento indisponível */ }
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
  return [theme, setTheme]
}

/** Estado sincronizado com um parâmetro da URL (?k=v), sem empilhar histórico. */
export function useSearchParamState(key: string): [string | null, (v: string | null) => void] {
  const [sp, setSp] = useSearchParams()
  const set = (v: string | null) =>
    setSp((prev) => {
      const n = new URLSearchParams(prev)
      if (v === null) n.delete(key)
      else n.set(key, v)
      return n
    }, { replace: true })
  return [sp.get(key), set]
}
