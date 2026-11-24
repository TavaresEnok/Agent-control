import { useEffect, useState } from 'react'
import { z } from 'zod'

import { agentControlFetch } from './settings/agent-control-fetch'

export const modulesUrl = '/api/v1/ac/personal/verificacoes-modulos'
/** Intervalo da atualização enquanto a aba está visível. */
export const MODULES_REFRESH_MS = 15_000

const moduleLabels: Record<string, string> = {
  seguranca: 'Segurança', qa: 'QA', arquitetura: 'Arquitetura', dependencias: 'Dependências', banco: 'Banco de dados',
  prontidao: 'Prontidão', desempenho: 'Desempenho', documentacao: 'Documentação', conformidade: 'Conformidade', design: 'Design',
}
const phaseLabel: Record<string, string> = {
  ferramentas: 'ferramentas', mapa: 'mapa', exame: 'exame', confirmacao: 'confirmação', relatorio: 'relatório',
  done: 'concluída', failed: 'falhou',
}
const situationLabel = { concluida: 'concluída', 'com-falhas': 'com falhas de ferramenta', parcial: 'parcial' }

export function labelPhase(phase: string): string {
  return phaseLabel[phase] ?? phase
}

const count = z.number().int().nonnegative()
const moduleSchema = z.object({
  modulo: z.string().min(1),
  atual: z.object({
    runId: z.string(),
    phase: z.string().nullable(),
    startedAt: z.string(),
    elapsedMs: count,
    judged: count.nullable(),
    total: count.nullable(),
    modelCalls: count.nullable(),
  }).nullable(),
  ultima: z.object({
    runId: z.string(),
    createdAt: z.string(),
    counts: z.object({ alta: count, media: count, baixa: count, informativa: count }),
    toolFailures: count,
    situacao: z.enum(['concluida', 'com-falhas', 'parcial']),
  }).nullable(),
})
const modulesSchema = z.object({ modulos: z.array(moduleSchema) })
type ModuleRow = z.infer<typeof moduleSchema>

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

function formatDate(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function ModuleLine({ row }: { row: ModuleRow }) {
  const label = moduleLabels[row.modulo] ?? row.modulo
  const { atual, ultima } = row
  const known = atual !== null && atual.total !== null && atual.judged !== null
  const percent = known && atual.total! > 0 ? Math.min(100, Math.round((atual.judged! / atual.total!) * 100)) : 0
  return (
    <li className="flex flex-col gap-1 rounded-md border border-input p-2" data-module={row.modulo}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong>{label}</strong>
        <span className="text-xs text-muted-foreground">
          {atual ? 'em andamento' : ultima ? situationLabel[ultima.situacao] : 'sem verificação'}
        </span>
      </div>
      {atual ? (
        <>
          <div
            role="progressbar"
            aria-label={`Progresso de ${label}`}
            aria-valuemin={0}
            aria-valuemax={known ? atual.total! : undefined}
            aria-valuenow={known ? atual.judged! : undefined}
            aria-valuetext={known ? `${atual.judged} de ${atual.total} julgados` : 'em andamento, sem contagem'}
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className={known ? 'h-full bg-primary transition-[width]' : 'h-full w-1/3 animate-pulse bg-primary/60'}
              style={known ? { width: `${percent}%` } : undefined}
            />
          </div>
          <span className="text-xs text-muted-foreground">
            {known ? `Julgados: ${atual.judged} de ${atual.total} (${percent}%)` : 'Sem contagem de arquivos neste módulo.'}
            {atual.phase ? ` · Fase: ${labelPhase(atual.phase)}` : ''}
            {atual.modelCalls !== null ? ` · Chamadas: ${atual.modelCalls}` : ''}
            {` · Tempo: ${formatDuration(atual.elapsedMs)}`}
          </span>
        </>
      ) : ultima ? (
        <span className="text-xs text-muted-foreground">
          <time dateTime={ultima.createdAt}>{formatDate(ultima.createdAt)}</time>
          {` · Altas: ${ultima.counts.alta} · Médias: ${ultima.counts.media} · Baixas: ${ultima.counts.baixa} · Informativas: ${ultima.counts.informativa}`}
          {ultima.toolFailures ? ` · Falhas de ferramentas: ${ultima.toolFailures}` : ''}
        </span>
      ) : null}
    </li>
  )
}

/** Uma linha por módulo, atualizada a cada 15 s e parada com a aba oculta. */
export function ModulosAndamento({ projectId }: { projectId?: string }) {
  const [rows, setRows] = useState<ModuleRow[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setInterval> | undefined
    let request: AbortController | undefined

    function load() {
      request?.abort()
      const mine = new AbortController()
      request = mine
      agentControlFetch(modulesUrl, { cache: 'no-store', signal: mine.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error('UNAVAILABLE')
          const body = modulesSchema.parse(await response.json())
          if (stopped || mine.signal.aborted) return
          setRows(body.modulos)
          setFailed(false)
        })
        .catch(() => { if (!stopped && !mine.signal.aborted) setFailed(true) })
    }
    function start() {
      if (timer !== undefined) return
      load()
      timer = setInterval(load, MODULES_REFRESH_MS)
    }
    function stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      request?.abort()
    }
    function onVisibility() {
      if (document.visibilityState === 'hidden') stop()
      else start()
    }

    if (document.visibilityState !== 'hidden') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [projectId])

  return (
    <section className="flex flex-col gap-2" aria-labelledby="modules-progress-heading">
      <h2 id="modules-progress-heading" className="font-semibold">Andamento por módulo</h2>
      {failed ? <p role="status">Não foi possível atualizar o andamento dos módulos.</p> : null}
      {rows === null && !failed ? <p>Carregando andamento dos módulos…</p> : null}
      {rows ? <ul className="flex flex-col gap-2">{rows.map((row) => <ModuleLine key={row.modulo} row={row} />)}</ul> : null}
    </section>
  )
}
