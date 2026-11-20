import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Refusal } from '../src/contracts.ts';
import { parsePersonalMapaArgs } from '../src/personal-mapa-cli.ts';
import {
  detectLanguage,
  discoverFiles,
  estimateTokens,
  extractGoSignatures,
  extractPySignatures,
  extractTSSignatures,
  formatRepoMap,
  generateRepoMap,
  generateRepoMapSafe,
} from '../src/repo-map.ts';

test('detectLanguage correctly classifies extensions', () => {
  assert.equal(detectLanguage('src/app.ts'), 'ts');
  assert.equal(detectLanguage('components/button.tsx'), 'ts');
  assert.equal(detectLanguage('index.js'), 'ts');
  assert.equal(detectLanguage('cmd/main.go'), 'go');
  assert.equal(detectLanguage('scripts/worker.py'), 'py');
  assert.equal(detectLanguage('db/schema.sql'), 'unsupported');
  assert.equal(detectLanguage('deploy.sh'), 'unsupported');
});

test('unit signature extraction for TS, Go and Python', () => {
  const tsCode = `
export interface User { id: string; name: string }
export type UserRole = 'admin' | 'subscriber';
export class UserService extends BaseService {
  async getUser(id: string): Promise<User> { return {} as any; }
}
export async function createUser(data: User): Promise<string> { return 'ok'; }
export const handler = (req: Request): Response => new Response();
app.get('/api/users', handler);
export default UserService;
`;
  const tsSigs = extractTSSignatures(tsCode);
  assert.ok(tsSigs.some(s => s.includes('ROUTE: GET /api/users')), 'Route extracted');
  assert.ok(tsSigs.some(s => s.includes('interface User')), 'Interface extracted');
  assert.ok(tsSigs.some(s => s.includes('type UserRole')), 'Type extracted');
  assert.ok(tsSigs.some(s => s.includes('class UserService')), 'Class extracted');
  assert.ok(tsSigs.some(s => s.includes('getUser(id: string): Promise<User>')), 'Class method extracted');
  assert.ok(tsSigs.some(s => s.includes('function createUser')), 'Function extracted');
  assert.ok(tsSigs.some(s => s.includes('const handler')), 'Arrow function extracted');
  assert.ok(tsSigs.some(s => s.includes('export default UserService')), 'Default export extracted');

  const goCode = `
package main

type Config struct {
  Port int
}
type Runner interface {
  Run() error
}

func main() {}

func (c *Config) Validate() error {
  return nil
}

// Route
huma.Register(api, huma.Operation{Method: "POST", Path: "/api/orders"}, nil)
r.Get("/health", healthHandler)
`;
  const goSigs = extractGoSignatures(goCode);
  assert.ok(goSigs.includes('package main'), 'Go package extracted');
  assert.ok(goSigs.some(s => s.includes('type Config struct')), 'Go struct extracted');
  assert.ok(goSigs.some(s => s.includes('type Runner interface')), 'Go interface extracted');
  assert.ok(goSigs.some(s => s.includes('func main()')), 'Go func extracted');
  assert.ok(goSigs.some(s => s.includes('func (c *Config) Validate() error')), 'Go method extracted');
  assert.ok(goSigs.some(s => s.includes('ROUTE: POST /api/orders')), 'Go huma route extracted');
  assert.ok(goSigs.some(s => s.includes('ROUTE: GET /health')), 'Go chi route extracted');

  const pyCode = `
class DataProcessor(BaseProcessor):
    def __init__(self, name: str):
        self.name = name

@app.get("/items/{item_id}")
def get_item(item_id: int) -> dict:
    return {"id": item_id}

async def fetch_remote() -> bool:
    return True

__all__ = ['DataProcessor', 'get_item']
`;
  const pySigs = extractPySignatures(pyCode);
  assert.ok(pySigs.some(s => s.includes('class DataProcessor(BaseProcessor)')), 'Py class extracted');
  assert.ok(pySigs.some(s => s.includes('ROUTE: GET /items/{item_id}')), 'Py route extracted');
  assert.ok(pySigs.some(s => s.includes('def get_item(item_id: int) -> dict')), 'Py def extracted');
  assert.ok(pySigs.some(s => s.includes('async def fetch_remote() -> bool')), 'Py async def extracted');
  assert.ok(pySigs.some(s => s.includes('__all__ =')), 'Py __all__ extracted');
});

