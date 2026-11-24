import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { z } from 'zod'

import { Link } from '@/lib/project-router'
import { AchadoCorrecao } from './verificacao-achado'
import { agentControlFetch } from './settings/agent-control-fetch'
import { labelPhase, ModulosAndamento } from './verificacoes-modulos'

const summarySchema = z.object({
  id: z.string().uuid(),
  directoryName: z.string(),
  createdAt: z.string(),
  counts: z.object({
    alta: z.number(),
    media: z.number(),
    baixa: z.number(),
    informativa: z.number(),
  }),
  note: z.string(),
})
const listSchema = z.object({ verificacoes: z.array(summarySchema) })
const functionalReportsUrl = '/api/v1/ac/personal/verificacoes-funcionais'
const moduleLabels = {
  qa: 'QA', arquitetura: 'Arquitetura', dependencias: 'Dependências', banco: 'Banco de dados',
  prontidao: 'Prontidão', desempenho: 'Desempenho', documentacao: 'Documentação', conformidade: 'Conformidade',
}
const moduleKeys = Object.keys(moduleLabels) as (keyof typeof moduleLabels)[]
const functionalSummarySchema = summarySchema.pick({ id: true, counts: true }).extend({
  module: z.enum(moduleKeys),
  createdAt: z.iso.datetime().nullable(),
  toolFailures: z.number().int().nonnegative(),
})
const functionalListSchema = z.object({ verificacoes: z.array(functionalSummarySchema) })
const achadoSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(['alta', 'media', 'baixa', 'informativa']),
  status: z.enum(['confirmado', 'provavel', 'descartado', 'fechado', 'reaberto']),
  where: z.object({
    file: z.string(),
    line: z.number().int().nullable().optional(),
  }),
})
const detailSchema = z.object({
  resumo: summarySchema,
  achados: z.array(achadoSchema),
  cobertura: z.string(),
})
const functionalDetailSchema = detailSchema.extend({
  resumo: functionalSummarySchema,
  achados: z.array(achadoSchema.extend({ proof: z.string() })),
})
const progressSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  phase: z.string().min(1),
  judged: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  modelCalls: z.number().int().nonnegative().optional(),
})
const progressListSchema = z.object({
  runs: z.array(progressSchema),
})

type Summary = z.infer<typeof summarySchema>
type Progress = z.infer<typeof progressSchema>
type Achado = z.infer<typeof achadoSchema>

const severityLabel: Record<Achado['severity'], string> = {
  alta: 'alta',
  media: 'média',
  baixa: 'baixa',
  informativa: 'informativa',
}
const statusLabel: Record<Achado['status'], string> = {
  confirmado: 'confirmado',
  provavel: 'provável',
  descartado: 'descartado',
  fechado: 'fechado',
  reaberto: 'reaberto',
}
const runStatusLabel: Record<string, string> = {
  running: 'em andamento',
  done: 'concluída',
  incomplete: 'incompleta: arquivos ficaram sem julgamento',
  failed: 'falhou',
}

function when(createdAt: string, directoryName: string): string {
  const parsed = new Date(createdAt)
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(directoryName)
  if (!match) return createdAt
  return `${match[3]}/${match[2]}/${match[1]} ${match[4]}:${match[5]}`
}

function fileOf(achado: Achado): string {
  return achado.where.line ? `${achado.where.file}:${achado.where.line}` : achado.where.file
}

