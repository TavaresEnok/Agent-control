import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DESIGN_RENDER_RULES, parseRenderCells, renderFindings} from '../src/design-render.ts';
import {clampHighSeverity, type DesignRawFinding} from '../src/design-types.ts';

const {residueKind, renderProbe} = await import(new URL('../deploy/design-tools/run-exam.mjs', import.meta.url).href) as {
  residueKind: (text: string) => string | null;
  renderProbe: (options: Record<string, boolean>) => {overflow?: {px: number; clip: boolean; offenders: {sel: string; right: number}[]}};
};

type FakeElement = {
  nodeType: 1;
  tagName: string;
  id: string;
  isConnected: true;
  parentElement: FakeElement | null;
  children: FakeElement[];
  style: Record<string, string>;
  right: number;
  scrollWidth: number;
  clientWidth: number;
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => {left: number; right: number; top: number; bottom: number; width: number; height: number};
  contains: (other: FakeElement) => boolean;
};

function fake(tag: string, style: Record<string, string> = {}, right = 300, kids: FakeElement[] = [], className = ''): FakeElement {
  const el: FakeElement = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: '',
    isConnected: true,
    parentElement: null,
    children: kids,
    style,
    right,
    scrollWidth: 0,
    clientWidth: 0,
    getAttribute: name => (name === 'class' ? className : null),
    getBoundingClientRect: () => ({left: 0, right: el.right, top: 0, bottom: 40, width: el.right, height: 40}),
    contains: other => {
      for (let node: FakeElement | null = other; node; node = node.parentElement) if (node === el) return true;
      return false;
    },
  };
  for (const kid of kids) kid.parentElement = el;
  return el;
}

/** Roda a sonda num DOM de mentira de 375px. */
function probeOverflow(kids: FakeElement[], rootStyle: Record<string, string> = {}, bodyStyle: Record<string, string> = {}, widths = {root: 375, body: 375}) {
  const body = fake('body', bodyStyle, 375, kids);
  const root = fake('html', rootStyle, 375, [body]);
  root.scrollWidth = widths.root;
  root.clientWidth = 375;
  body.scrollWidth = widths.body;
  const all: FakeElement[] = [];
  const walk = (el: FakeElement) => {
    for (const kid of el.children) {
      all.push(kid);
      walk(kid);
    }
  };
  walk(body);
  (body as unknown as {querySelectorAll: () => FakeElement[]}).querySelectorAll = () => all;
  const saved = {window: globalThis.window, document: globalThis.document, getComputedStyle: globalThis.getComputedStyle};
  const base = {overflowX: 'visible', position: 'static', transform: 'none', translate: 'none', display: 'block', visibility: 'visible', opacity: '1'};
  Object.assign(globalThis, {
    window: {innerWidth: 375},
    document: {documentElement: root, body},
    getComputedStyle: (el: FakeElement) => ({...base, ...el.style}),
  });
  try {
    return renderProbe({overflow: true}).overflow;
  } finally {
    Object.assign(globalThis, saved);
  }
}

type Raw = Record<string, unknown>;

function cell(route: string, viewport: number, extra: Raw = {}, theme = 'claro', state = 'padrao'): Raw {
  return {file: `${route} ${viewport} ${theme} ${state}`, route, viewport, theme, state, ...extra};
}

function findings(cells: Raw[]): DesignRawFinding[] {
  return renderFindings(parseRenderCells(cells));
}

function only(list: readonly DesignRawFinding[], rule: string): DesignRawFinding[] {
  return list.filter(item => item.rule === rule);
}

test('rolagem de 0 ou 1px não gera achado', () => {
  const list = findings([
    cell('/a', 375, {overflow: {px: 0, clip: false, offenders: []}}),
    cell('/a', 1440, {overflow: {px: 1, clip: false, offenders: []}}),
  ]);
  assert.deepEqual(only(list, DESIGN_RENDER_RULES.overflow), []);
});

test('37px em 375 é alta com medida que passa por clampHighSeverity', () => {
  const list = findings([cell('/a', 375, {overflow: {px: 37, clip: false, offenders: [{sel: 'div.largo', right: 412}]}})]);
  const [hit] = only(list, DESIGN_RENDER_RULES.overflow);
  assert.ok(hit);
  assert.equal(hit.severity, 'alta');
  assert.equal(hit.tool, 'régua');
  assert.deepEqual(hit.measure, {kind: 'overflow', px: 37});
  assert.equal(clampHighSeverity(hit.severity, hit.measure), 'alta');
  assert.equal(hit.file, '/a 375 claro padrao');
  assert.match(hit.snippet, /37px em 375px, tema claro/);
  assert.match(hit.snippet, /div\.largo \(até 412px\)/);
});

