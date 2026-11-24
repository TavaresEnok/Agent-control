import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn() }))
vi.mock('./settings/agent-control-fetch', () => ({ agentControlFetch: fetcher }))

import { formatDuration, MODULES_REFRESH_MS, modulesUrl, ModulosAndamento } from './verificacoes-modulos'

const ORDER = ['seguranca', 'qa', 'arquitetura', 'dependencias', 'banco', 'prontidao', 'desempenho', 'documentacao', 'conformidade', 'design']

function body(overrides: Record<string, unknown> = {}) {
  return {
    modulos: ORDER.map((modulo) => ({ modulo, atual: null, ultima: null, ...(overrides[modulo] as object | undefined) })),
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const line = (module: string) => within(document.querySelector(`[data-module="${module}"]`) as HTMLElement)

beforeEach(() => {
  fetcher.mockReset()
  vi.useFakeTimers()
  setVisibility('visible')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(document, 'visibilityState')
})

it('mostra uma linha por módulo, com barra, fase, chamadas e tempo, e a contagem do concluído', async () => {
  fetcher.mockResolvedValue(json(body({
    seguranca: {
      atual: { runId: 'r1', phase: 'exame', startedAt: '2026-11-24T10:00:00.000Z', elapsedMs: 125_000, judged: 40, total: 160, modelCalls: 12 },
      ultima: { runId: 'r0', createdAt: '2026-11-23T10:00:00.000Z', counts: { alta: 1, media: 2, baixa: 3, informativa: 4 }, toolFailures: 0, situacao: 'concluida' },
    },
    banco: { atual: { runId: 'r2', phase: null, startedAt: '2026-11-24T10:00:00.000Z', elapsedMs: 30_000, judged: null, total: null, modelCalls: null } },
    qa: { ultima: { runId: 'r3', createdAt: '2026-11-23T10:00:00.000Z', counts: { alta: 0, media: 5, baixa: 0, informativa: 0 }, toolFailures: 2, situacao: 'com-falhas' } },
  })))
  render(<ModulosAndamento />)
  await tick(0)
  expect(fetcher.mock.calls[0]?.[0]).toBe(modulesUrl)
  expect(document.querySelectorAll('[data-module]').length).toBe(10)
  expect([...document.querySelectorAll('[data-module]')].map((item) => item.getAttribute('data-module'))).toEqual(ORDER)

  const bar = line('seguranca').getByRole('progressbar')
  expect(bar.getAttribute('aria-valuenow')).toBe('40')
  expect(bar.getAttribute('aria-valuemax')).toBe('160')
  expect((bar.firstElementChild as HTMLElement).style.width).toBe('25%')
  expect(line('seguranca').getByText(/Julgados: 40 de 160 \(25%\) · Fase: exame · Chamadas: 12 · Tempo: 2 min 05 s/)).toBeTruthy()

  // sem contagem: barra indeterminada, sem valor
  expect(line('banco').getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
  expect(line('banco').getByText(/Sem contagem de arquivos neste módulo\. · Tempo: 30 s/)).toBeTruthy()

  // concluído: contagem por gravidade, sem barra
  expect(line('qa').queryByRole('progressbar')).toBeNull()
  expect(line('qa').getByText(/Altas: 0 · Médias: 5 · Baixas: 0 · Informativas: 0 · Falhas de ferramentas: 2/)).toBeTruthy()
  expect(line('qa').getByText('com falhas de ferramenta')).toBeTruthy()
  expect(line('design').getByText('sem verificação')).toBeTruthy()
})

it('atualiza a cada 15 s, para com a aba oculta e volta a ler ao reaparecer', async () => {
  fetcher.mockImplementation(async () => json(body()))
  render(<ModulosAndamento />)
  await tick(0)
  expect(fetcher).toHaveBeenCalledTimes(1)
  await tick(MODULES_REFRESH_MS)
  expect(fetcher).toHaveBeenCalledTimes(2)

  setVisibility('hidden')
  await tick(MODULES_REFRESH_MS * 4)
  expect(fetcher).toHaveBeenCalledTimes(2)

  setVisibility('visible')
  await tick(0)
  expect(fetcher).toHaveBeenCalledTimes(3)
  await tick(MODULES_REFRESH_MS)
  expect(fetcher).toHaveBeenCalledTimes(4)
})

it('não consulta nada se a aba já começa oculta e para ao desmontar', async () => {
  fetcher.mockImplementation(async () => json(body()))
  setVisibility('hidden')
  const view = render(<ModulosAndamento />)
  await tick(MODULES_REFRESH_MS * 2)
  expect(fetcher).not.toHaveBeenCalled()
  setVisibility('visible')
  await tick(0)
  expect(fetcher).toHaveBeenCalledTimes(1)
  view.unmount()
  await tick(MODULES_REFRESH_MS * 3)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('falha de leitura ou formato inválido avisa sem alerta e mantém o último estado', async () => {
  fetcher.mockResolvedValueOnce(json(body({ qa: { atual: { runId: 'r', phase: 'exame', startedAt: 'x', elapsedMs: 1000, judged: 1, total: 2, modelCalls: 0 } } })))
  render(<ModulosAndamento />)
  await tick(0)
  expect(line('qa').getByRole('progressbar')).toBeTruthy()

  fetcher.mockResolvedValueOnce(json({ error: 'x' }, 500))
  await tick(MODULES_REFRESH_MS)
  expect(screen.getByRole('status').textContent).toBe('Não foi possível atualizar o andamento dos módulos.')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(line('qa').getByRole('progressbar')).toBeTruthy()

  fetcher.mockResolvedValueOnce(json({ modulos: [{ modulo: 'qa', atual: { judged: 'muito' } }] }))
  await tick(MODULES_REFRESH_MS)
  expect(screen.getByRole('status')).toBeTruthy()

  fetcher.mockResolvedValueOnce(json(body()))
  await tick(MODULES_REFRESH_MS)
  expect(screen.queryByRole('status')).toBeNull()
  expect(line('qa').queryByRole('progressbar')).toBeNull()
})

it('formata o tempo', () => {
  expect(formatDuration(0)).toBe('0 s')
  expect(formatDuration(59_999)).toBe('59 s')
  expect(formatDuration(3_725_000)).toBe('1 h 02 min')
})
