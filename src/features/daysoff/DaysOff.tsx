import { useState } from 'react'
import { CalendarOff, Undo2 } from 'lucide-react'
import { Button, Dialog, ErrorNote, FormField, Input, Skeleton } from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { useDaysOff, useSetDayOff } from '@/data/queries'
import { addDays, fmtDay, fmtDayLong, todayISO } from '@/lib/dates'
import { errorMessage } from '@/lib/status'
import type { Profile } from '@/lib/types'

const HINT = 'As atividades diárias do dia não aceitam registro e não contam nas métricas. Semanais e mensais seguem normais.'

/** Confirma a desativação de um dia para um analista, com motivo opcional. */
export function DayOffDialog({ analyst, day, onClose }: { analyst: Profile; day: string; onClose: () => void }) {
  const toast = useToast()
  const setDayOff = useSetDayOff()
  const [reason, setReason] = useState('')
  const isToday = day === todayISO()

  async function confirm() {
    try { await setDayOff.mutateAsync({ userId: analyst.id, day, off: true, reason: reason.trim() }) } catch { return }
    toast(`${isToday ? 'Hoje' : fmtDay(day)} desativado para ${analyst.full_name}.`)
    onClose()
  }

  return (
    <Dialog open onClose={onClose} title={`Desativar ${isToday ? 'o dia de hoje' : fmtDayLong(day)} para ${analyst.full_name}?`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="danger" icon={<CalendarOff className="size-4" />} loading={setDayOff.isPending} onClick={() => void confirm()}>Desativar dia</Button></>}>
      <div className="space-y-4">
        <ErrorNote error={setDayOff.error ? errorMessage(setDayOff.error) : null} />
        <p className="text-sm text-muted">{HINT} Dá para reativar depois; o que já foi feito volta a contar.</p>
        <FormField label="Motivo" hint="Opcional. Aparece para o analista e na auditoria.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: apoio em outra área" autoFocus />
        </FormField>
      </div>
    </Dialog>
  )
}

/** Na edição do usuário: desativar um dia (hoje ou outro) e ver/reativar os já desativados. */
export function DaysOffEditor({ profile, busy }: { profile: Profile; busy: boolean }) {
  const toast = useToast()
  const today = todayISO()
  const list = useDaysOff({ userId: profile.id, from: addDays(today, -30) })
  const setDayOff = useSetDayOff()
  const [day, setDay] = useState(today)
  const [reason, setReason] = useState('')
  const already = (list.data ?? []).some((d) => d.day === day)

  async function add() {
    try { await setDayOff.mutateAsync({ userId: profile.id, day, off: true, reason: reason.trim() }) } catch { return }
    toast(`${day === today ? 'Hoje' : fmtDay(day)} desativado para ${profile.full_name}.`)
    setReason('')
  }

  async function remove(d: string) {
    try { await setDayOff.mutateAsync({ userId: profile.id, day: d, off: false }) } catch { return }
    toast(`${d === today ? 'Hoje' : fmtDay(d)} reativado para ${profile.full_name}.`)
  }

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div>
        <p className="text-sm font-medium">Dias desativados</p>
        <p className="text-sm text-muted">{HINT}</p>
      </div>
      <ErrorNote error={setDayOff.error ? errorMessage(setDayOff.error) : null} />
      <div className="flex flex-wrap items-end gap-2">
        <FormField label="Dia" className="w-40">
          <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </FormField>
        <FormField label="Motivo (opcional)" className="min-w-48 flex-1">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: apoio em outra área" />
        </FormField>
        <Button icon={<CalendarOff className="size-4" />} loading={setDayOff.isPending && setDayOff.variables?.off}
          disabled={busy || !day || already} onClick={() => void add()}>
          {already ? 'Já desativado' : 'Desativar dia'}
        </Button>
      </div>
      {list.isLoading ? <Skeleton className="h-10" /> : (list.data ?? []).length > 0 && (
        <ul className="divide-y divide-line rounded border border-line">
          {(list.data ?? []).map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="font-medium">{fmtDayLong(d.day)}</span>
                {d.day === today && <span className="ml-2 text-muted">hoje</span>}
                {d.reason && <span className="block truncate text-muted">{d.reason}</span>}
              </span>
              <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} disabled={busy || setDayOff.isPending}
                onClick={() => void remove(d.day)}>Reativar</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