function FunctionalReports() {
  const [module, setModule] = useState('')
  return (
    <section className="flex flex-col gap-2" aria-labelledby="functional-reports-heading">
      <h2 id="functional-reports-heading" className="font-semibold">Relatórios funcionais</h2>
      <label className="flex items-center gap-2 self-start">
        Módulo
        <select className="rounded-md border border-input px-2 py-1" value={module} onChange={(event) => setModule(event.target.value)}>
          <option value="">Todos</option>
          {Object.entries(moduleLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <FunctionalReportList key={module} module={module} />
    </section>
  )
}

function FunctionalReportList({ module }: { module: string }) {
  const [items, setItems] = useState<z.infer<typeof functionalSummarySchema>[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const request = new AbortController()
    const url = module ? `${functionalReportsUrl}?modulo=${encodeURIComponent(module)}` : functionalReportsUrl
    agentControlFetch(url, { cache: 'no-store', signal: request.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('UNAVAILABLE')
        const body = functionalListSchema.parse(await response.json())
        if (!request.signal.aborted) setItems(body.verificacoes)
      })
      .catch(() => { if (!request.signal.aborted) setFailed(true) })
    return () => { request.abort() }
  }, [module])

  if (failed) return <p role="alert">Não foi possível ler os relatórios funcionais.</p>
  if (items === null) return <p>Carregando relatórios funcionais…</p>
  if (!items.length) return <p>Nenhum relatório funcional.</p>
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={`${item.module}/${item.id}`}>
          <Link to={`/verificacoes/${item.id}?modulo=${item.module}`} className="flex flex-col gap-1 rounded-md border border-input p-2">
            <strong>{moduleLabels[item.module]}</strong>
            {item.createdAt ? <time dateTime={item.createdAt}>{when(item.createdAt, '')}</time> : null}
            <span>Achados altos: {item.counts.alta} · Falhas de ferramentas: {item.toolFailures}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function FunctionalReportDetail({ module, runId }: { module: string; runId: string }) {
  const url = `${functionalReportsUrl}/${encodeURIComponent(module)}/${encodeURIComponent(runId)}`
  const [report, setReport] = useState<z.infer<typeof functionalDetailSchema> | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const request = new AbortController()
    agentControlFetch(url, { cache: 'no-store', signal: request.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('UNAVAILABLE')
        const detail = functionalDetailSchema.parse(await response.json())
        if (detail.resumo.id !== runId || detail.resumo.module !== module) throw new Error('REPORT_MISMATCH')
        if (!request.signal.aborted) setReport(detail)
      })
      .catch(() => { if (!request.signal.aborted) setFailed(true) })
    return () => { request.abort() }
  }, [module, runId, url])

  return (
    <div data-route="verificacoes" className="flex flex-col gap-4 px-3 py-4 text-sm">
      <h1 className="text-lg font-medium">{report ? `Verificações · ${moduleLabels[report.resumo.module]}` : 'Verificações'}</h1>
      <Link to="/verificacoes">Voltar</Link>
      {failed ? <p role="alert">Não foi possível ler este relatório funcional.</p> : null}
      {report === null && !failed ? <p>Carregando relatório funcional…</p> : null}
      {report ? (
        <>
          <details>
            <summary className="cursor-pointer font-semibold">Cobertura</summary>
            <pre className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{report.cobertura}</pre>
          </details>
          <AchadoCorrecao
            runId={runId}
            correctionUrl={`${url}/corrigir`}
            achados={report.achados.map((achado) => ({
              id: achado.id, title: achado.title, status: achado.status, file: fileOf(achado),
              details: (
                <details className="ml-5">
                  <summary className="cursor-pointer">Prova de {achado.id} · {severityLabel[achado.severity]}</summary>
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{achado.proof || 'Sem prova registrada.'}</p>
                </details>
              ),
            }))}
          />
        </>
      ) : null}
    </div>
  )
}