test('37px em 1440 é média, ainda com medida', () => {
  const [hit] = only(findings([cell('/a', 1440, {overflow: {px: 37, clip: false, offenders: []}})]), DESIGN_RENDER_RULES.overflow);
  assert.equal(hit?.severity, 'media');
  assert.deepEqual(hit?.measure, {kind: 'overflow', px: 37});
});

test('overflow escondido no body dá média sem medida: conteúdo cortado', () => {
  const [hit] = only(findings([cell('/a', 375, {overflow: {px: 145, clip: true, offenders: [{sel: 'div.x', right: 520}]}})]), DESIGN_RENDER_RULES.overflow);
  assert.equal(hit?.severity, 'media');
  assert.equal(hit?.measure, undefined);
  assert.match(hit?.snippet ?? '', /conteúdo cortado na lateral.*div\.x/);
  assert.deepEqual(only(findings([cell('/a', 375, {overflow: {px: 0, clip: true, offenders: []}})]), DESIGN_RENDER_RULES.overflow), []);
});

test('com overflow escondido, elemento fora da tela sem sobra não gera achado', () => {
  const drawer = {sel: 'nav.gaveta', right: 695};
  assert.deepEqual(only(findings([cell('/a', 375, {overflow: {px: 0, clip: true, offenders: [drawer]}})]), DESIGN_RENDER_RULES.overflow), []);
  assert.deepEqual(only(findings([cell('/a', 375, {overflow: {px: 1, clip: true, offenders: [drawer]}})]), DESIGN_RENDER_RULES.overflow), []);
  // Sobra sem elemento listado: a sonda tirou gaveta e item fixo, então não há o que mostrar.
  assert.deepEqual(only(findings([cell('/a', 375, {overflow: {px: 320, clip: true, offenders: []}})]), DESIGN_RENDER_RULES.overflow), []);
});

test('fica o pior valor entre temas, estados e larguras; um achado por rota', () => {
  const list = findings([
    cell('/a', 375, {overflow: {px: 20, clip: false, offenders: []}}),
    cell('/a', 375, {overflow: {px: 90, clip: false, offenders: []}}, 'escuro'),
    cell('/a', 320, {overflow: {px: 40, clip: false, offenders: []}}),
    cell('/a', 375, {overflow: {px: 60, clip: false, offenders: []}}, 'claro', 'vazio'),
    cell('/a', 1440, {overflow: {px: 500, clip: false, offenders: []}}),
    cell('/b', 768, {overflow: {px: 12, clip: false, offenders: []}}),
  ]);
  const hits = only(list, DESIGN_RENDER_RULES.overflow);
  assert.equal(hits.length, 2);
  const first = hits.find(item => item.file.startsWith('/a '));
  assert.equal(first?.file, '/a 375 escuro padrao');
  assert.equal(first?.severity, 'alta');
  assert.deepEqual(first?.measure, {kind: 'overflow', px: 90});
  assert.equal(hits.find(item => item.file.startsWith('/b '))?.severity, 'media');
});

test('cada padrão de sobra dispara; NÃO, R$ 10,00, Ação e nullable não', () => {
  const cases: [string, string][] = [
    ['Lorem ipsum dolor sit amet', 'lorem'],
    ['Olá, {{cliente.nome}}', 'modelo'],
    ['Total: ${pedido.total}', 'interpolacao'],
    ['Cliente [object Object]', 'objeto'],
    ['Saldo: [object Promise]', 'objeto'],
    ['undefined', 'valor'],
    ['Total: NaN', 'valor'],
    ['Vence em Invalid Date', 'valor'],
    ['AÃ§Ã£o', 'codificacao'],
    ['Itâ€™s', 'codificacao'],
    ['Caf�', 'codificacao'],
  ];
  for (const [text, kind] of cases) assert.equal(residueKind(text), kind, text);
  for (const text of ['NÃO', 'R$ 10,00', 'Ação', 'nullable', 'null', 'TODO', 'BANANA', 'undefinedness', 'São Paulo', 'MAÇÃ', 'Ãrea']) {
    assert.equal(residueKind(text), null, text);
  }
});

test('sobra vira um achado médio por tipo, sem medida', () => {
  const list = findings([
    cell('/a', 1440, {residue: [
      {kind: 'modelo', text40: 'Olá, {{cliente.nome}}', sel: 'p'},
      {kind: 'modelo', text40: '{{x}}', sel: 'span'},
      {kind: 'valor', text40: 'Total: NaN', sel: 'td'},
    ]}),
    cell('/a', 1440, {residue: [{kind: 'modelo', text40: '{{y}}', sel: 'p'}]}, 'escuro'),
  ]);
  const hits = only(list, DESIGN_RENDER_RULES.residue);
  assert.equal(hits.length, 2);
  for (const item of hits) {
    assert.equal(item.severity, 'media');
    assert.equal(item.measure, undefined);
  }
  assert.match(hits[0]?.snippet ?? '', /\{\{cliente\.nome\}\}/);
});

