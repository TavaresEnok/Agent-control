export function registerCleanRoutes(app: {
  get: (path: string, handler: () => unknown) => void;
}): void {
  app.get('/api/desconto', () => ({ok: true}));
}
