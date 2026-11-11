import { useEffect, useRef, useState } from 'react'
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

const hostSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  host: z.string(),
  port: z.number(),
  user: z.string(),
  fingerprint: z.string(),
})
const sshStatusSchema = z.object({
  publicKey: z.string(),
  hosts: z.array(hostSchema),
})
const remoteListingSchema = z.object({
  host: z.string(),
  path: z.string(),
  folders: z.array(z.object({
    name: z.string(),
    path: z.string(),
    git: z.boolean(),
  })),
})

function remoteError(code: string) {
  if (code === 'NOT_A_GIT_REPOSITORY' || code === 'REPOSITORY_BRANCH_REQUIRED') return 'Esta pasta não é um repositório Git.'
  if (code === 'PROJECT_CREATION_BUSY') return 'Já há um projeto sendo criado.'
  if (code === 'REPOSITORY_ALREADY_IN_INSTALLATION') return 'Esta pasta já é um projeto.'
  if (code === 'REMOTE_PATH_FORBIDDEN') return 'Este caminho não serve.'
  if (code === 'LABEL_INVALID') return 'O nome não serve.'
  if (code === 'HOST_IDENTITY_MISMATCH') return 'A identidade mudou. Confira de novo.'
  if (code === 'HOST_IDENTITY_UNAVAILABLE') return 'Não consegui ler a identidade do servidor.'
  if (code === 'HOST_ALREADY_PRESENT') return 'Este servidor já está na lista.'
  if (code === 'HOST_NOT_FOUND') return 'Servidor não encontrado.'
  if (code === 'HOST_IN_USE') return 'Ainda há um projeto neste servidor.'
  if (code === 'SSH_FAILED') return 'Não consegui falar com o servidor.'
  if (code === 'CHECKOUT_EXISTS') return 'Já existe uma cópia com este nome.'
  if (code === 'HOST_INVALID') return 'Host, porta ou usuário não servem.'
  if (code === 'HOST_LIMIT') return 'A lista de servidores está cheia.'
  return 'Não foi possível continuar.'
}

function errorCode(body: unknown) {
  const parsed = z.object({ error: z.string() }).safeParse(body)
  return parsed.success ? parsed.data.error : ''
}

