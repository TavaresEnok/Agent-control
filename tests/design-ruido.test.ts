import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {collectDesignFindings} from '../src/design-collect.ts';
import {loadDesignChecklist} from '../src/design-checklist.ts';
import {compareDesignRuns} from '../src/design-delta.ts';
import {discoverRoutesFromSource, dynamicRoutesMissingExample, isApiRoute, isNonScreenFile} from '../src/design-discover.ts';
import {DESIGN_CONFIRM_BATCH_MAX, examineDesignScreens, type DesignSeat} from '../src/design-examine.ts';
import {assembleAchados, screenRoutesForExam} from '../src/design-module.ts';
import type {DesignWorker} from '../src/design-types.ts';
import {groupWallaceFindings, wallaceFindings} from '../src/design-wallace.ts';

// 1. Telas: teste, API e página que não é tela ficam fora.

test('arquivo de teste, especificação, história, mock e página de rota desconhecida não são tela', () => {
  for (const path of [
    'web/src/features/erp/erp-panel.test.tsx',
    'web/e2e/ux.spec.ts',
    'src/Botao.stories.tsx',
    'src/__tests__/Tela.tsx',
    'src/__mocks__/Tela.tsx',
    'web/src/pages/unknown-page.tsx',
    'web/src/pages/not-found.tsx',
    'src/pages/NotFoundPage.tsx',
    'public/404.html',
    'src/types.d.ts',
  ]) assert.equal(isNonScreenFile(path), true, path);
  for (const path of [
    'web/src/pages/contacts-page.tsx',
    'web/src/pages/accept-invite-page.tsx',
    'src/App.tsx',
    'index.html',
    'src/testimonials.tsx',
    'src/pages/found.tsx',
    'public/500.html',
    'tests/fixtures/design-lab/src/App.tsx',
  ]) assert.equal(isNonScreenFile(path), false, path);
});

test('rota de API não é tela', () => {
  assert.equal(isApiRoute('/api'), true);
  assert.equal(isApiRoute('/api/panel/contacts/b'), true);
  assert.equal(isApiRoute('/apiary'), false);
  assert.equal(isApiRoute('/painel'), false);
});

test('a descoberta ignora rotas de arquivo de teste e rotas /api', () => {
  const found = discoverRoutesFromSource([
    {path: 'web/src/routes.tsx', text: '<Route path="/contatos" element={<A />} />\n<Route path="/api/painel" element={<B />} />\n<Route path="*" element={<UnknownPage />} />'},
    {path: 'web/src/features/contacts/contacts-panel.test.tsx', text: "const rotas = [{ path: '/api/panel/contacts/b' }, { path: '/so-no-teste' }];"},
    {path: 'web/e2e/ux.spec.ts', text: "export const telas = [{ path: '/so-no-e2e' }];"},
  ]);
  assert.deepEqual(found.map(item => item.route), ['/contatos']);
});

test('rota servida de /api ou de página que não é tela não entra no exame', () => {
  const files = [
    {path: 'public/unknown-page', text: '<html></html>'},
    {path: 'public/contatos', text: '<html></html>'},
    {path: 'public/api/panel', text: '<html></html>'},
  ];
  const routes = screenRoutesForExam(files, [{route: '/unknown-page'}, {route: '/contatos'}, {route: '/api/panel'}]);
  assert.deepEqual(routes.map(item => item.route), ['/contatos']);
});

test('rota dinâmica de /api ou de arquivo de teste não aparece como dinâmica sem exemplo', () => {
  const skipped = dynamicRoutesMissingExample([
    {path: 'web/src/routes.tsx', text: '<Route path="/contatos/:id" element={<A />} />\n<Route path="/api/x/:id" element={<B />} />'},
    {path: 'web/src/a.test.tsx', text: '<Route path="/so-teste/:id" element={<C />} />'},
  ]);
  assert.deepEqual(skipped, ['/contatos/:id']);
});

test('arquivo de teste não gera achado estático de tela', () => {
  const html = '<ul><li>a</li></ul><button></button>';
  const real = collectDesignFindings([{path: 'web/src/pages/lista.html', text: html}]);
  const test = collectDesignFindings([{path: 'web/src/pages/lista.test.tsx', text: html}]);
  assert.ok(real.length > 0);
  assert.deepEqual(test, []);
});