test('campo de 14px dá baixa; checkbox não dá nada', () => {
  const hits = only(findings([cell('/a', 375, {inputs: [
    {sel: 'input#email', type: 'email', fontPx: 14},
    {sel: 'input#aceite', type: 'checkbox', fontPx: 12},
    {sel: 'select#uf', type: 'select', fontPx: 16},
  ]})]), DESIGN_RENDER_RULES.zoom);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.severity, 'baixa');
  assert.match(hits[0]?.snippet ?? '', /input#email com fonte de 14px/);
  assert.deepEqual(only(findings([cell('/a', 375, {inputs: [{sel: 'input#aceite', type: 'checkbox', fontPx: 12}]})]), DESIGN_RENDER_RULES.zoom), []);
});

test('contraste de hover 2.9 dá alta com medida; foco é outro achado', () => {
  const list = findings([
    cell('/a', 1440, {states: [
      {label40: 'Assinar', state: 'hover', ratio: 2.9, need: 4.5},
      {label40: 'Entrar', state: 'hover', ratio: 3.4, need: 4.5},
      {label40: 'Grande', state: 'foco', ratio: 2.5, need: 3},
      {label40: 'Passa', state: 'foco', ratio: 5, need: 4.5},
    ]}),
  ]);
  const hits = only(list, DESIGN_RENDER_RULES.state);
  assert.equal(hits.length, 2);
  const hover = hits.find(item => item.snippet.includes('ao passar o mouse'));
  assert.equal(hover?.severity, 'alta');
  assert.deepEqual(hover?.measure, {kind: 'contrast', ratio: 2.9});
  assert.equal(clampHighSeverity('alta', hover?.measure), 'alta');
  assert.match(hover?.snippet ?? '', /"Assinar".*2\.90:1, mínimo 4\.5:1/);
  const focus = hits.find(item => item.snippet.includes('com foco'));
  assert.deepEqual(focus?.measure, {kind: 'contrast', ratio: 2.5});
});

test('animação de 48x48 dispara; 16x16 não', () => {
  const fires = only(findings([cell('/a', 1440, {motion: {running: [{sel: 'div.gira', w: 48, h: 48}]}})]), DESIGN_RENDER_RULES.motion);
  assert.equal(fires.length, 1);
  assert.equal(fires[0]?.severity, 'baixa');
  assert.equal(fires[0]?.measure, undefined);
  assert.deepEqual(only(findings([cell('/a', 1440, {motion: {running: [{sel: 'i.icone', w: 16, h: 16}]}})]), DESIGN_RENDER_RULES.motion), []);
});

test('título repetido em 3 rotas dá um achado na primeira; a mesma rota em 3 larguras não', () => {
  const list = findings([
    cell('/a', 1440, {title: 'Painel'}),
    cell('/b', 1440, {title: 'Painel'}),
    cell('/c', 1440, {title: 'painel'}),
    cell('/d', 1440, {title: ''}),
    cell('/e', 1440, {title: ''}),
  ]);
  const hits = only(list, DESIGN_RENDER_RULES.title);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.file, '/a 1440 claro padrao');
  assert.equal(hits[0]?.severity, 'baixa');
  assert.match(hits[0]?.snippet ?? '', /3 rotas: \/a, \/b, \/c/);
  const same = findings([cell('/a', 375, {title: 'Painel'}), cell('/a', 768, {title: 'Painel'}), cell('/a', 1440, {title: 'Painel'})]);
  assert.deepEqual(only(same, DESIGN_RENDER_RULES.title), []);
});

test('texto cortado, imagem quebrada e gráfico sem nome são médios sem medida', () => {
  const list = findings([cell('/a', 1440, {
    clipped: [{sel: 'span.corte', text40: 'Nome muito comprido', px: 183}, {sel: 'td', text40: 'abc', px: 4}],
    images: [{path: '/foto.png'}, {path: '/foto.png'}],
    charts: [{sel: 'canvas', w: 300, h: 150}],
  })]);
  for (const rule of [DESIGN_RENDER_RULES.clipped, DESIGN_RENDER_RULES.image, DESIGN_RENDER_RULES.chart]) {
    const hits = only(list, rule);
    assert.equal(hits.length, 1, rule);
    assert.equal(hits[0]?.severity, 'media', rule);
    assert.equal(hits[0]?.measure, undefined, rule);
  }
  assert.match(only(list, DESIGN_RENDER_RULES.clipped)[0]?.snippet ?? '', /span\.corte.*183px.*e mais 1/);
  assert.match(only(list, DESIGN_RENDER_RULES.image)[0]?.snippet ?? '', /: \/foto\.png$/);
});

