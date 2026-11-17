import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {
  discoverRoutesFromSource,
  missingEmptyStateFindings,
  publicLoginRecord,
  screenCoverageMarkdown,
  sourceHasEmptyState,
  type DiscoveredRoute,
} from '../src/design-discover.ts';

const reactLines = [
  'export function App() {',
  '  return (',
  '    <Routes>',
  '      <Route path="/contraste" element={<Contraste />} />',
  '      <Route element={<span>texto</span>} path="/botao" />',
  '      <Route aria-label="a>b" path="/aspas" />',
  '      {/* path: "/oculto" */}',
  '    </Routes>',
  '  );',
  '}',
  'export const router = [',
  '  {path: "/foco"},',
  '  {path: "equipe"},',
  '  // path: "/comentario"',
  '];',
];

const vueLines = [
  'const routes = [',
  '  { path: \'/vue-inicio\', component: Inicio },',
  '  { path: "/vue-item" },',
  '];',
];

const dartLines = [
  'GoRoute(',
  '  builder: (context, state) => const Home(),',
  '),',
  'GoRoute(',
  '  path: \'/flutter-inicio\',',
  '),',
  'GoRoute(',
  '  path: "/flutter-item",',
  '  routes: <GoRoute>[],',
  ')',
];

function lineNo(lines: readonly string[], needle: string): number {
  const index = lines.findIndex(line => line.includes(needle));
  assert.ok(index >= 0, needle);
  return index + 1;
}

function routesOf(found: readonly DiscoveredRoute[], file: string): string[] {
  return found.filter(item => item.file === file).map(item => item.route);
}

test('descobre rotas React, Next, Vue e Flutter sem inventar caminho', () => {
  const found = discoverRoutesFromSource([
    {path: 'src/App.tsx', text: reactLines.join('\n')},
    {path: 'src/router/index.ts', text: vueLines.join('\n')},
    {path: 'lib/routes.dart', text: dartLines.join('\n')},
    {path: 'page.tsx', text: 'export default function Page(){return null}\n'},
    {path: 'src/app/page.tsx', text: 'export default function Page(){return null}\n'},
    {path: 'src/pages/index.tsx', text: 'export default function Home(){return null}\n'},
    {path: 'src/pages/foo/index.tsx', text: 'export default function Page(){return null}\n'},
    {path: 'src/app/foo/page.tsx', text: 'export default function Page(){return null}\n<Route path="/extra" />\n'},
    {path: 'src/app/(grupo)/bar/page.tsx', text: 'export default function Page(){return null}\n'},
    {path: 'src/app/@modal/(grupo)/foto/page.tsx', text: 'export default function Page(){return null}\n'},
    {path: 'src/pages/_app.tsx', text: 'export default function App(){return null}\n'},
    {path: 'src/pages/api/health.ts', text: 'export default function health(){return null}\n'},
    {path: 'src/app/foo/layout.tsx', text: 'export default function Layout(){return null}\n'},
    {path: 'src/components/Menu.tsx', text: 'const help = "abra /admin pelo menu";\nexport function Link(){return <a href="/admin">Admin</a>;}\nconst destino = "/admin";\n'},
  ]);
  assert.equal(found.length, 17);
  assert.equal(new Set(found.map(item => item.id)).size, found.length);
  assert.ok(found.every(item => item.source === 'codigo' && item.line >= 1 && item.title.length > 0));
  assert.deepEqual(routesOf(found, 'src/App.tsx'), ['/contraste', '/botao', '/aspas', '/foco', '/equipe']);
  assert.deepEqual(found.filter(item => item.file === 'src/App.tsx').map(item => item.line), [
    lineNo(reactLines, '/contraste'),
    lineNo(reactLines, '/botao'),
    lineNo(reactLines, '/aspas'),
    lineNo(reactLines, '/foco'),
    lineNo(reactLines, 'equipe'),
  ]);
  const contraste = found.find(item => item.route === '/contraste');
  assert.equal(contraste?.title, 'Contraste');
  assert.equal(contraste?.id, 'contraste');
  assert.deepEqual(routesOf(found, 'src/router/index.ts'), ['/vue-inicio', '/vue-item']);
  assert.deepEqual(found.filter(item => item.file === 'src/router/index.ts').map(item => item.line), [
    lineNo(vueLines, '/vue-inicio'),
    lineNo(vueLines, '/vue-item'),
  ]);
  assert.equal(found.find(item => item.route === '/vue-inicio')?.title, 'Vue inicio');
  assert.deepEqual(routesOf(found, 'lib/routes.dart'), ['/flutter-inicio', '/flutter-item']);
  assert.deepEqual(found.filter(item => item.file === 'lib/routes.dart').map(item => item.line), [
    lineNo(dartLines, '/flutter-inicio'),
    lineNo(dartLines, '/flutter-item'),
  ]);
  assert.equal(found.filter(item => item.route === '/flutter-inicio').length, 1);
  const root = found.find(item => item.file === 'page.tsx');
  assert.equal(root?.route, '/');
  assert.equal(root?.line, 1);
  assert.equal(root?.title, 'Início');
  assert.equal(root?.id, 'raiz');
  assert.equal(found.find(item => item.file === 'src/app/page.tsx')?.route, '/');
  assert.equal(found.find(item => item.file === 'src/pages/index.tsx')?.route, '/');
  assert.equal(found.find(item => item.file === 'src/pages/foo/index.tsx')?.route, '/foo');
  assert.equal(found.find(item => item.file === 'src/pages/foo/index.tsx')?.title, 'Foo');
  assert.deepEqual(routesOf(found, 'src/app/foo/page.tsx'), ['/foo', '/extra']);
  assert.equal(found.find(item => item.file === 'src/app/(grupo)/bar/page.tsx')?.route, '/bar');
  assert.equal(found.find(item => item.file === 'src/app/@modal/(grupo)/foto/page.tsx')?.route, '/foto');
  assert.equal(found.some(item => item.route.includes('(grupo)') || item.route.includes('@modal') || item.route === '/foo/index'), false);
  assert.equal(found.some(item => item.route === '/oculto' || item.route === '/comentario' || item.route === '/admin'), false);
  assert.equal(found.some(item => item.file.endsWith('_app.tsx') || item.file.includes('/api/') || item.file.endsWith('layout.tsx') || item.file.endsWith('Menu.tsx')), false);
});