// 2. Repetição: a mesma regra na mesma rota é um achado só.

const REPORT = (duplicates: number) => ({declarations: {total: duplicates + 5, totalUnique: 5}});
const computed = (route: string, viewport: number, theme: string, state: string) => `computado ${route} ${viewport} ${theme} ${state}`;

test('a mesma regra na mesma rota, em larguras, temas e estados, vira um achado com contagem e locais', () => {
  const entries = [] as {file: string; report: unknown}[];
  for (const viewport of [375, 768, 1440]) {
    for (const theme of ['claro', 'escuro']) {
      entries.push({file: computed('/configuracoes', viewport, theme, 'padrao'), report: REPORT(viewport === 1440 ? 90 : 87)});
    }
  }
  entries.push({file: computed('/contatos', 375, 'claro', 'padrao'), report: REPORT(12)});
  entries.push({file: computed('/contatos', 768, 'claro', 'padrao'), report: REPORT(12)});
  const findings = collectDesignFindings([], {cssAnalyzer: entries});
  assert.equal(findings.length, 2);
  const settings = findings.find(item => item.file === 'computado /configuracoes')!;
  assert.equal(settings.rule, 'DESIGN-WALLACE-DUPLICADAS');
  assert.equal(settings.occurrences?.count, 6);
  assert.equal(settings.occurrences?.locations.length, 6);
  assert.ok(settings.occurrences?.locations.includes('1440 escuro padrao: 90'));
  assert.deepEqual(settings.measure, {kind: 'wallace', metric: 'duplicadas', value: 90});
  const contacts = findings.find(item => item.file === 'computado /contatos')!;
  assert.equal(contacts.occurrences?.count, 2);
});

test('o achado medido diz a contagem e os locais da mesma regra', () => {
  const entries = [375, 768].map(viewport => ({file: computed('/painel', viewport, 'claro', 'padrao'), report: REPORT(viewport)}));
  const raw = collectDesignFindings([], {cssAnalyzer: entries});
  const achados = assembleAchados(raw, []);
  assert.equal(achados.length, 1);
  assert.match(achados[0]!.scenario, /Mesma regra em 2 capturas \(maior valor\): 375 claro padrao: 375; 768 claro padrao: 768\./);
  assert.match(achados[0]!.proof, /Mesma regra em 2 capturas/);
  assert.equal(achados[0]!.where.file, 'computado /painel');
});

test('rota medida uma vez e regras diferentes não se juntam', () => {
  const single = {file: computed('/entrar', 375, 'claro', 'padrao'), report: REPORT(3)};
  const twice = [
    {file: computed('/painel', 375, 'claro', 'padrao'), report: {...REPORT(4), values: {fontSizes: {totalUnique: 9}}}},
    {file: computed('/painel', 768, 'claro', 'padrao'), report: {...REPORT(4), values: {fontSizes: {totalUnique: 10}}}},
  ];
  const findings = groupWallaceFindings([single, ...twice].flatMap(entry => wallaceFindings(entry.file, entry.report)));
  assert.equal(findings.length, 3);
  assert.equal(findings.find(item => item.file === single.file)?.occurrences, undefined);
  const fonts = findings.find(item => item.rule === 'DESIGN-WALLACE-FONTES')!;
  assert.equal(fonts.occurrences?.count, 2);
  assert.equal(fonts.measure?.kind === 'wallace' ? fonts.measure.value : 0, 10);
});

test('a mesma folha medida em várias rotas, com o mesmo valor, é um achado só com a lista das rotas', () => {
  const entries = [] as {file: string; report: unknown}[];
  for (const route of ['/a', '/b', '/c']) {
    for (const viewport of [375, 768]) entries.push({file: computed(route, viewport, 'claro', 'padrao'), report: REPORT(87)});
  }
  entries.push({file: computed('/d', 375, 'claro', 'padrao'), report: REPORT(87)});
  entries.push({file: computed('/e', 375, 'claro', 'padrao'), report: REPORT(40)});
  const findings = collectDesignFindings([], {cssAnalyzer: entries});
  assert.equal(findings.length, 2);
  const shared = findings.find(item => item.occurrences?.routes !== undefined)!;
  assert.deepEqual(shared.occurrences?.routes, ['/a', '/b', '/c', '/d']);
  assert.equal(shared.occurrences?.count, 7);
  assert.equal(shared.file, 'computado /a e mais 3 rotas');
  assert.ok(shared.occurrences?.locations.includes('/b (2 capturas): 87'));
  assert.equal(findings.find(item => item.file === computed('/e', 375, 'claro', 'padrao'))?.occurrences, undefined);
  const achado = assembleAchados(findings, [])[0]!;
  assert.match(achado.proof, /Mesma regra em 4 rotas e 7 capturas, com o mesmo valor/);
});

