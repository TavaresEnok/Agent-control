import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn() }))
vi.mock('./settings/agent-control-fetch', () => ({ agentControlFetch: fetcher }))

import { VerificacoesRoute } from './verificacoes'

const RUN = '11111111-1111-4111-8111-111111111111'
const OTHER_RUN = '11111111-1111-4111-8111-111111111112'
const PROJECT = '11111111-1111-4111-8111-111111111113'
const FUNCTIONAL = '/api/v1/ac/personal/verificacoes-funcionais'
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

function renderAt(path: string, nextPath?: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      {nextPath && <Link to={nextPath}>Trocar de projeto</Link>}
      <Routes>
        <Route path="/verificacoes" element={<VerificacoesRoute />} />
        <Route path="/verificacoes/:runId" element={<VerificacoesRoute />} />
        <Route path="/p/:projectId/verificacoes" element={<VerificacoesRoute />} />
        <Route path="/p/:projectId/verificacoes/:runId" element={<VerificacoesRoute />} />
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
    if (path === FUNCTIONAL) return json({ verificacoes: [] })
    if (path === '/api/v1/ac/personal/verificacoes' && (init?.method ?? 'GET') === 'GET') return json({ verificacoes: [] })
    if (path === '/api/v1/ac/personal/verificacoes' && init?.method === 'POST') {
      return json({ id: RUN, status: 'running', phase: 'confirmacao' }, 202)
    }
    return json({ id: RUN, status: 'running', phase: 'confirmacao' })
  })
  renderAt('/verificacoes')
  expect(await screen.findByText('Nenhuma verificação ainda.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Nova verificação' }))
  expect(await screen.findByText('Fase: confirmação. Status: em andamento')).toBeTruthy()
  const post = fetcher.mock.calls.find((call) => call[1]?.method === 'POST')
  expect(post?.[0]).toBe('/api/v1/ac/personal/verificacoes')
  expect(post?.[1]?.headers).toEqual({ 'Content-Type': 'application/json' })
  expect(post?.[1]?.body).toBe('{}')
  expect((screen.getByRole('button', { name: 'Nova verificação' }) as HTMLButtonElement).disabled).toBe(true)
})

it('avisa quando o início falha e não deixa a falha sem tratamento', async () => {
  fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === FUNCTIONAL) return json({ verificacoes: [] })
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
    if (path === FUNCTIONAL) return json({ verificacoes: [] })
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
  expect(screen.getByText('Fase: ferramentas. Status: em andamento')).toBeTruthy()
  phase = 'exame'
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(screen.getByText('Fase: exame. Status: em andamento')).toBeTruthy()
  expect(polls).toEqual(['exame'])
  status = 'done'
  phase = 'done'
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(screen.getByText('Fase: concluída. Status: concluída')).toBeTruthy()
  expect(screen.getByText('Achados altos: 1')).toBeTruthy()
  expect(screen.queryByText('Nenhuma verificação ainda.')).toBeNull()
  const pollsAtDone = polls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
  expect(polls.length).toBe(pollsAtDone)
  expect((screen.getByRole('button', { name: 'Nova verificação' }) as HTMLButtonElement).disabled).toBe(false)
})

it('filtra módulos, abre cobertura e prova e reenvia só achados elegíveis', async () => {
  const qa = { id: RUN, module: 'qa', createdAt: summary.createdAt, counts: summary.counts, toolFailures: 1 }
  const arquitetura = { ...qa, id: OTHER_RUN, module: 'arquitetura' }
  const verified = { id: 'ACH-001', title: 'Regressão confirmada', severity: 'alta', status: 'confirmado',
    where: { file: 'src/app.ts', line: 12 }, proof: 'Falha reproduzida em teste sintético. <em>texto</em>' }
  const likely = { ...verified, id: 'ACH-002', title: 'Possível desvio', status: 'provavel', proof: 'Sem verificação independente.' }
  const reopened = { ...verified, id: 'ACH-003', title: 'Regressão reaberta', status: 'reaberto' }
  const posts: unknown[] = []
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/ac/personal/verificacoes') return json({ verificacoes: [] })
    if (url === FUNCTIONAL) return json({ verificacoes: [qa, arquitetura] })
    if (url === `${FUNCTIONAL}?modulo=qa`) return json({ verificacoes: [qa] })
    if (url === `${FUNCTIONAL}/qa/${RUN}`) return json({ resumo: qa, cobertura: 'fixture · teste executado',
      achados: [{ ...verified, secretPreview: 'omitir-campo-sintetico' }, likely, reopened] })
    if (url === `${FUNCTIONAL}/qa/${RUN}/corrigir` && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)))
      if (posts.length === 1) return json({ error: 'VERIFY_ALREADY_RUNNING', detail: 'omitir-erro-sintetico' }, 409)
      if (posts.length === 3) return json({
        messageLocalId: 'fixture-correcao-a', messageLocalIds: ['fixture-correcao-a', 'fixture-correcao-b'],
      })
      return json({ messageLocalId: 'module-qa-fix-synthetic' })
    }
    throw new Error('REQUEST_UNEXPECTED')
  })
  const view = renderAt(`/p/${PROJECT}/verificacoes`)
  await screen.findByRole('link', { name: /Arquitetura/ })
  fireEvent.change(screen.getByRole('combobox', { name: 'Módulo' }), { target: { value: 'qa' } })
  const link = await screen.findByRole('link', { name: /QA/ })
  expect(link.getAttribute('href')).toBe(`/p/${PROJECT}/verificacoes/${RUN}?modulo=qa`)
  expect(screen.queryByRole('link', { name: /Arquitetura/ })).toBeNull()
  fireEvent.click(link)
  await screen.findByRole('heading', { name: 'Verificações · QA' })
  fireEvent.click(screen.getByText('Cobertura'))
  expect(screen.getByText('fixture · teste executado')).toBeTruthy()
  fireEvent.click(screen.getByText(/Prova de ACH-001/))
  expect(screen.getAllByText('Falha reproduzida em teste sintético. <em>texto</em>')).toHaveLength(2)
  expect(view.container.querySelector('em')).toBeNull()
  expect(view.container.innerHTML).not.toContain('omitir-campo-sintetico')
  expect(screen.getByRole('checkbox', { name: /Possível desvio/ })).toHaveProperty('disabled', true)
  const button = screen.getByRole('button', { name: 'Corrigir' })
  expect(button).toHaveProperty('disabled', true)
  function selectFindings() {
    fireEvent.click(screen.getByRole('checkbox', { name: /Regressão confirmada/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Regressão reaberta/ }))
  }
  selectFindings()
  fireEvent.click(button)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'O contexto de exame está ocupado. Tente novamente quando estiver disponível.')
  expect(view.container.innerHTML).not.toContain('omitir-erro-sintetico')
  fireEvent.click(button)
  expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Pedido de correção enviado ao gerente.')
  selectFindings()
  fireEvent.click(button)
  const notice = await screen.findByRole('status')
  expect(notice.textContent).toContain('2 pedidos de correção enviados ao gerente.')
  expect(within(notice).getAllByRole('listitem').map((item) => item.textContent))
    .toEqual(['fixture-correcao-a', 'fixture-correcao-b'])
  expect(posts).toEqual(Array.from({ length: 3 }, () => ({ achadoIds: ['ACH-001', 'ACH-003'] })))
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([path]) => path))
    .toEqual(Array(3).fill(`${FUNCTIONAL}/qa/${RUN}/corrigir`))
})

