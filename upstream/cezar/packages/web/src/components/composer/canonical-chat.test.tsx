import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { Composer } from './composer'
afterEach(() => { cleanup(); vi.unstubAllEnvs() })
it('managed product cannot open a second native conversation', () => {
  vi.stubEnv('VITE_AGENT_CONTROL_MANAGED', '1')
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Composer autocompleteSkills={false} onSubmit={vi.fn()} /></MemoryRouter></QueryClientProvider>)
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByRole('link', { name: 'Falar com o gerente' }).getAttribute('href')).toBe('/conversa')
})
