import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn() }))
vi.mock('./settings/agent-control-fetch', () => ({ agentControlFetch: fetcher }))

import { VerificacoesRoute } from './verificacoes'

const RUN = '11111111-1111-4111-8111-111111111111'
const summary = {
  id: '22222222-2222-4222-8222-222222222222',
  directoryName: '20261117-1200-seguranca',
  createdAt: '2026-11-17T12:00:00.000Z',
  counts: { alta: 1, media: 0, baixa: 0, informativa: 0 },
  note: '',
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/verificacoes" element={<VerificacoesRoute />} />
        <Route path="/verificacoes/:runId" element={<VerificacoesRoute />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  fetcher.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('posta uma verificação nova e mostra a fase', async () => {
  fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/v1/ac/personal/verificacoes' && (init?.method ?? 'GET') === 'GET') return json({ verificacoes: [] })
    if (path === '/api/v1/ac/personal/verificacoes' && init?.method === 'POST') {
      return json({ id: RUN, status: 'running', phase: 'confirmacao' }, 202)
    }
    return json({ id: RUN, status: 'running', phase: 'confirmacao' })
  })
  renderAt('/verificacoes')
  expect(await screen.findByText('Nenhuma verificação ainda.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Nova verificação' }))
  expect(await screen.findByText('Fase: confirmação. Status: running')).toBeTruthy()
  const post = fetcher.mock.calls.find((call) => call[1]?.method === 'POST')
  expect(post?.[0]).toBe('/api/v1/ac/personal/verificacoes')
  expect(post?.[1]?.headers).toEqual({ 'Content-Type': 'application/json' })
  expect(post?.[1]?.body).toBe('{}')
  expect((screen.getByRole('button', { name: 'Nova verificação' }) as HTMLButtonElement).disabled).toBe(true)
})

it('avisa quando o início falha e não deixa a falha sem tratamento', async () => {
  fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET' && path === '/api/v1/ac/personal/verificacoes') return json({ verificacoes: [] })
    if (init?.method === 'POST') return json({ error: 'indisponivel' }, 500)
    throw new Error('rede')
  })
  renderAt('/verificacoes')
  await screen.findByRole('button', { name: 'Nova verificação' })
  fireEvent.click(screen.getByRole('button', { name: 'Nova verificação' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Não foi possível iniciar a verificação.')
  expect((screen.getByRole('button', { name: 'Nova verificação' }) as HTMLButtonElement).disabled).toBe(false)
})

it('não mostra o botão no detalhe', async () => {
  fetcher.mockImplementation(async () => json({}, 404))
  renderAt(`/verificacoes/${RUN}`)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Não foi possível ler esta verificação.')
  expect(screen.queryByRole('button', { name: 'Nova verificação' })).toBeNull()
})

it('consulta o andamento enquanto corre e recarrega a lista ao concluir', async () => {
  vi.useFakeTimers()
  let status = 'running'
  let phase = 'mapa'
  let listReads = 0
  const polls: string[] = []
  fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (path === '/api/v1/ac/personal/verificacoes' && method === 'GET') {
      listReads += 1
      return json({ verificacoes: listReads > 1 ? [summary] : [] })
    }
    if (path === '/api/v1/ac/personal/verificacoes' && method === 'POST') {
      return json({ id: RUN, status: 'running', phase: 'ferramentas' }, 202)
    }
    if (path === '/api/v1/ac/personal/verificacoes/andamento') {
      polls.push(phase)
      return json({ runs: [{ id: RUN, status, phase, startedAt: '2026-11-17T12:00:00.000Z' }] })
    }
    throw new Error('rede')
  })
  renderAt('/verificacoes')
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(screen.getByText('Nenhuma verificação ainda.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Nova verificação' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(screen.getByText('Fase: ferramentas. Status: running')).toBeTruthy()
  phase = 'exame'
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(screen.getByText('Fase: exame. Status: running')).toBeTruthy()
  expect(polls).toEqual(['exame'])
  status = 'done'
  phase = 'done'
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(screen.getByText('Fase: concluída. Status: done')).toBeTruthy()
  expect(screen.getByText('Achados altos: 1')).toBeTruthy()
  expect(screen.queryByText('Nenhuma verificação ainda.')).toBeNull()
  const pollsAtDone = polls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
  expect(polls.length).toBe(pollsAtDone)
  expect((screen.getByRole('button', { name: 'Nova verificação' }) as HTMLButtonElement).disabled).toBe(false)
})