it('mostra mensagem fixa para relatório inacessível no projeto selecionado', async () => {
  fetcher.mockResolvedValue(json({ error: 'erro-sintetico-com-conteudo-protegido' }, 404))
  const view = renderAt(`/p/${PROJECT}/verificacoes/${OTHER_RUN}?modulo=qa`)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Não foi possível ler este relatório funcional.')
  expect(fetcher).toHaveBeenCalledWith(`${FUNCTIONAL}/qa/${OTHER_RUN}`, expect.objectContaining({ cache: 'no-store' }))
  expect(view.container.innerHTML).not.toContain('erro-sintetico-com-conteudo-protegido')
  expect(screen.queryByRole('button', { name: 'Corrigir' })).toBeNull()
})

it('limpa as verificações anteriores ao trocar de projeto na mesma rota', async () => {
  let reads = 0
  let finishSecond!: (response: Response) => void
  const pendingSecond = new Promise<Response>(resolve => { finishSecond = resolve })
  fetcher.mockImplementation(async (url: string) => {
    if (url !== FUNCTIONAL) return json({ verificacoes: [] })
    if (++reads === 1) return json({ verificacoes: [
      { id: RUN, module: 'qa', createdAt: summary.createdAt, counts: summary.counts, toolFailures: 0 },
    ] })
    return pendingSecond
  })
  renderAt(`/p/${PROJECT}/verificacoes`, `/p/${OTHER_RUN}/verificacoes`)
  await screen.findByRole('link', { name: /QA/ })
  fireEvent.click(screen.getByRole('link', { name: 'Trocar de projeto' }))
  expect(screen.queryByRole('link', { name: /QA/ })).toBeNull()
  expect(reads).toBe(2)
  await act(async () => { finishSecond(json({ verificacoes: [] })) })
  expect(screen.queryByRole('link', { name: /QA/ })).toBeNull()
})

it.each(['seguranca', ''])('abre um relatório de segurança com o filtro %s', async module => {
  fetcher.mockImplementation(async (url: string) => {
    if (url === `/api/v1/ac/personal/verificacoes/${RUN}`) return json({ resumo: summary, achados: [], cobertura: '' })
    throw new Error('REQUEST_UNEXPECTED')
  })
  renderAt(`/p/${PROJECT}/verificacoes/${RUN}?modulo=${module}`)
  expect(await screen.findByText('Nenhum achado.')).toBeTruthy()
  expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(FUNCTIONAL))).toBe(false)
})

it('mantém a operação da instalação e descarta a resposta funcional tardia do projeto anterior', async () => {
  let reads = 0
  let older!: (response: Response) => void
  let started!: (response: Response) => void
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === FUNCTIONAL) {
      if (++reads === 1) return new Promise<Response>(resolve => { older = resolve })
      return json({ verificacoes: [] })
    }
    if (init?.method === 'POST') return new Promise<Response>(resolve => { started = resolve })
    return json({ verificacoes: [] })
  })
  renderAt(`/p/${PROJECT}/verificacoes`, `/p/${OTHER_RUN}/verificacoes`)
  fireEvent.click(await screen.findByRole('button', { name: 'Nova verificação' }))
  fireEvent.click(screen.getByRole('link', { name: 'Trocar de projeto' }))
  expect(screen.getByRole('button', { name: 'Nova verificação' })).toHaveProperty('disabled', true)
  await act(async () => {
    older(json({ verificacoes: [{ id: RUN, module: 'qa', createdAt: summary.createdAt, counts: summary.counts, toolFailures: 0 }] }))
    started(json({ id: RUN, phase: 'confirmacao', status: 'running' }, 202))
  })
  expect(reads).toBe(2)
  expect(screen.queryByRole('link', { name: /QA/ })).toBeNull()
  expect(screen.getByText('Fase: confirmação. Status: em andamento')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Nova verificação' })).toHaveProperty('disabled', true)
})
