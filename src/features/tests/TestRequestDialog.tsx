import { useState } from 'react'
import { Send } from 'lucide-react'
import { Button, Dialog, ErrorNote, FormField, Input, Textarea } from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { useCreateTestRequest, useResubmitTestRequest } from '@/data/queries'
import { addDays, todayISO } from '@/lib/dates'
import { errorMessage } from '@/lib/status'
import type { TestRequest } from '@/lib/types'

/**
 * Solicitar teste (opcional): referência, o que testar, por quê e período.
 * Vai para a aprovação do gestor. Com `request` reprovado, corrige e reenvia.
 */
export function TestRequestDialog({ open, onClose, request }: { open: boolean; onClose: () => void; request?: TestRequest | null }) {
  const today = todayISO()
  const create = useCreateTestRequest()
  const resubmit = useResubmitTestRequest()
  const toast = useToast()
  const [sku, setSku] = useState(request?.sku ?? '')
  const [analysis, setAnalysis] = useState(request?.analysis ?? '')
  const [explanation, setExplanation] = useState(request?.explanation ?? '')
  const [start, setStart] = useState(request?.start_date ?? today)
  const [end, setEnd] = useState(request?.end_date ?? addDays(today, 14))
  const [error, setError] = useState<string | null>(null)
  const datesOk = !!start && !!end && end >= start
  const valid = sku.trim() && analysis.trim() && explanation.trim() && datesOk
  const busy = create.isPending || resubmit.isPending

  async function send() {
    setError(null)
    const input = { sku: sku.trim(), analysis: analysis.trim(), explanation: explanation.trim(), start, end }
    try {
      if (request) await resubmit.mutateAsync({ id: request.id, ...input })
      else await create.mutateAsync(input)
      toast('Solicitação enviada para a aprovação do gestor.')
      if (!request) { setSku(''); setAnalysis(''); setExplanation(''); setStart(today); setEnd(addDays(today, 14)) }
      onClose()
    } catch (e) { setError(errorMessage(e)) }
  }

  return (
    <Dialog open={open} onClose={onClose} title={request ? 'Corrigir e reenviar teste' : 'Solicitar teste'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" icon={<Send className="size-4" />} loading={busy} disabled={!valid} onClick={send}>Enviar para aprovação</Button></>}>
      <div className="space-y-4">
        {request?.status === 'reprovada' && request.review_reason && (
          <p className="rounded border border-bad/30 bg-bad/5 px-3 py-2 text-sm">
            <span className="font-medium">Justificativa do gestor:</span> {request.review_reason}
          </p>
        )}
        {!request && <p className="text-sm text-muted">Opcional. O teste só começa depois da aprovação do gestor.</p>}
        <ErrorNote error={error} />
        <FormField label="Referência" required hint="Letras e números, como está no catálogo.">
          <Input mono value={sku} onChange={(e) => setSku(e.target.value)} autoFocus />
        </FormField>
        <FormField label="O que deve ser testado" required hint="A análise do teste para esta referência. Ex.: trocar o kit de fotos.">
          <Textarea rows={3} value={analysis} onChange={(e) => setAnalysis(e.target.value)} />
        </FormField>
        <FormField label="Explicação" required hint="Por que testar isso nesta referência e o que você espera melhorar.">
          <Textarea rows={3} value={explanation} onChange={(e) => setExplanation(e.target.value)} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Início do teste" required>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </FormField>
          <FormField label="Data final prevista" required error={start && end && end < start ? 'Precisa ser igual ou depois do início.' : undefined}>
            <Input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
          </FormField>
        </div>
      </div>
    </Dialog>
  )
}
