import { useEffect, useState } from 'react'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { agentControlFetch } from './settings/agent-control-fetch'

const providers = ['claude', 'grok', 'codex'] as const
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const effortLabel: Record<(typeof efforts)[number], string> = {
  low: 'baixo',
  medium: 'médio',
  high: 'alto',
  xhigh: 'xhigh',
  max: 'max',
}

const reserveSchema = z.object({
  provider: z.enum(providers),
  model: z.string().min(1),
  effort: z.enum(efforts),
})
const slotSchema = z.object({
  provider: z.enum(providers),
  model: z.string().min(1),
  effort: z.enum(efforts),
  count: z.number().int().min(1).max(10),
  reserve: reserveSchema.optional(),
})
type Slot = z.infer<typeof slotSchema>
type Reserve = z.infer<typeof reserveSchema>
const comboSchema = z.object({
  name: z.string(),
  roles: z.object({
    manager: slotSchema,
    reviewer: slotSchema,
    qa: slotSchema.optional(),
    programmer: z.object({
      standard: z.array(slotSchema).min(1),
      basic: z.array(slotSchema).optional(),
    }),
  }),
})
type Combo = z.infer<typeof comboSchema>
const listSchema = z.object({ current: z.string().nullable(), combos: z.array(comboSchema) })

function blankReserve(provider: Slot['provider']): Reserve {
  return { provider: provider === 'grok' ? 'codex' : 'grok', model: '', effort: 'medium' }
}

function blank(provider: Slot['provider'] = 'grok'): Slot {
  return { provider, model: '', effort: 'medium', count: 1, reserve: blankReserve(provider) }
}

function withReserve(slot: Slot): Slot {
  return slot.reserve ? slot : { ...slot, reserve: blankReserve(slot.provider) }
}

function draftFrom(combo?: Combo): Combo {
  return combo ?? {
    name: '',
    roles: { manager: blank('claude'), reviewer: blank('claude'), programmer: { standard: [blank()] } },
  }
}

function applyError(code: string): string {
  if (code === 'CODEX_ACCOUNT_REQUIRED') return 'Falta uma conta Codex ativa. Nada foi alterado.'
  if (code === 'CLAUDE_ACCOUNT_REQUIRED') return 'Falta uma conta Claude ativa. Nada foi alterado.'
  if (code === 'GROK_ACCOUNT_REQUIRED') return 'Falta uma conta Grok ativa. Nada foi alterado.'
  if (code === 'COMBO_NOT_FOUND') return 'Combo não encontrado.'
  if (code === 'COMBO_NAME_AMBIGUOUS') return 'Há mais de um combo com esse nome.'
  if (code === 'COMBO_TOO_MANY_PROGRAMMERS') return 'A soma dos programadores passa de 10.'
  if (code === 'COMBO_MINIMUM_REQUIRED') return 'Um combo precisa de pelo menos 3 programadores e de reserva no gerente, no revisor e nos programadores.'
  if (code === 'PROJECT_OWNER_REQUIRED') return 'Só o dono da instalação pode mudar a equipe.'
  if (code === 'COMBOS_FILE_INVALID') return 'O arquivo de combos está inválido.'
  if (code === 'COMBO_LIMIT') return 'Já há 40 combos gravados.'
  if (code === 'INVALID_CONTRACT') return 'Preencha papel, provedor, modelo, esforço e quantidade.'
  return 'Não foi possível aplicar o combo.'
}