test('o delta não vê achado novo nem ausente só porque o css-analyzer passou a vir agrupado', () => {
  const entries = [] as {file: string; report: unknown}[];
  for (const route of ['/a', '/b']) {
    for (const viewport of [375, 768]) entries.push({file: computed(route, viewport, 'claro', 'padrao'), report: REPORT(87)});
  }
  const grouped = collectDesignFindings([], {cssAnalyzer: entries});
  const oldStyle = entries.flatMap(entry => wallaceFindings(entry.file, entry.report));
  assert.equal(oldStyle.length, 4);
  assert.equal(grouped.length, 1);
  const delta = compareDesignRuns({findings: oldStyle}, {findings: grouped});
  assert.equal(delta.novos.length, 0);
  assert.equal(delta.ausentes.length, 0);
  assert.equal(delta.mantidos.length, 2);
  const back = compareDesignRuns({findings: grouped}, {findings: grouped});
  assert.equal(back.mantidos.length, 2);
});

test('arquivo que não é captura não é agrupado', () => {
  const findings = groupWallaceFindings([
    ...wallaceFindings('css/a.css', REPORT(3)),
    ...wallaceFindings('css/b.css', REPORT(3)),
  ]);
  assert.equal(findings.length, 2);
  assert.ok(findings.every(item => item.occurrences === undefined));
});

// 3. Confirmações em lote.

const BATCH = {tokens: 40_000, files: 8};
const CODE = 'export function Tela() {\n  return <div><button>Apagar</button><input /><a href="#">x</a></div>;\n}\n';

