import { useState } from 'react'
import { ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react'
import { useAuth } from '@/auth/AuthProvider'
import { Button, Dialog, EmptyState, ErrorNote, FormField, IconButton, Input, PageHeader, Skeleton, Textarea } from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { useDeleteLink, useLinks, useSaveLink } from '@/data/queries'
import { errorMessage } from '@/lib/status'
import type { UsefulLink } from '@/lib/types'


/** Links das ferramentas usadas nas atividades. Todos veem; só o gestor edita. */
export default function Links() {
  const { profile } = useAuth()
  const canEdit = profile?.role === 'admin'
  const q = useLinks()
  const [editing, setEditing] = useState<Partial<UsefulLink> | null>(null)
  const [removing, setRemoving] = useState<UsefulLink | null>(null)

  return (
    <>
      <PageHeader
        title="Links"
        meta={canEdit ? 'As ferramentas que a equipe usa nas atividades. Só você, como gestor, pode alterar esta página.' : 'As ferramentas que a equipe usa nas atividades.'}
        actions={canEdit && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>Novo link</Button>}
      />
      <ErrorNote error={q.error} />
      {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.length ? (
        <EmptyState title="Nenhum link cadastrado"
          action={canEdit && <Button onClick={() => setEditing({})}>Adicionar o primeiro link</Button>}>
          {canEdit ? 'Cadastre o hub e as demais ferramentas, com uma breve descrição de para que serve cada uma.' : 'O gestor ainda não cadastrou os links das ferramentas.'}
        </EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {q.data.map((l) => (
            <li key={l.id} className="flex flex-col rounded-lg border border-line bg-surface p-5">
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-xl font-semibold leading-6">{l.name}</h2>
                {canEdit && (
                  <div className="-mr-2 -mt-1 flex shrink-0">
                    <IconButton label={`Editar ${l.name}`} onClick={() => setEditing(l)}><Pencil className="size-4" /></IconButton>
                    <IconButton label={`Remover ${l.name}`} onClick={() => setRemoving(l)}><Trash2 className="size-4" /></IconButton>
                  </div>
                )}
              </div>
              <p className="mt-2 flex-1 text-base text-muted">{l.description || 'Sem descrição.'}</p>
              <a href={l.url} target="_blank" rel="noreferrer" aria-label={`Abrir ${l.name}`}
                className="mt-4 inline-flex items-center gap-2 self-start rounded bg-signal px-3 py-2 text-sm font-semibold text-signal-ink hover:brightness-95">
                Abrir <ExternalLink className="size-4" aria-hidden />
              </a>
            </li>
          ))}
        </ul>
      )}

      {canEdit && editing && <LinkDialog link={editing} onClose={() => setEditing(null)} />}
      {canEdit && removing && <RemoveDialog link={removing} onClose={() => setRemoving(null)} />}
    </>
  )
}

function LinkDialog({ link, onClose }: { link: Partial<UsefulLink>; onClose: () => void }) {
  const save = useSaveLink()
  const toast = useToast()
  const [name, setName] = useState(link.name ?? '')
  const [url, setUrl] = useState(link.url ?? '')
  const [description, setDescription] = useState(link.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const urlOk = /^https?:\/\/\S+$/i.test(url.trim())

  async function submit() {
    setError(null)
    try {
      await save.mutateAsync({ id: link.id, name: name.trim(), url: url.trim(), description: description.trim() || null })
      toast(link.id ? 'Link atualizado.' : 'Link adicionado.')
      onClose()
    } catch (e) { setError(errorMessage(e)) }
  }

  return (
    <Dialog open onClose={onClose} title={link.id ? 'Editar link' : 'Novo link'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={save.isPending} disabled={!name.trim() || !urlOk} onClick={submit}>{link.id ? 'Salvar' : 'Adicionar link'}</Button></>}>
      <div className="space-y-4">
        <ErrorNote error={error} />
        <FormField label="Nome" required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Ex.: Hub de precificação" /></FormField>
        <FormField label="Link" required error={url && !urlOk ? 'Comece com https://' : undefined}>
          <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
        </FormField>
        <FormField label="Para que serve" hint="Uma frase curta, para quem chegou agora entender quando usar.">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
      </div>
    </Dialog>
  )
}

function RemoveDialog({ link, onClose }: { link: UsefulLink; onClose: () => void }) {
  const del = useDeleteLink()
  const toast = useToast()
  return (
    <Dialog open onClose={onClose} title="Remover link"
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="danger" loading={del.isPending} onClick={async () => {
          try { await del.mutateAsync(link.id); toast('Link removido.'); onClose() } catch (e) { toast(errorMessage(e), 'bad') }
        }}>Remover</Button></>}>
      <p>Remover <span className="font-semibold">{link.name}</span> da página de links? A equipe deixa de ver este card.</p>
    </Dialog>
  )
}