function SlotFields({ label, value, onChange }: { label: string; value: Slot; onChange: (next: Slot) => void }) {
  const reserve = value.reserve ?? blankReserve(value.provider)
  const setReserve = (next: Reserve) => onChange({ ...value, reserve: next })
  return (
    <fieldset className="grid gap-2 rounded-md border border-input p-2">
      <legend className="px-1">{label}</legend>
      <label className="flex flex-col gap-1">Provedor
        <select aria-label={`${label} provedor`} className="h-11 rounded-md border border-input bg-card px-2" value={value.provider} onChange={(event) => onChange({ ...value, provider: event.target.value as Slot['provider'] })}>
          {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">Modelo
        <Input aria-label={`${label} modelo`} value={value.model} onChange={(event) => onChange({ ...value, model: event.target.value })} />
      </label>
      <label className="flex flex-col gap-1">Esforço
        <select aria-label={`${label} esforço`} className="h-11 rounded-md border border-input bg-card px-2" value={value.effort} onChange={(event) => onChange({ ...value, effort: event.target.value as Slot['effort'] })}>
          {efforts.map((effort) => <option key={effort} value={effort}>{effortLabel[effort]}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">Quantidade
        <Input aria-label={`${label} quantidade`} type="number" min={1} max={10} value={value.count} onChange={(event) => onChange({ ...value, count: Number(event.target.value) })} />
      </label>
      <fieldset className="grid gap-2 rounded-md border border-input p-2">
        <legend className="px-1">Reserva</legend>
        <label className="flex flex-col gap-1">Provedor
          <select aria-label={`${label} reserva provedor`} className="h-11 rounded-md border border-input bg-card px-2" value={reserve.provider} onChange={(event) => setReserve({ ...reserve, provider: event.target.value as Reserve['provider'] })}>
            {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">Modelo
          <Input aria-label={`${label} reserva modelo`} value={reserve.model} onChange={(event) => setReserve({ ...reserve, model: event.target.value })} />
        </label>
        <label className="flex flex-col gap-1">Esforço
          <select aria-label={`${label} reserva esforço`} className="h-11 rounded-md border border-input bg-card px-2" value={reserve.effort} onChange={(event) => setReserve({ ...reserve, effort: event.target.value as Reserve['effort'] })}>
            {efforts.map((effort) => <option key={effort} value={effort}>{effortLabel[effort]}</option>)}
          </select>
        </label>
      </fieldset>
    </fieldset>
  )
}

function line(slot: Slot): string {
  const base = `${slot.count} × ${slot.model} ${effortLabel[slot.effort]} (${slot.provider})`
  return slot.reserve ? `${base}; reserva: ${slot.reserve.model} ${effortLabel[slot.reserve.effort]} (${slot.reserve.provider})` : base
}

const accountsSchema = z.object({
  accounts: z.array(z.object({
    id: z.string(),
    provider: z.string(),
    label: z.string(),
    exhaustedUntil: z.string().nullable(),
    login: z.string().nullable(),
  })),
})
type Account = z.infer<typeof accountsSchema>['accounts'][number]

function untilText(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** Each account's quota pause and login, with a button that ends a pause now. */
function AccountsSection() {
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  async function load() {
    const response = await agentControlFetch('/api/v1/ac/personal/accounts', { cache: 'no-store' })
    if (!response.ok) throw new Error('ACCOUNTS_UNAVAILABLE')
    setAccounts(accountsSchema.parse(await response.json()).accounts)
  }

  useEffect(() => {
    let cancel = false
    const refresh = () => { load().catch(() => { if (!cancel) setError('Não foi possível ler as contas.') }) }
    refresh()
    const timer = setInterval(refresh, 30_000)
    return () => { cancel = true; clearInterval(timer) }
  }, [])

  async function release(account: Account) {
    if (busy) return
    setBusy(account.id)
    setError('')
    try {
      const response = await agentControlFetch(`/api/v1/ac/personal/accounts/${account.id}/release`, { method: 'POST' })
      if (!response.ok) throw new Error('RELEASE_FAILED')
      await load()
    } catch {
      setError('Não foi possível liberar a conta.')
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="flex flex-col gap-2" aria-label="Contas">
      <h2 className="font-medium">Contas</h2>
      {error ? <p role="alert">{error}</p> : null}
      {accounts === null && !error ? <p>Carregando…</p> : null}
      <ul className="flex flex-col gap-2">
        {(accounts ?? []).map((account) => (
          <li key={account.id} className="flex flex-col gap-1 rounded-md border border-input p-2">
            <div className="flex flex-wrap items-center gap-2">
              <strong>{account.label}</strong>
              <span className="text-xs text-muted-foreground">{account.provider}</span>
              {account.exhaustedUntil
                ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">sem cota até {untilText(account.exhaustedUntil)}</span>
                : <span className="rounded-full bg-muted px-2 py-0.5 text-xs">disponível</span>}
            </div>
            {account.exhaustedUntil ? (
              <div className="flex flex-wrap items-center gap-2">
                <p>A reserva do combo assume os papéis desta conta até lá.</p>
                <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void release(account)}>Liberar agora</Button>
              </div>
            ) : null}
            {account.login ? <p role="status">{account.login}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Managed team screen. Lists combos, marks the project's current one, and edits owner combos. */
export function EquipeRoute() {
  const [current, setCurrent] = useState<string | null>(null)
  const [combos, setCombos] = useState<Combo[]>([])
  const [draft, setDraft] = useState<Combo>(() => draftFrom())
  const [qaOn, setQaOn] = useState(false)
  const [basicOn, setBasicOn] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function reload() {
    const response = await agentControlFetch('/api/v1/ac/personal/combos', { cache: 'no-store' })
    const body: unknown = await response.json()
    if (!response.ok) {
      const code = z.object({ error: z.string() }).safeParse(body)
      throw new Error(code.success ? code.data.error : 'COMBOS_UNAVAILABLE')
    }
    const parsed = listSchema.parse(body)
    setCombos(parsed.combos)
    setCurrent(parsed.current)
  }

  useEffect(() => {
    let cancel = false
    void (async () => {
      try {
        const response = await agentControlFetch('/api/v1/ac/personal/combos', { cache: 'no-store' })
        const body: unknown = await response.json()
        if (cancel) return
        if (!response.ok) {
          const code = z.object({ error: z.string() }).safeParse(body)
          setError(applyError(code.success ? code.data.error : ''))
          return
        }
        const parsed = listSchema.parse(body)
        setCombos(parsed.combos)
        setCurrent(parsed.current)
      } catch {
        if (!cancel) setError('Não foi possível ler os combos.')
      }
    })()
    return () => { cancel = true }
  }, [])

  function load(combo: Combo) {
    setDraft({
      ...combo,
      roles: {
        ...combo.roles,
        manager: withReserve(combo.roles.manager),
        reviewer: withReserve(combo.roles.reviewer),
        programmer: {
          standard: combo.roles.programmer.standard.map(withReserve),
          ...(combo.roles.programmer.basic?.length ? { basic: combo.roles.programmer.basic.map(withReserve) } : {}),
        },
        ...(combo.roles.qa ? { qa: withReserve(combo.roles.qa) } : {}),
      },
    })
    setQaOn(Boolean(combo.roles.qa))
    setBasicOn(Boolean(combo.roles.programmer.basic?.length))
    setError('')
    setNotice('')
  }

  async function apply(name: string) {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await agentControlFetch('/api/v1/ac/personal/combos/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const body: unknown = await response.json()
      if (!response.ok) {
        const code = z.object({ error: z.string() }).safeParse(body)
        setError(applyError(code.success ? code.data.error : ''))
        return
      }
      await reload()
      setNotice(`Combo ${name} em uso.`)
    } catch {
      setError('Não foi possível aplicar o combo.')
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    if (busy) return
    const combo: Combo = {
      name: draft.name.trim(),
      roles: {
        manager: draft.roles.manager,
        reviewer: draft.roles.reviewer,
        programmer: {
          standard: draft.roles.programmer.standard,
          ...(basicOn && draft.roles.programmer.basic?.length ? { basic: draft.roles.programmer.basic } : {}),
        },
        ...(qaOn && draft.roles.qa ? { qa: draft.roles.qa } : {}),
      },
    }
    const parsed = comboSchema.safeParse(combo)
    if (!parsed.success) {
      setError(applyError('INVALID_CONTRACT'))
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await agentControlFetch('/api/v1/ac/personal/combos', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
      })
      const body: unknown = await response.json()
      if (!response.ok) {
        const code = z.object({ error: z.string() }).safeParse(body)
        setError(applyError(code.success ? code.data.error : ''))
        return
      }
      await reload()
      setNotice(`Combo ${parsed.data.name} gravado.`)
    } catch {
      setError('Não foi possível gravar o combo.')
    } finally {
      setBusy(false)
    }
  }

  const standard = draft.roles.programmer.standard
  const basicSlot = draft.roles.programmer.basic?.[0] ?? blank()
  const qa = draft.roles.qa ?? blank('claude')
  function setBasic(next: Slot) {
    setDraft({ ...draft, roles: { ...draft.roles, programmer: { ...draft.roles.programmer, basic: [next] } } })
  }

  return (
    <div data-route="equipe" className="flex flex-col gap-4 px-3 py-4 text-sm">
      <h1 className="text-lg font-medium">Equipe</h1>
      <p>Combo atual: {current ?? 'nenhum'}</p>
      <AccountsSection />
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p>{notice}</p> : null}
      <ul className="flex flex-col gap-2">
        {combos.map((combo) => (
          <li key={combo.name} className="flex flex-col gap-1 rounded-md border border-input p-2">
            <div className="flex flex-wrap items-center gap-2">
              <strong>{combo.name}</strong>
              {combo.name === current ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">em uso</span> : null}
              <Button type="button" disabled={busy} onClick={() => void apply(combo.name)}>Usar este</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => load(combo)}>Alterar</Button>
            </div>
            <p>Gerente: {line(combo.roles.manager)}</p>
            <p>Revisor: {line(combo.roles.reviewer)}</p>
            <p>Programadores: {combo.roles.programmer.standard.map(line).join(', ')}</p>
            {combo.roles.programmer.basic?.length ? <p>Básicos: {combo.roles.programmer.basic.map(line).join(', ')}</p> : null}
            <p>QA: {combo.roles.qa ? line(combo.roles.qa) : 'script do projeto'}</p>
          </li>
        ))}
      </ul>
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <h2 className="font-medium">Criar ou alterar</h2>
        <label className="flex flex-col gap-1">Nome
          <Input aria-label="Nome do combo" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <SlotFields label="Gerente" value={draft.roles.manager} onChange={(manager) => setDraft({ ...draft, roles: { ...draft.roles, manager } })} />
        <SlotFields label="Revisor" value={draft.roles.reviewer} onChange={(reviewer) => setDraft({ ...draft, roles: { ...draft.roles, reviewer } })} />
        {standard.map((slot, index) => (
          <SlotFields key={`standard-${index}`} label={`Programador padrão ${index + 1}`} value={slot} onChange={(next) => {
            const copy = [...standard]
            copy[index] = next
            setDraft({ ...draft, roles: { ...draft.roles, programmer: { ...draft.roles.programmer, standard: copy } } })
          }} />
        ))}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={basicOn} onChange={(event) => {
            setBasicOn(event.target.checked)
            if (event.target.checked && !draft.roles.programmer.basic?.length) {
              setDraft({ ...draft, roles: { ...draft.roles, programmer: { ...draft.roles.programmer, basic: [blank()] } } })
            }
          }} />
          Programador básico
        </label>
        {basicOn ? <SlotFields label="Programador básico" value={basicSlot} onChange={setBasic} /> : null}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={qaOn} onChange={(event) => {
            setQaOn(event.target.checked)
            if (event.target.checked && !draft.roles.qa) setDraft({ ...draft, roles: { ...draft.roles, qa } })
          }} />
          QA com modelo
        </label>
        {qaOn ? <SlotFields label="QA" value={qa} onChange={(next) => setDraft({ ...draft, roles: { ...draft.roles, qa: next } })} /> : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>Guardar</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => load(draftFrom())}>Novo</Button>
        </div>
      </form>
    </div>
  )
}