function seats() {
  const events: string[] = [];
  const reserve = async (role: 'specialist' | 'reviewer'): Promise<DesignSeat> => {
    events.push(`reserve:${role}`);
    return {provider: 'claude', model: role === 'reviewer' ? 'modelo-revisor' : 'modelo-especialista', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
  };
  return {events, reserve, release: async (_seat: DesignSeat) => { events.push('release'); }};
}

function examFinding(index: number, severity: 'media' | 'alta' = 'media') {
  return {
    title: `Ponto ${index}`, severity, file: 'src/Tela.tsx', line: index, scenario: `cenário ${index}`,
    suggestion: `sugestão ${index}`, reference: `DESIGN-NIELSEN-H${index}`, snippet: `trecho ${index}`, basis: 'hipotese',
  };
}

/** O exame devolve `count` pontos; a confirmação em lote devolve o veredito que `verdicts` manda para cada índice. */
function confirmWorker(tasks: string[], count: number, options: {severities?: ('media' | 'alta')[]; verdicts?: (index: number) => unknown | null; plain?: boolean} = {}): DesignWorker {
  return {
    async run(call) {
      tasks.push(call.task);
      if (call.task.startsWith('Pedido de confirmação em lote.')) {
        if (options.plain) return 'não sei';
        const total = Number(/Ponto \d+ de (\d+)/.exec(call.task)?.[1] ?? '0');
        const results = Array.from({length: total}, (_, at) => at + 1).flatMap(index => {
          const verdict = options.verdicts ? options.verdicts(index) : {status: 'confirmado', reason: `ok ${index}`, proof: `prova ${index}`};
          return verdict === null ? [] : [{index, ...(verdict as object)}];
        });
        return JSON.stringify({kind: 'confirmacao-lote', results});
      }
      if (call.task.startsWith('Pedido de confirmação.')) {
        const title = /^Título: (.*)$/m.exec(call.task)?.[1] ?? '';
        return JSON.stringify({kind: 'confirmacao', status: 'provavel', reason: `sozinho ${title}`, proof: ''});
      }
      return JSON.stringify({
        kind: 'exame', filesRead: ['src/Tela.tsx'], checklist: ['DESIGN-NIELSEN-H1-ESTADO'],
        findings: Array.from({length: count}, (_, at) => examFinding(at + 1, options.severities?.[at] ?? 'media')),
      });
    },
  };
}

const base = {repo: '/tmp/repo-design', checklist: loadDesignChecklist(), rawFindings: []};
const oneScreen = [{file: 'src/Tela.tsx', route: '/tela', code: CODE, captureNote: 'sem captura'}];

test('os pontos da mesma tela são confirmados numa chamada, com um veredito por ponto', async () => {
  const k = seats();
  const tasks: string[] = [];
  const result = await examineDesignScreens({
    ...base, intentId: randomUUID(), screens: oneScreen, batch: BATCH, worker: confirmWorker(tasks, 4, {
      verdicts: index => ({status: index === 2 ? 'descartado' : 'confirmado', reason: `razão ${index}`, proof: `prova ${index}`}),
    }), reserve: k.reserve, release: k.release,
  });
  assert.equal(tasks.filter(task => task.startsWith('Pedido de confirmação em lote.')).length, 1);
  assert.equal(tasks.filter(task => task.startsWith('Pedido de confirmação.')).length, 0);
  assert.equal(k.events.filter(event => event === 'reserve:reviewer').length, 1);
  assert.equal(result.confirmations.length, 4);
  assert.deepEqual(result.confirmations.map(item => item.confirm.status), ['confirmado', 'descartado', 'confirmado', 'confirmado']);
  assert.deepEqual(result.confirmations.map(item => item.confirm.reason), ['razão 1', 'razão 2', 'razão 3', 'razão 4']);
  assert.deepEqual(result.confirmations.map(item => item.finding.title), ['Ponto 1', 'Ponto 2', 'Ponto 3', 'Ponto 4']);
  assert.ok(result.confirmations.every(item => item.verifier?.model === 'modelo-revisor'));
  // O código entra uma vez só no pedido do lote.
  const batchTask = tasks.find(task => task.startsWith('Pedido de confirmação em lote.'))!;
  assert.equal(batchTask.split('Código:').length - 1, 1);
  assert.equal(result.modelCoverage.reviewer.judged, 1);
});

test('sem economy.batch cada ponto segue com a sua chamada', async () => {
  const k = seats();
  const tasks: string[] = [];
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: oneScreen, worker: confirmWorker(tasks, 3), reserve: k.reserve, release: k.release});
  assert.equal(tasks.filter(task => task.startsWith('Pedido de confirmação.')).length, 3);
  assert.equal(tasks.filter(task => task.startsWith('Pedido de confirmação em lote.')).length, 0);
  assert.equal(result.confirmations.length, 3);
});

test('ponto sem veredito válido no lote é confirmado sozinho, os outros ficam com o do lote', async () => {
  const k = seats();
  const tasks: string[] = [];
  const result = await examineDesignScreens({
    ...base, intentId: randomUUID(), screens: oneScreen, batch: BATCH, worker: confirmWorker(tasks, 3, {
      verdicts: index => (index === 2 ? null : index === 3 ? {status: 'talvez', reason: '', proof: ''} : {status: 'confirmado', reason: 'do lote', proof: ''}),
    }), reserve: k.reserve, release: k.release,
  });
  assert.equal(tasks.filter(task => task.startsWith('Pedido de confirmação em lote.')).length, 1);
  assert.equal(tasks.filter(task => task.startsWith('Pedido de confirmação.')).length, 2);
  assert.deepEqual(result.confirmations.map(item => item.confirm.reason), ['do lote', 'sozinho Ponto 2', 'sozinho Ponto 3']);
  assert.ok(result.notes.some(note => note.includes('2 ponto(s) sem veredito')));
});

test('resposta do lote que não é JSON manda todos os pontos para a confirmação sozinha', async () => {
  const k = seats();
  const tasks: string[] = [];
  const result = await examineDesignScreens({
    ...base, intentId: randomUUID(), screens: oneScreen, batch: BATCH, worker: confirmWorker(tasks, 3, {plain: true}), reserve: k.reserve, release: k.release,
  });
  assert.equal(tasks.filter(task => task.startsWith('Pedido de confirmação.')).length, 3);
  assert.equal(result.confirmations.length, 3);
});

