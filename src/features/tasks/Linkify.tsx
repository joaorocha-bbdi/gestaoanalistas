import { ExternalLink } from 'lucide-react'

/** Torna URLs clicáveis nas instruções. */
export function Linkify({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/\S+)/g)
  return (
    <>
      {parts.map((p, i) => /^https?:\/\//.test(p)
        ? <a key={i} href={p} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 break-all underline underline-offset-2 hover:text-muted">{p}<ExternalLink className="size-3" aria-hidden /></a>
        : <span key={i}>{p}</span>)}
    </>
  )
}