function VerificacoesLista({ projectId }: { projectId?: string }) {
  const [items, setItems] = useState<Summary[] | null>(null)
  const [error, setError] = useState('')
  const [startError, setStartError] = useState('')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [starting, setStarting] = useState(false)
  const busy = useRef(false)
  const running = progress?.status === 'running'

  useEffect(() => {
    let cancel = false
    agentControlFetch('/api/v1/ac/personal/verificacoes', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('UNAVAILABLE')
        const body = listSchema.parse(await response.json())
        if (cancel) return
        setItems(body.verificacoes)
        setError('')
      })
      .catch(() => { if (!cancel) setError('Não foi possível ler as verificações.') })
    return () => { cancel = true }
  }, [reloadKey])

  useEffect(() => {
    if (!running) return
    let cancel = false
    const timer = setInterval(() => {
      agentControlFetch('/api/v1/ac/personal/verificacoes/andamento', { cache: 'no-store' })
        .then(async (response) => {
          if (cancel || !response.ok) return
          const body = progressListSchema.parse(await response.json())
          if (cancel) return
          const current = body.runs.find((run) => run.id === progress?.id) ?? body.runs.find((run) => run.status === 'running')
          if (!current) return
          setProgress(current)
          if (current.status === 'done' || current.status === 'incomplete') setReloadKey((key) => key + 1)
        })
        .catch(() => {})
    }, 3000)
    return () => {
      cancel = true
      clearInterval(timer)
    }
  }, [running])

  function start() {
    if (busy.current || running) return
    busy.current = true
    setStarting(true)
    setStartError('')
    agentControlFetch('/api/v1/ac/personal/verificacoes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then(async (response) => {
        if (response.status >= 400) throw new Error('UNAVAILABLE')
        if (response.status !== 202) return
        const body = progressSchema.parse(await response.json())
        setProgress(body)
        if (body.status === 'done' || body.status === 'incomplete') setReloadKey((key) => key + 1)
      })
      .catch(() => { setStartError('Não foi possível iniciar a verificação.') })
      .finally(() => {
        busy.current = false
        setStarting(false)
      })
  }

  return (
    <div data-route="verificacoes" className="flex flex-col gap-4 px-3 py-4 text-sm">
      <h1 className="text-lg font-medium">Verificações</h1>
      <ModulosAndamento key={projectId} projectId={projectId} />
      <h2 className="font-semibold">Segurança da instalação</h2>
      <button
        type="button"
        className="self-start rounded-md border border-input px-2 py-1"
        disabled={starting || running}
        onClick={start}
      >
        Nova verificação
      </button>
      {startError ? <p role="alert">{startError}</p> : null}
      {progress ? <p>Fase: {labelPhase(progress.phase)}. Status: {runStatusLabel[progress.status] ?? progress.status}</p> : null}
      {progress && progress.total !== undefined && progress.judged !== undefined ? (
        <p>
          Arquivos julgados: {progress.judged} de {progress.total}
          {progress.modelCalls !== undefined ? `. Chamadas ao modelo: ${progress.modelCalls}` : ''}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {items === null && !error ? <p>Carregando…</p> : null}
      {items && items.length === 0 ? <p>Nenhuma verificação ainda.</p> : null}
      <ul className="flex flex-col gap-2">
        {items?.map((item) => (
          <li key={item.id}>
            <Link to={`/verificacoes/${item.id}`} className="flex flex-col gap-1 rounded-md border border-input p-2">
              <time dateTime={item.createdAt}>{when(item.createdAt, item.directoryName)}</time>
              <span>Achados altos: {item.counts.alta}</span>
              {item.note ? <span>{item.note}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
      <FunctionalReports key={projectId} />
    </div>
  )
}

function VerificacaoDetalhe({ runId }: { runId: string }) {
  const [resumo, setResumo] = useState<Summary | null>(null)
  const [achados, setAchados] = useState<Achado[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancel = false
    agentControlFetch(`/api/v1/ac/personal/verificacoes/${encodeURIComponent(runId)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('UNAVAILABLE')
        const body = detailSchema.parse(await response.json())
        if (cancel) return
        setResumo(body.resumo)
        setAchados(body.achados)
      })
      .catch(() => { if (!cancel) setError('Não foi possível ler esta verificação.') })
    return () => { cancel = true }
  }, [runId])

  return (
    <div data-route="verificacoes" className="flex flex-col gap-4 px-3 py-4 text-sm">
      <h1 className="text-lg font-medium">Verificações</h1>
      <Link to="/verificacoes">Voltar</Link>
      {error ? <p role="alert">{error}</p> : null}
      {achados === null && !error ? <p>Carregando…</p> : null}
      {resumo ? (
        <p>
          <time dateTime={resumo.createdAt}>{when(resumo.createdAt, resumo.directoryName)}</time>
          {' · '}Achados altos: {resumo.counts.alta}
          {resumo.note ? ` · ${resumo.note}` : ''}
        </p>
      ) : null}
      {achados && achados.length === 0 ? <p>Nenhum achado.</p> : null}
      {achados ? (
        <AchadoCorrecao
          runId={runId}
          achados={achados.map((achado) => ({ id: achado.id, title: achado.title, status: achado.status, file: achado.where.file }))}
        />
      ) : null}
      <ul className="flex flex-col gap-2">
        {achados?.map((achado) => (
          <li key={achado.id} className="flex flex-col gap-1 rounded-md border border-input p-2">
            <strong>{achado.title}</strong>
            <span>Gravidade: {severityLabel[achado.severity]}</span>
            <span>Situação: {statusLabel[achado.status]}</span>
            <span>Arquivo: {fileOf(achado)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function VerificacoesRoute() {
  const { runId, projectId } = useParams()
  const [search] = useSearchParams()
  const module = search.get('modulo')
  if (runId && module && Object.hasOwn(moduleLabels, module)) return <FunctionalReportDetail key={`${projectId}/${module}/${runId}`} module={module} runId={runId} />
  return runId ? <VerificacaoDetalhe key={`${projectId}/${runId}`} runId={runId} /> : <VerificacoesLista projectId={projectId} />
}