test('índice repetido ou fora do pedido não vale', async () => {
  const k = seats();
  const tasks: string[] = [];
  const worker: DesignWorker = {
    async run(call) {
      tasks.push(call.task);
      if (call.task.startsWith('Pedido de confirmação em lote.')) {
        return JSON.stringify({kind: 'confirmacao-lote', results: [
          {index: 1, status: 'confirmado', reason: 'a', proof: ''},
          {index: 1, status: 'descartado', reason: 'b', proof: ''},
          {index: 9, status: 'confirmado', reason: 'fora', proof: ''},
          {index: 2, status: 'confirmado', reason: 'c', proof: ''},
        ]});
      }
      return confirmWorker(tasks, 2).run(call);
    },
  };
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: oneScreen, batch: BATCH, worker, reserve: k.reserve, release: k.release});
  assert.deepEqual(result.confirmations.map(item => item.confirm.reason), ['sozinho Ponto 1', 'c']);
});

test('ponto de gravidade alta mantém a sua chamada e o resto vai junto', async () => {
  const k = seats();
  const tasks: string[] = [];
  const result = await examineDesignScreens({
    ...base, intentId: randomUUID(), screens: oneScreen, batch: BATCH, worker: confirmWorker(tasks, 3, {severities: ['media', 'alta', 'media']}), reserve: k.reserve, release: k.release,
  });
  assert.equal(tasks.filter(task => task.startsWith('Pedido de confirmação em lote.')).length, 1);
  assert.equal(tasks.filter(task => task.startsWith('Pedido de confirmação.')).length, 1);
  const batchTask = tasks.find(task => task.startsWith('Pedido de confirmação em lote.'))!;
  assert.ok(!batchTask.includes('Título: Ponto 2'));
  assert.deepEqual(result.confirmations.map(item => item.finding.title), ['Ponto 1', 'Ponto 2', 'Ponto 3']);
});

test('um ponto só não vira lote', async () => {
  const k = seats();
  const tasks: string[] = [];
  await examineDesignScreens({...base, intentId: randomUUID(), screens: oneScreen, batch: BATCH, worker: confirmWorker(tasks, 1), reserve: k.reserve, release: k.release});
  assert.equal(tasks.filter(task => task.startsWith('Pedido de confirmação.')).length, 1);
  assert.equal(tasks.filter(task => task.startsWith('Pedido de confirmação em lote.')).length, 0);
});

test('mais pontos que o limite vão em chamadas seguidas', async () => {
  const k = seats();
  const tasks: string[] = [];
  const total = DESIGN_CONFIRM_BATCH_MAX + 3;
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: oneScreen, batch: BATCH, worker: confirmWorker(tasks, total), reserve: k.reserve, release: k.release});
  assert.equal(tasks.filter(task => task.startsWith('Pedido de confirmação em lote.')).length, 2);
  assert.equal(tasks.filter(task => task.startsWith('Pedido de confirmação.')).length, 0);
  assert.equal(result.confirmations.length, total);
});

test('falha do provedor no lote entra na cobertura do revisor e os pontos seguem um a um', async () => {
  const k = seats();
  const tasks: string[] = [];
  const inner = confirmWorker(tasks, 2);
  const worker: DesignWorker = {
    async run(call) {
      if (call.task.startsWith('Pedido de confirmação em lote.')) {
        tasks.push(call.task);
        throw new Error('rede caiu');
      }
      return inner.run(call);
    },
  };
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: oneScreen, batch: BATCH, worker, reserve: k.reserve, release: k.release});
  assert.equal(result.modelCoverage.reviewer.failure, 'EXECUTION_NATIVE_FAILED');
  assert.ok(result.notes.some(note => note.includes('confirmação em lote') && note.includes('EXECUTION_NATIVE_FAILED') && note.includes('um a um')));
  assert.equal(result.confirmations.length, 2);
  assert.equal(tasks.filter(task => task.startsWith('Pedido de confirmação.')).length, 2);
});

test('login vencido no lote para o exame, sem chamadas individuais', async () => {
  const k = seats();
  const worker: DesignWorker = {
    async run(call) {
      if (call.task.startsWith('Pedido de confirmação em lote.')) throw new Refusal('EXAM_LOGIN_STALE', 409);
      return confirmWorker([], 2).run(call);
    },
  };
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: oneScreen, batch: BATCH, worker, reserve: k.reserve, release: k.release});
  assert.equal(result.loginStale, true);
  assert.equal(result.confirmations.length, 0);
});