test('fixture repo map: TS, Go, Python and unsupported language [não mapeada]', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repo-map-fixture-'));
  try {
    // TS file
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'src/user.ts'),
      `export interface User { id: string }\nexport function getUser(): User { return { id: '1' }; }\n`
    );

    // Go file
    await mkdir(join(root, 'cmd'), { recursive: true });
    await writeFile(
      join(root, 'cmd/main.go'),
      `package main\n\nfunc main() {}\n`
    );

    // Python file
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(
      join(root, 'scripts/worker.py'),
      `class Worker:\n    pass\n\ndef run():\n    pass\n`
    );

    // Unsupported language file
    await mkdir(join(root, 'db'), { recursive: true });
    await writeFile(
      join(root, 'db/schema.sql'),
      `CREATE TABLE users (id serial primary key);\n`
    );

    const result = await generateRepoMap({
      repoPath: root,
      budgetTokens: 4000,
      useCache: false,
    });

    assert.equal(result.totalCandidateFiles, 4);
    assert.equal(result.includedFiles, 4);
    assert.equal(result.omittedFiles, 0);

    // Check TS
    assert.ok(result.map.includes('src/user.ts [ts]'));
    assert.ok(result.map.includes('interface User'));
    assert.ok(result.map.includes('function getUser'));

    // Check Go
    assert.ok(result.map.includes('cmd/main.go [go]'));
    assert.ok(result.map.includes('package main'));
    assert.ok(result.map.includes('func main()'));

    // Check Python
    assert.ok(result.map.includes('scripts/worker.py [py]'));
    assert.ok(result.map.includes('class Worker'));
    assert.ok(result.map.includes('def run()'));

    // Check unsupported language
    assert.ok(result.map.includes('db/schema.sql [não mapeada]'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('budget limit and prioritization by incoming references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repo-map-budget-'));
  try {
    // File A: heavily referenced
    await writeFile(
      join(root, 'core.ts'),
      `export interface CoreConfig { debug: boolean }\nexport function initCore(): void {}\n`
    );

    // File B: references A
    await writeFile(
      join(root, 'client1.ts'),
      `import { CoreConfig } from './core';\nexport function use1() {}\n`
    );

    // File C: references A
    await writeFile(
      join(root, 'client2.ts'),
      `import { CoreConfig } from './core';\nexport function use2() {}\n`
    );

    // File D: unreferenced utility
    await writeFile(
      join(root, 'extra.ts'),
      `export function extra() {}\n`
    );

    // Small budget allowing only the most referenced files
    const budgetTokens = 50;
    const result = await generateRepoMap({
      repoPath: root,
      budgetTokens,
      useCache: false,
    });

    assert.ok(result.estimatedTokens <= budgetTokens, `Tokens ${result.estimatedTokens} must be <= budget ${budgetTokens}`);
    assert.ok(result.omittedFiles > 0, 'Some files must be omitted due to tight budget');
    // The most referenced file (core.ts) must be included
    assert.ok(result.map.includes('core.ts [ts]'), 'Heavily referenced file core.ts must be prioritized');
    assert.ok(result.map.includes('arquivos omitidos pelo limite de orçamento'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('commit cache storage and reuse with 0600 permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repo-map-cache-repo-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'repo-map-cache-data-'));
  try {
    git(root, 'init', '-q');
    await writeFile(join(root, 'app.ts'), 'export const COMMITTED = true;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'first');
    const commit = git(root, 'rev-parse', 'HEAD');
    await writeFile(join(root, 'app.ts'), 'export const LATER = true;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'second');
    await writeFile(join(root, 'app.ts'), 'export const DIRTY = true;\n');
    await writeFile(join(root, 'untracked.ts'), 'export const UNTRACKED = true;\n');

    const projectId = '00000000-0000-0000-0000-000000000001';

    // 1st run: writes cache
    const res1 = await generateRepoMap({
      repoPath: root,
      projectId,
      commit,
      dataDirectory: dataDir,
      useCache: true,
    });
    assert.equal(res1.fromCache, false, 'First run should not be from cache');
    assert.match(res1.map, /export const COMMITTED/);
    assert.doesNotMatch(res1.map, /LATER|DIRTY|UNTRACKED/);

    const expectedCacheFile = join(dataDir, 'mapas', projectId, `${commit}.json`);
    const fileStat = await stat(expectedCacheFile);
    assert.ok(fileStat.isFile(), 'Cache file must exist');
    // Mode should be 0600 (-rw-------)
    assert.equal(fileStat.mode & 0o777, 0o600, 'Cache file permissions must be 0600');

    // 2nd run: loads from cache
    const res2 = await generateRepoMap({
      repoPath: root,
      projectId,
      commit: commit.slice(0, 12),
      dataDirectory: dataDir,
      useCache: true,
    });
    assert.equal(res2.fromCache, true, 'Second run must load from cache');
    assert.equal(res2.map, res1.map, 'Map output from cache must match original');
    const head = await generateRepoMap({ repoPath: root, projectId, dataDirectory: dataDir, useCache: false });
    assert.match(head.map, /export const LATER/);
    assert.doesNotMatch(head.map, /COMMITTED|DIRTY|UNTRACKED/);
    await assert.rejects(generateRepoMap({ repoPath: root, commit: '../arbitrary', dataDirectory: dataDir, projectId }), /commit/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('safe wrapper handles generator failure without throwing or breaking job', async () => {
  // Pass non-existent directory to provoke error
  const nonExistentPath = join(tmpdir(), 'non-existent-repo-path-12345');
  const safeRes = await generateRepoMapSafe({
    repoPath: nonExistentPath,
    commit: 'fail-commit',
    useCache: false,
  });

  assert.equal(safeRes.map, null, 'Safe generator must return null map on failure');
  assert.equal(safeRes.estimatedTokens, 0, 'Estimated tokens must be 0 on failure');
  assert.ok(safeRes.reason, 'Failure reason must be recorded');
});

test('scope filtering restricts output to specified folders or files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repo-map-scope-'));
  try {
    await mkdir(join(root, 'apps/web'), { recursive: true });
    await mkdir(join(root, 'apps/api'), { recursive: true });
    await mkdir(join(root, 'apps/web-tools'), { recursive: true });
    await mkdir(join(root, 'infra'), { recursive: true });

    await writeFile(join(root, 'apps/web/page.tsx'), `export default function Page() {}\n`);
    await writeFile(join(root, 'apps/web-tools/tool.ts'), 'export const sibling = true;\n');
    await writeFile(join(root, 'apps/api/server.go'), `package main\nfunc main() {}\n`);
    await writeFile(join(root, 'infra/deploy.sh'), `#!/bin/bash\n`);

    const scopedRes = await generateRepoMap({
      repoPath: root,
      scope: ['apps/web'],
      useCache: false,
    });

    assert.equal(scopedRes.totalCandidateFiles, 1);
    assert.ok(scopedRes.map.includes('apps/web/page.tsx'));
    assert.ok(!scopedRes.map.includes('apps/api/server.go'));
    assert.ok(!scopedRes.map.includes('apps/web-tools/tool.ts'));
    assert.ok(!scopedRes.map.includes('infra/deploy.sh'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI argument parser handles valid and invalid arguments', () => {
  const parsed = parsePersonalMapaArgs([
    '/path/to/installation.json',
    'proj-uuid-123',
    '--escopo',
    'apps/web',
    'apps/api',
    '--orcamento',
    '2500',
  ]);

  assert.equal(parsed.installationPath, '/path/to/installation.json');
  assert.equal(parsed.projectId, 'proj-uuid-123');
  assert.deepEqual(parsed.scope, ['apps/web', 'apps/api']);
  assert.equal(parsed.budgetTokens, 2500);

  // Missing required args throws MAPA_USAGE
  assert.throws(() => parsePersonalMapaArgs(['/path/to/installation.json']), (err: any) => err instanceof Refusal && err.code === 'MAPA_USAGE');
  assert.throws(() => parsePersonalMapaArgs([]), (err: any) => err instanceof Refusal && err.code === 'MAPA_USAGE');
  // Invalid flag
  assert.throws(() => parsePersonalMapaArgs(['inst.json', 'proj', '--invalid']), (err: any) => err instanceof Refusal && err.code === 'MAPA_USAGE');
});


function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Repo Map Test', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
}

test('oversized signatures and tiny budgets respect the configured limit', () => {
  const files = [
    { path: 'app.ts', language: 'ts' as const, signatures: ['X'.repeat(10000), 'export function visible()'], references: 10 },
    { path: 'a.ts', language: 'ts' as const, signatures: ['export const a'], references: 0 },
  ];
  for (const budget of [0, 1, 6, 15, 50, 200]) {
    const result = formatRepoMap(files, budget, 'a'.repeat(40), files.length);
    assert.equal(result.estimatedTokens, estimateTokens(result.text));
    assert.ok(result.estimatedTokens <= budget);
    assert.equal(result.includedCount + result.omittedCount, files.length);
  }
  const result = formatRepoMap(files, 50, 'a'.repeat(40), files.length);
  assert.match(result.text, /app\.ts \[ts\]/);
  assert.match(result.text, /export function visible\(\)/);
  assert.doesNotMatch(result.text, /XXX/);
});

test('reads paths containing spaces, tabs, Unicode and line breaks from Git', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repo-map-path-'));
  try {
    git(root, 'init', '-q');
    const path = ' código\tcom\nquebra.ts';
    await writeFile(join(root, path), 'export const ODD_PATH = true;\n');
    assert.deepEqual(await discoverFiles(root), [path]);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'odd path');
    const result = await generateRepoMap({ repoPath: root, scope: [path] });
    assert.equal(result.totalCandidateFiles, 1);
    assert.match(result.map, /export const ODD_PATH/);
    assert.ok(result.map.includes(JSON.stringify(path)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unversioned snapshots scope reads and skip symbolic links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repo-map-snapshot-'));
  try {
    git(root, 'init', '-q');
    git(root, 'commit', '--allow-empty', '-qm', 'ancestor');
    const snapshot = join(root, 'snapshot');
    await mkdir(join(snapshot, 'src'), { recursive: true });
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.ts'), 'export const SECRET = true;\n');
    await symlink(join(outside, 'secret.ts'), join(snapshot, 'src/secret.ts'));
    await symlink(outside, join(snapshot, 'src/elsewhere'));
    await writeFile(join(snapshot, 'src/core.ts'), 'export const CORE = true;\n');
    await writeFile(join(snapshot, 'other.ts'), 'import { CORE } from "./src/core";\n');
    const result = await generateRepoMap({
      repoPath: snapshot, source: 'directory', scope: ['src'], projectId: 'test', dataDirectory: root,
    });
    assert.equal(result.commit, 'unversioned');
    assert.equal(result.fromCache, false);
    assert.equal(result.totalCandidateFiles, 1);
    assert.match(result.map, /export const CORE/);
    assert.doesNotMatch(result.map, /SECRET|refs:|elsewhere/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extracts multiline signatures, nested parameters, exports and routes', () => {
  const ts = extractTSSignatures(`
export type { User } from './types';
export {
  App,
  Service as API,
} from './app';
export * as routes from './routes';
export const NAME = "body data";
export const handler = async (
  callback: (n: number) => void,
): Promise<void> => callback(4);
export class Service<T> {
  public find(
    filter: (item: T) => boolean,
  ): T | undefined { return undefined; }
}
export function load<T extends Promise<string>>(
  id: string,
): { value: T } { return readFromDatabase(id); }
router.get(
  "/api/items",
  handler,
);
`);
  assert.ok(ts.includes("export type { User } from './types'"), ts.join('\n'));
  assert.ok(ts.includes("export { App, Service as API, } from './app'"), ts.join('\n'));
  assert.ok(ts.includes("export * as routes from './routes'"), ts.join('\n'));
  assert.ok(ts.includes('export const NAME'));
  assert.ok(ts.includes('export const handler = async (callback: (n: number) => void,): Promise<void>'));
  assert.ok(ts.includes('  public find(filter: (item: T) => boolean,): T | undefined'));
  assert.ok(ts.includes('export function load<T extends Promise<string>>(id: string,): { value: T }'));
  assert.ok(ts.includes('ROUTE: GET /api/items'));
  assert.doesNotMatch(ts.join('\n'), /body data|readFromDatabase/);

  const go = extractGoSignatures(`
package main
func (s *Service) Find(
  validate func(string) bool,
) (string, error) { return "", nil }
r.Get(
  "/health",
  health,
)
`);
  assert.ok(go.includes('func (s *Service) Find(validate func(string) bool,) (string, error)'));
  assert.ok(go.includes('ROUTE: GET /health'));

  const py = extractPySignatures(`
"""
def fake(): ...
"""
@app.get(
    "/api/items",
)
async def items(
    name: str = default_name(),
) -> dict[str, tuple[str, int]]:
    return {}
__all__ = [
    'items',
]
`);
  assert.ok(py.includes('async def items(name: str = default_name(),) -> dict[str, tuple[str, int]]'));
  assert.ok(py.includes('ROUTE: GET /api/items'));
  assert.ok(py.includes("__all__ = [ 'items', ]"));
  assert.ok(!py.some(signature => signature.includes('fake')));
});
