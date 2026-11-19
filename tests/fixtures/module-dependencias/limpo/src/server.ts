export function registerRoutes(app: any, ws: any, _: any, items: any[]) {
  app.delete('/items/:id', (_req: any, res: any) => {
    res.status(200).send({ok: true});
  });

  app.get('/missing', (_req: any, res: any) => {
    res.status(404).json({erro: 'nao_encontrado'});
  });

  ws.send('ping', () => {});
  return _.map(items, (item: any) => item.name);
}
