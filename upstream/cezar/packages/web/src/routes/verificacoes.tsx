import { useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { z } from 'zod'

import { Link } from '@/lib/project-router'
import { AchadoCorrecao } from './verificacao-achado'
import { agentControlFetch } from './settings/agent-control-fetch'

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

type Summary = z.infer<typeof summarySchema>
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

function VerificacoesLista() {
  const [items, setItems] = useState<Summary[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancel = false
    agentControlFetch('/api/v1/ac/personal/verificacoes', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('UNAVAILABLE')
        const body = listSchema.parse(await response.json())
        if (!cancel) setItems(body.verificacoes)
      })
      .catch(() => { if (!cancel) setError('Não foi possível ler as verificações.') })
    return () => { cancel = true }
  }, [])

  return (
    <div data-route="verificacoes" className="flex flex-col gap-4 px-3 py-4 text-sm">
      <h1 className="text-lg font-medium">Verificações</h1>
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
  const { runId } = useParams()
  return runId ? <VerificacaoDetalhe runId={runId} /> : <VerificacoesLista />
}
