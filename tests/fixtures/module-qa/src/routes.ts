export function registerBillingRoutes(app: {
  get: (path: string, handler: () => unknown) => void;
  post: (path: string, handler: () => unknown) => void;
}): void {
  app.get('/api/desconto', () => ({ok: true}));
  app.post('/api/estorno', () => ({ok: true}));
}
