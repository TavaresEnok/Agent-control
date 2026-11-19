export function registerRoutes(app: any, ws: any, _: any, items: any[]) {
  app.del('/items/:id', (_req: any, res: any) => {
    res.send(200, {ok: true});
  });

  app.get('/missing', (_req: any, res: any) => {
    res.json(404, {erro: 'nao_encontrado'});
  });

  ws.send('ping', () => {});
  return _.pluck(items, 'name');
}
