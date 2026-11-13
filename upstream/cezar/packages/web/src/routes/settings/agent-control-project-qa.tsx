import { useEffect, useState } from 'react'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { agentControlFetch } from './agent-control-fetch'
import { SettingsField } from './settings-field'

const IMAGES = ['postgres:15-alpine', 'postgres:16-alpine', 'postgres:17-alpine'] as const

const configSchema = z.object({
  prepare: z.array(z.string()).optional(),
  test: z.array(z.string()),
  timeoutSeconds: z.number(),
  services: z
    .object({
      postgres: z.object({
        image: z.enum(IMAGES),
        database: z.string(),
      }),
    })
    .optional(),
})

const loadedSchema = z.object({ config: configSchema.nullable() })
const savedSchema = loadedSchema.extend({ appliesOnRestart: z.literal(true) })
const restartSchema = z.object({ restarting: z.boolean(), restartRequired: z.boolean() })

function linesToArgv(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

function qaError(code: string): string {
  if (code === 'QA_CONFIG_NOT_A_LIST') return 'Preparo e teste são uma lista de argumentos, um por linha.'
  if (code === 'QA_COMMAND_NOT_ALLOWED') return 'O primeiro argumento precisa ser npm, npx, pnpm, corepack, yarn, node, make ou sh.'
  if (code === 'QA_TIMEOUT_OUT_OF_RANGE') return 'O tempo fica entre 30 e 1800 segundos.'
  if (code === 'QA_CONFIG_TEST_REQUIRED') return 'O teste é obrigatório.'
  if (code === 'QA_SERVICES_INVALID') return 'O banco de teste precisa de uma imagem Postgres permitida e um nome de banco.'
  if (code === 'PROJECT_OWNER_REQUIRED') return 'Só o dono da instalação pode alterar o QA.'
  return 'A configuração não é válida.'
}

/** Project QA for the selected project. Same file the CLI `personal:qa` writes. Applies on the next gateway start. */
export function AgentControlProjectQa() {
  const [prepare, setPrepare] = useState('')
  const [test, setTest] = useState('')
  const [timeoutSeconds, setTimeoutSeconds] = useState('600')
  const [usePostgres, setUsePostgres] = useState(false)
  const [image, setImage] = useState<(typeof IMAGES)[number]>('postgres:16-alpine')
  const [database, setDatabase] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancel = false
    void (async () => {
      try {
        const response = await agentControlFetch('/api/v1/ac/personal/qa')
        const body: unknown = await response.json()
        if (!response.ok) {
          const code = z.object({ error: z.string() }).safeParse(body)
          if (!cancel) setError(qaError(code.success ? code.data.error : ''))
          return
        }
        const parsed = loadedSchema.parse(body)
        if (cancel || !parsed.config) return
        setPrepare(parsed.config.prepare?.join('\n') ?? '')
        setTest(parsed.config.test.join('\n'))
        setTimeoutSeconds(String(parsed.config.timeoutSeconds))
        if (parsed.config.services?.postgres) {
          setUsePostgres(true)
          setImage(parsed.config.services.postgres.image)
          setDatabase(parsed.config.services.postgres.database)
        }
      } catch {
        if (!cancel) setError('Não foi possível ler o QA do projeto.')
      } finally {
        if (!cancel) setLoaded(true)
      }
    })()
    return () => {
      cancel = true
    }
  }, [])

  async function save() {
    setBusy(true)
    setError('')
    setNotice('')
    const timeout = Number(timeoutSeconds)
    const testArgv = linesToArgv(test)
    if (!Number.isInteger(timeout)) {
      setError(qaError('QA_TIMEOUT_OUT_OF_RANGE'))
      setBusy(false)
      return
    }
    if (testArgv.length === 0) {
      setError(qaError('QA_CONFIG_TEST_REQUIRED'))
      setBusy(false)
      return
    }
    const prepareArgv = linesToArgv(prepare)
    const body: Record<string, unknown> = { test: testArgv, timeoutSeconds: timeout }
    if (prepareArgv.length > 0) body.prepare = prepareArgv
    if (usePostgres) body.services = { postgres: { image, database: database.trim() } }
    try {
      const response = await agentControlFetch('/api/v1/ac/personal/qa', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const value: unknown = await response.json()
      if (!response.ok) {
        const code = z.object({ error: z.string() }).safeParse(value)
        setError(qaError(code.success ? code.data.error : ''))
        return
      }
      savedSchema.parse(value)
      setNotice('Vale no próximo reinício do gateway.')
    } catch {
      setError('Não foi possível gravar o QA do projeto.')
    } finally {
      setBusy(false)
    }
  }

  async function restart() {
    setBusy(true)
    setError('')
    try {
      const response = await agentControlFetch('/api/v1/ac/personal/qa/restart', { method: 'POST' })
      const value: unknown = await response.json()
      if (!response.ok) {
        const code = z.object({ error: z.string() }).safeParse(value)
        setError(qaError(code.success ? code.data.error : ''))
        return
      }
      const parsed = restartSchema.parse(value)
      setNotice(parsed.restarting ? 'Reiniciando o painel…' : 'Reinicie o gateway para o QA valer.')
    } catch {
      setError('Não foi possível reiniciar o gateway.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <SettingsField title="Preparo" hint="Opcional. Um argumento por linha. O primeiro é npm, npx, pnpm, corepack, yarn, node, make ou sh.">
        <Textarea value={prepare} onChange={(event) => setPrepare(event.target.value)} disabled={!loaded || busy} spellCheck={false} className="font-mono" aria-label="Preparo" />
      </SettingsField>
      <SettingsField title="Teste" hint="Obrigatório. Um argumento por linha, sem texto de shell.">
        <Textarea value={test} onChange={(event) => setTest(event.target.value)} disabled={!loaded || busy} spellCheck={false} className="font-mono" aria-label="Teste" />
      </SettingsField>
      <SettingsField title="Tempo" hint="Segundos, de 30 a 1800.">
        <Input type="number" min={30} max={1800} step={1} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(event.target.value)} disabled={!loaded || busy} aria-label="Tempo em segundos" className="w-32" />
      </SettingsField>
      <SettingsField title="Banco de teste" hint="PostgreSQL efêmero. A imagem é postgres:15-alpine, postgres:16-alpine ou postgres:17-alpine.">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={usePostgres} onChange={(event) => setUsePostgres(event.target.checked)} disabled={!loaded || busy} />
          Usar PostgreSQL
        </label>
        {usePostgres ? (
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="Imagem do Postgres"
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              value={image}
              disabled={busy}
              onChange={(event) => setImage(event.target.value as (typeof IMAGES)[number])}
            >
              {IMAGES.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <Input aria-label="Nome do banco" value={database} onChange={(event) => setDatabase(event.target.value)} disabled={busy} placeholder="qa_test" className="w-48" spellCheck={false} />
          </div>
        ) : null}
      </SettingsField>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" className="min-h-11 w-fit" disabled={!loaded || busy} onClick={() => { void save() }}>Gravar</Button>
        {notice ? (
          <Button type="button" variant="outline" className="min-h-11 w-fit" disabled={busy} onClick={() => { void restart() }}>Reiniciar agora</Button>
        ) : null}
      </div>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}
