import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'

import { workspaceQueryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { agentControlFetch } from './settings/agent-control-fetch'
import { waitForPersonalProject } from './personal-project-wait'

const rootsSchema = z.object({
  roots: z.array(z.object({ id: z.string(), label: z.string() })),
})
const listingSchema = z.object({
  root: z.string(),
  path: z.string(),
  folders: z.array(z.object({
    name: z.string(),
    path: z.string(),
    git: z.boolean(),
    project: z.boolean(),
  })),
})
const createdSchema = z.object({
  projectId: z.string().uuid(),
  restarting: z.boolean(),
  restartRequired: z.boolean(),
})

function createError(code: string) {
  if (code === 'NOT_A_GIT_REPOSITORY' || code === 'REPOSITORY_BRANCH_REQUIRED') {
    return 'Esta pasta não é um repositório Git. Rode git init e faça um commit.'
  }
  if (code === 'PROJECT_CREATION_BUSY') return 'Já há um projeto sendo criado.'
  if (code === 'REPOSITORY_ALREADY_IN_INSTALLATION') return 'Esta pasta já é um projeto.'
  if (code === 'PROJECT_PATH_FORBIDDEN' || code === 'PROJECT_ROOT_FORBIDDEN') return 'Esta pasta está fora da raiz permitida.'
  if (code === 'LABEL_INVALID') return 'O nome não serve.'
  return 'Não foi possível criar o projeto.'
}

export function NovoProjetoRoute() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [roots, setRoots] = useState<{ id: string; label: string }[] | null>(null)
  const [root, setRoot] = useState('')
  const [path, setPath] = useState('')
  const [folders, setFolders] = useState<z.infer<typeof listingSchema>['folders']>([])
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let cancel = false
    void (async () => {
      try {
        const response = await agentControlFetch('/api/v1/ac/personal/folders', { cache: 'no-store' })
        const body: unknown = await response.json()
        if (!response.ok) throw new Error('FOLDERS_UNAVAILABLE')
        const parsed = rootsSchema.parse(body)
        if (cancel) return
        setRoots(parsed.roots)
        setRoot(parsed.roots[0]?.id ?? '')
      } catch {
        if (!cancel) setLoadError('Não foi possível ler as pastas.')
      }
    })()
    return () => { cancel = true }
  }, [])

  useEffect(() => {
    if (!root) return
    let cancel = false
    void (async () => {
      try {
        const params = new URLSearchParams({ root, path })
        const response = await agentControlFetch(`/api/v1/ac/personal/folders?${params}`, { cache: 'no-store' })
        const body: unknown = await response.json()
        if (!response.ok) throw new Error('FOLDERS_UNAVAILABLE')
        const parsed = listingSchema.parse(body)
        if (cancel || parsed.root !== root) return
        setFolders(parsed.folders)
        setLoadError('')
      } catch {
        if (!cancel) setLoadError('Não foi possível ler as pastas.')
      }
    })()
    return () => { cancel = true }
  }, [root, path])

  const rootLabel = roots?.find((item) => item.id === root)?.label ?? root
  const parts = path ? path.split('/') : []
  const folderName = parts.at(-1) ?? rootLabel

  async function create() {
    const name = label.trim()
    if (!root || !name || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await agentControlFetch('/api/v1/ac/personal/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root, path, label: name }),
      })
      const body: unknown = await response.json()
      if (!response.ok) {
        const code = z.object({ error: z.string() }).safeParse(body)
        setError(createError(code.success ? code.data.error : ''))
        return
      }
      const created = createdSchema.parse(body)
      setNotice(created.restarting ? 'Reiniciando o painel…' : 'Reinicie o gateway para o projeto valer.')
      const appeared = await waitForPersonalProject(created.projectId, true)
      if (!appeared) {
        setError('O projeto não apareceu. Reinicie o gateway e abra a conversa de novo.')
        return
      }
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects })
      navigate(`/p/${encodeURIComponent(created.projectId)}/conversa`)
    } catch {
      setError('Não foi possível criar o projeto.')
    } finally {
      setBusy(false)
    }
  }

  if (roots && roots.length === 0) {
    return (
      <div data-route="novo-projeto" className="flex flex-col gap-3 px-3 py-4 text-sm">
        <h1 className="text-lg font-medium">Novo projeto</h1>
        <p>Nenhuma pasta foi liberada. No servidor:</p>
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">npm run personal:roots -- &lt;instalação.json&gt; add &lt;pasta&gt;</pre>
      </div>
    )
  }

  return (
    <div data-route="novo-projeto" className="flex flex-col gap-3 px-3 py-4 text-sm">
      <h1 className="text-lg font-medium">Novo projeto</h1>
      {roots && roots.length > 1 ? (
        <label className="flex flex-col gap-1">Raiz
          <select aria-label="Raiz" className="h-11 rounded-md border border-input bg-card px-2" value={root} onChange={(event) => { setRoot(event.target.value); setPath(''); setLabel('') }}>
            {roots.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
      ) : null}
      <p className="flex flex-wrap gap-1">
        <button type="button" className="underline" onClick={() => setPath('')}>{rootLabel || '…'}</button>
        {parts.map((part, index) => (
          <button key={part + index} type="button" className="underline" onClick={() => setPath(parts.slice(0, index + 1).join('/'))}>/ {part}</button>
        ))}
      </p>
      {loadError ? <p role="alert">{loadError}</p> : null}
      <ul className="flex flex-col gap-1">
        {folders.map((folder) => (
          <li key={folder.path}>
            <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted" onClick={() => setPath(folder.path)}>
              <span className="truncate">{folder.name}</span>
              {folder.git ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">Git</span> : null}
              {folder.project ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">já é projeto</span> : null}
            </button>
          </li>
        ))}
        {root && folders.length === 0 ? <li className="text-muted-foreground">Nenhuma pasta aqui.</li> : null}
      </ul>
      <Button type="button" variant="outline" className="min-h-11 w-fit" disabled={!root || busy} onClick={() => setLabel(folderName)}>Usar esta pasta</Button>
      <label className="flex flex-col gap-1">Nome
        <Input aria-label="Nome do projeto" value={label} maxLength={200} onChange={(event) => setLabel(event.target.value)} />
      </label>
      <Button type="button" className="min-h-11 w-fit" disabled={!root || !label.trim() || busy} onClick={() => { void create() }}>Criar</Button>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}