test('descobre as dez rotas da regua em JSX e em objeto', () => {
  const routes = ['/contraste', '/botao', '/foco', '/cinzas', '/espaco', '/itens', '/estreito', '/cortado', '/boa-inicio', '/boa-detalhe'];
  const jsx = routes.map(route => `<Route path="${route}" element={<Pagina />} />`).join('\n');
  const objects = `export const router = [\n${routes.map(route => `  { path: '${route}' },`).join('\n')}\n];\n`;
  const fromJsx = discoverRoutesFromSource([{path: 'tests/fixtures/design-lab/src/App.tsx', text: jsx}]);
  const fromObjects = discoverRoutesFromSource([{path: 'src/routes.ts', text: objects}]);
  assert.deepEqual(fromJsx.map(item => item.route), routes);
  assert.deepEqual(fromObjects.map(item => item.route), routes);
  assert.equal(fromJsx[0]?.line, 1);
  assert.equal(fromJsx[9]?.line, 10);
});

test('rota com parametro nao abre o texto literal', () => {
  const jsx = [
    '<Route path="/p/:projectId" element={<Projeto />} />',
    '<Route path="/tasks/:id/*" element={<Tarefa />} />',
    '<Route path="/p/:projectId/tarefas" example="/p/projeto/tarefas" />',
    '<Route path="/inbox/:id" example={"/inbox/1"} />',
    '<Route path="/equipe" />',
    '<Route path="*" />',
    '<Route path="/files/*" example="/p/:projectId" />',
  ].join('\n');
  const objects = [
    'export const router = [',
    '  { path: \'/tasks/:id\', element: Tarefa },',
    '  { path: \'/tasks/:id\', example: \'/tasks/1\' },',
    '  { example: \'/inbox/1\', path: \'/inbox/:id\' },',
    '  { path: \'/blog/[...slug]\' },',
    '  { path: \'/ajustes\' },',
    '];',
  ].join('\n');
  const fromJsx = discoverRoutesFromSource([{path: 'src/App.tsx', text: jsx}]);
  assert.deepEqual(fromJsx.map(item => item.route), ['/p/projeto/tarefas', '/inbox/1', '/equipe']);
  const fromObjects = discoverRoutesFromSource([{path: 'src/routes.ts', text: objects}]);
  assert.deepEqual(fromObjects.map(item => item.route), ['/tasks/1', '/inbox/1', '/ajustes']);
  const files = discoverRoutesFromSource([
    {path: 'src/pages/tasks/[id].tsx', text: 'export default function Page(){return null}\n'},
    {path: 'src/app/p/[projectId]/page.tsx', text: 'export default function Page(){return null}\n'},
    {path: 'src/app/blog/[...slug]/page.tsx', text: 'export default function Page(){return null}\n'},
    {path: 'src/app/docs/[[...slug]]/page.tsx', text: 'export default function Page(){return null}\n'},
    {path: 'src/pages/ajustes.tsx', text: 'export default function Page(){return null}\n'},
  ]);
  assert.deepEqual(files.map(item => item.route), ['/ajustes']);
});