test('célula malformada sai; campo ou item malformado sai sozinho; limites valem', () => {
  const cells = parseRenderCells([
    null,
    'texto',
    {route: 'sem-barra', viewport: 375, theme: 'claro', state: 'padrao'},
    {route: '/a b', viewport: 375, theme: 'claro', state: 'padrao'},
    {route: '/a', viewport: 500, theme: 'claro', state: 'padrao'},
    {route: '/a', viewport: 375, theme: 'roxo', state: 'padrao'},
    {route: '/a', viewport: 375, theme: 'claro', state: 'com espaço'},
    {
      route: '/ok', viewport: 375, theme: 'claro', state: 'padrao', extra: 'ignorado',
      overflow: {px: Number.NaN, clip: false, offenders: []},
      clipped: [{sel: 'a', text40: 'x', px: Number.NaN}, {sel: 'b', text40: 'y'.repeat(300), px: 3}, ...Array.from({length: 20}, () => ({sel: 'c', text40: 'z', px: 2}))],
      states: [{label40: 'x', state: 'hover', ratio: 0.5, need: 4.5}, {label40: 'y', state: 'clique', ratio: 2, need: 4.5}],
      title: 7,
    },
  ]);
  assert.equal(cells.length, 1);
  const [ok] = cells;
  assert.equal(ok?.route, '/ok');
  assert.equal(ok?.overflow, undefined);
  assert.equal(ok?.title, undefined);
  assert.equal(ok?.clipped?.length, 10);
  assert.equal(ok?.clipped?.[0]?.text40.length, 40);
  assert.deepEqual(ok?.states, []);
  assert.equal(Object.hasOwn(ok ?? {}, 'extra'), false);
  assert.deepEqual(parseRenderCells({}), []);
  assert.equal(parseRenderCells(Array.from({length: 500}, () => ({route: '/a', viewport: 375, theme: 'claro', state: 'padrao'}))).length, 400);
});

test('texto da página perde controle e marca de direção antes do trecho', () => {
  const [hit] = findings([cell('/a', 1440, {residue: [{kind: 'modelo', text40: 'a‮{{x}}\u0007b', sel: 'p\nq'}]})]);
  assert.ok(hit);
  assert.doesNotMatch(hit.snippet, /[\u0000-\u001f‮]/);
  assert.match(hit.snippet, /p q: "a \{\{x\}\} b"/);
});

test('sonda: tela correta não lista nada e não sobra nada', () => {
  assert.deepEqual(probeOverflow([fake('main', {}, 375, [fake('p', {}, 343)])]), {px: 0, clip: false, offenders: []});
});

test('sonda: faixa larga entra; gaveta fixa e menu deslocado de lado não', () => {
  const read = probeOverflow([
    fake('div', {}, 520, [], 'largo'),
    fake('nav', {position: 'fixed'}, 695, [], 'gaveta'),
    fake('aside', {transform: 'matrix(1, 0, 0, 1, 320, 0)'}, 695, [fake('a', {}, 690)], 'menu'),
    fake('div', {translate: '100%'}, 750, [], 'aviso'),
    fake('div', {transform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 280, 0, 0, 1)'}, 655, [], 'painel'),
    fake('div', {overflowX: 'auto'}, 375, [fake('table', {}, 900)], 'rolagem'),
  ], {}, {}, {root: 520, body: 520});
  assert.deepEqual(read?.offenders, [{sel: 'div.largo', right: 520}]);
  assert.equal(read?.px, 145);
});

test('sonda: com html e body escondidos, a sobra vem do body', () => {
  const read = probeOverflow([fake('div', {}, 520, [], 'largo')], {overflowX: 'hidden'}, {overflowX: 'hidden'}, {root: 375, body: 520});
  assert.equal(read?.clip, true);
  assert.equal(read?.px, 145);
  const [hit] = only(findings([cell('/a', 375, {overflow: read})]), DESIGN_RENDER_RULES.overflow);
  assert.match(hit?.snippet ?? '', /conteúdo cortado na lateral/);
});

test('sonda: com body escondido, gaveta fixa fora da tela não gera achado', () => {
  const read = probeOverflow([fake('nav', {position: 'fixed'}, 695, [], 'gaveta')], {}, {overflowX: 'hidden'});
  assert.deepEqual(read, {px: 0, clip: true, offenders: []});
  assert.deepEqual(findings([cell('/a', 375, {overflow: read})]), []);
});
