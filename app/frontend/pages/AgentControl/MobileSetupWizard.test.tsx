import '@testing-library/jest-dom/vitest';
import { expect, it, vi } from 'vitest';

import { renderPage, screen, userEvent } from 'test/renderPage';

import MobileSetupWizard from './MobileSetupWizard';

it('retries the same setup with the same intent and company', async () => {
  sessionStorage.clear();
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ deduplicated: true }), { status: 200 }));
  const user = userEvent.setup();
  renderPage(
    <MobileSetupWizard
      companyId={7}
      environments={[{ id: 1, name: 'Host', environmentSlug: 'host', state: 'active' }]}
    />,
  );
  await user.type(screen.getByRole('textbox', { name: 'Nome do Projeto' }), 'Project');
  await user.type(screen.getByRole('textbox', { name: 'Contexto de Trabalho (RF-03)' }), 'Context');
  await user.click(screen.getByRole('button', { name: /Próximo/ }));
  await user.click(screen.getByRole('button', { name: /Próximo/ }));
  await user.click(screen.getByRole('button', { name: /Próximo/ }));
  await user.click(screen.getByRole('button', { name: /Criar Configuração/ }));
  await screen.findByText('Erro de conexão ao enviar configuração.');
  await user.click(screen.getByRole('button', { name: /Criar Configuração/ }));
  await screen.findByText('Configuração já realizada anteriormente (Deduplicada).');
  const first = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
  const second = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string);
  expect(second.intent_id).toBe(first.intent_id);
  expect(second.company_id).toBe(7);
});