function RemoteServerProject() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [publicKey, setPublicKey] = useState('')
  const [hosts, setHosts] = useState<z.infer<typeof hostSchema>[] | null>(null)
  const [hostId, setHostId] = useState('')
  const [path, setPath] = useState('')
  const [folders, setFolders] = useState<z.infer<typeof remoteListingSchema>['folders']>([])
  const [label, setLabel] = useState('')
  const [adding, setAdding] = useState(false)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('')
  const [fingerprint, setFingerprint] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const formStamp = useRef(0)

  useEffect(() => {
    let cancel = false
    void (async () => {
      try {
        const response = await agentControlFetch('/api/v1/ac/personal/ssh', { cache: 'no-store' })
        const body: unknown = await response.json()
        if (!response.ok) throw new Error('SSH_UNAVAILABLE')
        const parsed = sshStatusSchema.parse(body)
        if (cancel) return
        setPublicKey(parsed.publicKey)
        setHosts(parsed.hosts)
      } catch {
        if (!cancel) setLoadError('Não foi possível ler os servidores.')
      }
    })()
    return () => { cancel = true }
  }, [])

  useEffect(() => {
    if (!hostId || !path) return
    let cancel = false
    void (async () => {
      try {
        const params = new URLSearchParams({ host: hostId, path })
        const response = await agentControlFetch(`/api/v1/ac/personal/ssh/folders?${params}`, { cache: 'no-store' })
        const body: unknown = await response.json()
        if (!response.ok) throw new Error('FOLDERS_UNAVAILABLE')
        const parsed = remoteListingSchema.parse(body)
        if (cancel || parsed.host !== hostId) return
        setFolders(parsed.folders)
        setLoadError('')
      } catch {
        if (!cancel) setLoadError('Não foi possível ler as pastas.')
      }
    })()
    return () => { cancel = true }
  }, [hostId, path])

  const selected = hosts?.find((item) => item.id === hostId)
  const parts = path.split('/').filter(Boolean)
  const folderName = parts.at(-1) ?? ''

  function openHost(item: z.infer<typeof hostSchema>) {
    setHostId(item.id)
    setPath(`/home/${item.user}`)
    setFolders([])
    setLabel('')
    setError('')
    setLoadError('')
  }

  function draft() {
    const name = host.trim()
    const login = user.trim()
    const number = Number(port)
    if (!name || !login || !Number.isInteger(number) || number < 1 || number > 65535) {
      setError('Host, porta ou usuário não servem.')
      return null
    }
    setError('')
    return { host: name, port: number, user: login }
  }

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(publicKey)
      setNotice('Chave copiada.')
      setError('')
    } catch {
      setError('Não consegui copiar. Selecione a chave.')
    }
  }

  async function scan() {
    const parsed = draft()
    if (!parsed || busy) return
    const stamp = formStamp.current
    setBusy(true)
    setError('')
    setNotice('')
    setFingerprint('')
    try {
      const response = await agentControlFetch('/api/v1/ac/personal/ssh/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      })
      const body: unknown = await response.json()
      if (formStamp.current !== stamp) return
      if (!response.ok) {
        setError(remoteError(errorCode(body)))
        return
      }
      setFingerprint(z.object({ fingerprint: z.string() }).parse(body).fingerprint)
    } catch {
      setError('Não foi possível continuar.')
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    const parsed = draft()
    if (!parsed || !fingerprint || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    const serverLabel = (parsed.port === 22 ? `${parsed.user}@${parsed.host}` : `${parsed.user}@${parsed.host}:${parsed.port}`).slice(0, 200)
    try {
      const response = await agentControlFetch('/api/v1/ac/personal/ssh/hosts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...parsed, label: serverLabel, fingerprint }),
      })
      const body: unknown = await response.json()
      if (!response.ok) {
        setError(remoteError(errorCode(body)))
        return
      }
      const saved = hostSchema.parse(body)
      setHosts((current) => [...(current ?? []).filter((item) => item.id !== saved.id), saved])
      setAdding(false)
      setHost('')
      setPort('22')
      setUser('')
      setFingerprint('')
      openHost(saved)
    } catch {
      setError('Não foi possível continuar.')
    } finally {
      setBusy(false)
    }
  }

  async function create() {
    const name = label.trim()
    if (!hostId || !path || path === '/' || !name || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await agentControlFetch('/api/v1/ac/personal/ssh/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: hostId, path, label: name }),
      })
      const body: unknown = await response.json()
      if (!response.ok) {
        setError(remoteError(errorCode(body)))
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

  return (
    <>
      <p>Adicione esta chave ao `~/.ssh/authorized_keys` do usuário no outro servidor</p>
      {publicKey ? <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">{publicKey}</pre> : null}
      <Button type="button" variant="outline" className="min-h-11 w-fit" disabled={!publicKey || busy} onClick={() => { void copyKey() }}>Copiar</Button>
      {hosts ? (
        <ul className="flex flex-col gap-1">
          {hosts.map((item) => (
            <li key={item.id}>
              <button type="button" className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted ${item.id === hostId ? 'bg-muted' : ''}`} onClick={() => openHost(item)}>
                <span className="truncate">{item.label}</span>
                <span className="truncate text-muted-foreground">{item.user}@{item.host}:{item.port}</span>
              </button>
            </li>
          ))}
          {hosts.length === 0 ? <li className="text-muted-foreground">Nenhum servidor ainda.</li> : null}
        </ul>
      ) : null}
      <Button type="button" variant="outline" className="min-h-11 w-fit" onClick={() => { setAdding((open) => !open); setFingerprint(''); setError('') }}>Adicionar servidor</Button>
      {adding ? (
        <>
          <label className="flex flex-col gap-1">Host
            <Input aria-label="Host" value={host} maxLength={253} onChange={(event) => { formStamp.current += 1; setHost(event.target.value); setFingerprint('') }} />
          </label>
          <label className="flex flex-col gap-1">Porta
            <Input aria-label="Porta" inputMode="numeric" value={port} maxLength={5} onChange={(event) => { formStamp.current += 1; setPort(event.target.value); setFingerprint('') }} />
          </label>
          <label className="flex flex-col gap-1">Usuário
            <Input aria-label="Usuário" value={user} maxLength={32} onChange={(event) => { formStamp.current += 1; setUser(event.target.value); setFingerprint('') }} />
          </label>
          <Button type="button" variant="outline" className="min-h-11 w-fit" disabled={busy} onClick={() => { void scan() }}>Conferir identidade</Button>
          {fingerprint ? <p className="break-all">Identidade: {fingerprint}</p> : null}
          {fingerprint ? <Button type="button" className="min-h-11 w-fit" disabled={busy} onClick={() => { void confirm() }}>Confirmar</Button> : null}
        </>
      ) : null}
      {selected ? (
        <p className="flex flex-wrap gap-1">
          <button type="button" className="underline" onClick={() => setPath(`/home/${selected.user}`)}>{selected.label}</button>
          {parts.map((part, index) => {
            const next = `/${parts.slice(0, index + 1).join('/')}`
            return <button key={next} type="button" className="underline" onClick={() => { if (next !== '/') setPath(next) }}>/ {part}</button>
          })}
        </p>
      ) : null}
      {loadError ? <p role="alert">{loadError}</p> : null}
      {selected ? (
        <ul className="flex flex-col gap-1">
          {folders.map((folder) => (
            <li key={folder.path}>
              <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted" onClick={() => setPath(folder.path)}>
                <span className="truncate">{folder.name}</span>
                {folder.git ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">Git</span> : null}
              </button>
            </li>
          ))}
          {folders.length === 0 ? <li className="text-muted-foreground">Nenhuma pasta aqui.</li> : null}
        </ul>
      ) : null}
      <Button type="button" variant="outline" className="min-h-11 w-fit" disabled={!selected || busy} onClick={() => setLabel(folderName)}>Usar esta pasta</Button>
      <label className="flex flex-col gap-1">Nome
        <Input aria-label="Nome do projeto" value={label} maxLength={200} onChange={(event) => setLabel(event.target.value)} />
      </label>
      <Button type="button" className="min-h-11 w-fit" disabled={!selected || !path || path === '/' || !label.trim() || busy} onClick={() => { void create() }}>Criar</Button>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
  )
}

export function NovoProjetoRoute() {
  const managed = import.meta.env.VITE_AGENT_CONTROL_MANAGED === '1'
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [place, setPlace] = useState<'local' | 'remote'>('local')
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

  const selector = managed ? (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant={place === 'local' ? 'primary' : 'outline'} className="min-h-11" onClick={() => setPlace('local')}>Neste servidor</Button>
      <Button type="button" variant={place === 'remote' ? 'primary' : 'outline'} className="min-h-11" onClick={() => setPlace('remote')}>Outro servidor (SSH)</Button>
    </div>
  ) : null

  if (managed && place === 'remote') {
    return (
      <div data-route="novo-projeto" className="flex flex-col gap-3 px-3 py-4 text-sm">
        <h1 className="text-lg font-medium">Novo projeto</h1>
        {selector}
        <RemoteServerProject />
      </div>
    )
  }

  if (roots && roots.length === 0) {
    return (
      <div data-route="novo-projeto" className="flex flex-col gap-3 px-3 py-4 text-sm">
        <h1 className="text-lg font-medium">Novo projeto</h1>
        {selector}
        <p>Nenhuma pasta foi liberada. No servidor:</p>
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">npm run personal:roots -- &lt;instalação.json&gt; add &lt;pasta&gt;</pre>
      </div>
    )
  }

  return (
    <div data-route="novo-projeto" className="flex flex-col gap-3 px-3 py-4 text-sm">
      <h1 className="text-lg font-medium">Novo projeto</h1>
      {selector}
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
