import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { AuthProvider } from '@/auth/AuthProvider'
import { ToastProvider } from '@/components/ui/toast'
import App from './App'
import './index.css'

export const CACHE_KEY = 'rotina-cache'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Dados recentes são mostrados na hora; a atualização acontece em segundo plano.
      staleTime: 60_000,
      gcTime: 24 * 60 * 60_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
})

// Guarda o último estado das telas no navegador: ao reabrir, o app aparece na hora
// e atualiza em seguida. Limpo ao sair ou ao trocar de usuário (ver AuthProvider).
const persister = createSyncStoragePersister({
  key: CACHE_KEY,
  storage: (() => { try { return window.localStorage } catch { return undefined } })(),
  throttleTime: 1500,
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 24 * 60 * 60_000,
        buster: 'v1',
        dehydrateOptions: {
          // Não guarda auditoria (volume grande) nem a geração de tarefas.
          shouldDehydrateQuery: (q) => q.state.status === 'success'
            && !['audit', 'refresh_tasks'].includes(String(q.queryKey[0])),
        },
      }}
    >
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </PersistQueryClientProvider>
  </StrictMode>,
)