test('estado vazio ausente quando ha lista e nao ha marcador de vazio', () => {
  const lines = [
    'export function Itens() {',
    '  return (',
    '    <ul data-list>',
    '      {items.map((item) => <li key={item}>{item}</li>)}',
    '    </ul>',
    '  );',
    '}',
  ];
  const text = lines.join('\n');
  const findings = missingEmptyStateFindings('src/Itens.tsx', text);
  assert.equal(findings.length, 1);
  const finding = findings[0];
  assert.ok(finding);
  assert.equal(finding.rule, 'ESTADOS-VAZIO-AUSENTE');
  assert.equal(finding.tool, 'html');
  assert.equal(finding.severity, 'media');
  assert.equal(finding.cwe, null);
  assert.equal(finding.file, 'src/Itens.tsx');
  assert.equal(finding.line, 3);
  assert.match(finding.snippet, /data-list/);
  assert.match(finding.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(missingEmptyStateFindings('src/Itens.tsx', `${text}\n<p>Nenhum item</p>`).length, 1);
  assert.equal(missingEmptyStateFindings('src/Itens.tsx', `${text}\n<div data-empty></div>`).length, 1);
  assert.equal(missingEmptyStateFindings('src/Itens.tsx', `${text}\n<div class="empty-state"></div>`).length, 1);
  const withMarkerInside = (marker: string) => text.replace('  return (', `  ${marker}\n  return (`);
  assert.equal(missingEmptyStateFindings('src/Itens.tsx', withMarkerInside('<p>Nenhum item</p>')).length, 0);
  assert.equal(missingEmptyStateFindings('src/Itens.tsx', withMarkerInside('<div data-empty></div>')).length, 0);
  assert.equal(missingEmptyStateFindings('src/Itens.tsx', withMarkerInside('<div class="empty-state"></div>')).length, 0);
  assert.equal(missingEmptyStateFindings('src/Itens.tsx', withMarkerInside('// Nenhum item')).length, 1);
  assert.equal(missingEmptyStateFindings('src/BoaInicio.tsx', 'export function Boa(){return <p>Olá</p>}').length, 0);
  assert.equal(missingEmptyStateFindings('src/Lista.tsx', '<div role="list"></div>').length, 1);
  assert.equal(missingEmptyStateFindings('src/Lista.tsx', '<div role={"list"}></div>').length, 1);
  assert.equal(missingEmptyStateFindings('src/Lista.tsx', '<div role={\'list\'}></div>').length, 1);
  assert.equal(missingEmptyStateFindings('src/Lista.tsx', 'const rows = items.map((item) => item);').length, 0);
  assert.equal(missingEmptyStateFindings('src/Lista.tsx', 'visibleSettingsSections(project).map(section => section.id)').length, 0);
  const mapped = missingEmptyStateFindings('src/Lista.tsx', '<ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>');
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0]?.severity, 'media');
  assert.equal(mapped[0]?.rule, 'ESTADOS-VAZIO-AUSENTE');
  assert.deepEqual(missingEmptyStateFindings('src/Nav.tsx', '<ul><li><a href="/">Início</a></li></ul>'), []);
  assert.equal(missingEmptyStateFindings('src/Lista.tsx', '<ol></ol>').length, 1);
  assert.equal(missingEmptyStateFindings('src/Lista.tsx', '<div role="listbox"></div>').length, 0);
  assert.equal(missingEmptyStateFindings('src/Lista.tsx', 'const rows = items.map((item) => item);\nnenhum item').length, 0);
  assert.equal(missingEmptyStateFindings('src/Lista.tsx', '<ul data-list></ul>\nnenhum item').length, 1);
  assert.equal(missingEmptyStateFindings('src/Lista.tsx', '<ul></ul>\nif (items.length === 0) return null;').length, 0);
  assert.equal(missingEmptyStateFindings('src/Lista.tsx', '<ul></ul>\nif (items.length == 0) return null;').length, 0);
  assert.equal(missingEmptyStateFindings('src/Lista.tsx', '<ul></ul>\n{!items.length && ready}').length, 0);
  assert.equal(missingEmptyStateFindings('src/Lista.tsx', '<ul></ul>\n{items.length ? rows : null}').length, 0);
});

