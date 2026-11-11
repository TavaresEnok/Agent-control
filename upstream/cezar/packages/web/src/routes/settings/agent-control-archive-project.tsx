import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'

import { workspaceQueryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { agentControlFetch } from './agent-control-fetch'
import { readPersonalProjects, waitForPersonalProject } from '../personal-project-wait'
import { SettingsField } from './settings-field'

const archivedSchema = z.object({
  projectId: z.string().uuid(),
  restarting: z.boolean(),
  restartRequired: z.boolean(),
})

function archiveError(code: string) {
  if (code === 'PRIMARY_PROJECT_FORBIDDEN') return 'O projeto principal não pode ser arquivado.'
  if (code === 'PROJECT_CREATION_BUSY') return 'Espere o outro pedido terminar.'
  return 'Não foi possível arquivar o projeto.'
}

/** Hidden for the installation's primary project. */
export function AgentControlArchiveProject({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [primary, setPrimary] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancel = false
    void readPersonalProjects().then((page) => {
      if (!cancel) setPrimary(page.primaryProjectId ?? null)
    }).catch(() => { if (!cancel) setPrimary(null) })
    return () => { cancel = true }
  }, [projectId])

  if (!primary || primary === projectId) return null

  async function archive() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await agentControlFetch(`/api/v1/ac/personal/projects/${encodeURIComponent(projectId)}/archive`, { method: 'POST' })
      const body: unknown = await response.json()
      if (!response.ok) {
        const code = z.object({ error: z.string() }).safeParse(body)
        setError(archiveError(code.success ? code.data.error : ''))
        return
      }
      const archived = archivedSchema.parse(body)
      setNotice(archived.restarting ? 'Reiniciando o painel…' : 'Reinicie o gateway para o arquivamento valer.')
      setConfirm(false)
      const gone = await waitForPersonalProject(projectId, false)
      if (!gone) {
        setError('O projeto ainda está na lista. Reinicie o gateway.')
        return
      }
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects })
      navigate(`/p/${encodeURIComponent(primary!)}/conversa`)
    } catch {
      setError('Não foi possível arquivar o projeto.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsField title="Arquivar projeto" hint="Some da lista. Nenhum arquivo é apagado e a conversa do Happier fica.">
      <Button type="button" variant="outline" className="min-h-11 w-fit text-danger" disabled={busy} onClick={() => setConfirm(true)}>Arquivar projeto</Button>
      {confirm ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>Arquivar este projeto?</span>
          <Button type="button" className="min-h-11" disabled={busy} onClick={() => { void archive() }}>Arquivar</Button>
          <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => setConfirm(false)}>Cancelar</Button>
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </SettingsField>
  )
}
