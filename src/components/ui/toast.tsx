import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import clsx from 'clsx'

interface Toast { id: number; text: string; tone: 'ok' | 'bad' }
const Ctx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random()
    setItems((xs) => [...xs, { id, text, tone }])
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === 'bad' ? 6000 : 3200)
  }, [])
  return (
    <Ctx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
        {items.map((t) => (
          <div
            key={t.id}
            className={clsx(
              'pointer-events-auto flex max-w-md items-start gap-2 rounded border border-line bg-surface px-3.5 py-2.5 text-sm shadow-pop',
              'animate-[toastin_140ms_ease-out]',
            )}
          >
            {t.tone === 'ok'
              ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
              : <XCircle className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
      <style>{'@keyframes toastin{from{transform:translateY(6px);opacity:0}to{transform:none;opacity:1}}'}</style>
    </Ctx.Provider>
  )
}

export const useToast = () => useContext(Ctx)