test('marcador de vazio fica no componente da lista', () => {
  const marked = [
    'export function ComMarcador() {',
    '  if (items.length === 0) return <p>Nenhum item</p>;',
    '  return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>;',
    '}',
  ].join('\n');
  const unmarked = [
    'export function SemMarcador() {',
    '  return <ul>{rows.map((row) => <li key={row}>{row}</li>)}</ul>;',
    '}',
  ].join('\n');
  assert.equal(missingEmptyStateFindings('src/Listas.tsx', marked).length, 0);
  const findings = missingEmptyStateFindings('src/Listas.tsx', `${marked}\n${unmarked}`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'media');
  assert.equal(findings[0]?.line, 6);
  const swapped = missingEmptyStateFindings('src/Listas.tsx', `${unmarked}\n${marked}`);
  assert.equal(swapped.length, 1);
  assert.equal(swapped[0]?.severity, 'media');
  assert.equal(swapped[0]?.line, 2);
  const elsewhere = [
    'export function Lista() {',
    '  return <ol>{items.map((item) => <li key={item}>{item}</li>)}</ol>;',
    '}',
    'function Aviso() {',
    '  return <p>Nenhum item</p>;',
    '}',
  ].join('\n');
  const hidden = missingEmptyStateFindings('src/Listas.tsx', elsewhere);
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0]?.severity, 'media');
  assert.equal(hidden[0]?.line, 2);
  const arrows = [
    'const Cheia = () => {',
    '  if (!items.length) return null;',
    '  return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>;',
    '};',
    'const Vazia = () => (',
    '  <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>',
    ');',
  ].join('\n');
  const arrowFindings = missingEmptyStateFindings('src/Listas.tsx', arrows);
  assert.equal(arrowFindings.length, 1);
  assert.equal(arrowFindings[0]?.severity, 'media');
  assert.equal(arrowFindings[0]?.line, 6);
});

test('a fonte diz se a rota tem estado vazio', () => {
  const list = 'export function Tela() {\n  return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>;\n}\n';
  assert.equal(sourceHasEmptyState(list), false);
  assert.equal(sourceHasEmptyState(`${list}\nfunction Aviso() {\n  return <p>Nenhum item</p>;\n}\n`), true);
  assert.equal(sourceHasEmptyState('export function Tela() {\n  // Nenhum item\n  return <ul></ul>;\n}\n'), false);
  assert.equal(sourceHasEmptyState('export function Tela() {\n  if (items.length === 0) return null;\n  return <ul></ul>;\n}\n'), true);
});

test('tabela de cobertura em portugues', () => {
  const markdown = screenCoverageMarkdown([
    {screenId: 'itens', route: '/itens', file: 'src/Itens.tsx', fromCode: true, fromNavigation: false, captures: 3},
    {screenId: 'a|b', route: '/nav', file: 'src/Nav.tsx', fromCode: false, fromNavigation: true, captures: 0},
  ]);
  assert.match(markdown, /\| Tela \| Rota \| Arquivo \| No código \| Na navegação \| Capturas \|/);
  assert.match(markdown, /\| itens \| \/itens \| src\/Itens\.tsx \| sim \| não \| 3 \|/);
  assert.equal(markdown.includes('a\\|b'), true);
  assert.match(markdown, /\| não \| sim \| 0 \|/);
  assert.match(markdown, /Total: 2 telas\./);
  assert.match(screenCoverageMarkdown([]), /Total: 0 telas\./);
});

test('registro publico de login nunca serializa a senha', () => {
  const secret = 'correta-senha-9f3';
  const record = publicLoginRecord({
    username: 'ada',
    password: secret,
    usernameSelector: '#usuario',
    passwordSelector: '#senha',
    submitSelector: 'button[type=submit]',
  });
  assert.deepEqual(record, {
    username: 'ada',
    usernameSelector: '#usuario',
    passwordSelector: '#senha',
    submitSelector: 'button[type=submit]',
  });
  assert.equal(record !== undefined && Object.hasOwn(record, 'password'), false);
  assert.equal(JSON.stringify(record).includes(secret), false);
  assert.equal(publicLoginRecord(undefined), undefined);
  const empty = publicLoginRecord({
    username: 'ada',
    password: '',
    usernameSelector: '#usuario',
    passwordSelector: '#senha',
    submitSelector: 'button[type=submit]',
  });
  assert.equal(empty?.username, 'ada');
  assert.throws(
    () => publicLoginRecord({
      username: 'ada',
      password: 'ada',
      usernameSelector: '#usuario',
      passwordSelector: '#senha',
      submitSelector: 'button[type=submit]',
    }),
    (error: unknown) => {
      assert.ok(error instanceof Refusal);
      if (!(error instanceof Refusal)) return false;
      assert.equal(error.code, 'DESIGN_PASSWORD_LEAK');
      return true;
    },
  );
  assert.throws(
    () => publicLoginRecord({
      username: 'ada',
      password: 'senha',
      usernameSelector: '#usuario',
      passwordSelector: '#senha',
      submitSelector: 'button[type=submit]',
    }),
    (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_PASSWORD_LEAK',
  );
});
