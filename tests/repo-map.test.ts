import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Refusal } from '../src/contracts.ts';
import { parsePersonalMapaArgs } from '../src/personal-mapa-cli.ts';
import {
  detectLanguage,
  estimateTokens,
  extractGoSignatures,
  extractPySignatures,
  extractTSSignatures,
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
      commit: 'test-commit-001',
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
      commit: 'test-budget-commit',
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
    await writeFile(join(root, 'app.ts'), `export const APP_NAME = "TestApp";\n`);

    const projectId = '00000000-0000-0000-0000-000000000001';
    const commit = 'a1b2c3d4e5f67890123456789012345678901234';

    // 1st run: writes cache
    const res1 = await generateRepoMap({
      repoPath: root,
      projectId,
      commit,
      dataDirectory: dataDir,
      useCache: true,
    });
    assert.equal(res1.fromCache, false, 'First run should not be from cache');

    const expectedCacheFile = join(dataDir, 'mapas', projectId, `${commit}.json`);
    const fileStat = await stat(expectedCacheFile);
    assert.ok(fileStat.isFile(), 'Cache file must exist');
    // Mode should be 0600 (-rw-------)
    assert.equal(fileStat.mode & 0o777, 0o600, 'Cache file permissions must be 0600');

    // 2nd run: loads from cache
    const res2 = await generateRepoMap({
      repoPath: root,
      projectId,
      commit,
      dataDirectory: dataDir,
      useCache: true,
    });
    assert.equal(res2.fromCache, true, 'Second run must load from cache');
    assert.equal(res2.map, res1.map, 'Map output from cache must match original');
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
    await mkdir(join(root, 'infra'), { recursive: true });

    await writeFile(join(root, 'apps/web/page.tsx'), `export default function Page() {}\n`);
    await writeFile(join(root, 'apps/api/server.go'), `package main\nfunc main() {}\n`);
    await writeFile(join(root, 'infra/deploy.sh'), `#!/bin/bash\n`);

    const scopedRes = await generateRepoMap({
      repoPath: root,
      scope: ['apps/web'],
      commit: 'scope-commit',
      useCache: false,
    });

    assert.equal(scopedRes.totalCandidateFiles, 1);
    assert.ok(scopedRes.map.includes('apps/web/page.tsx'));
    assert.ok(!scopedRes.map.includes('apps/api/server.go'));
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
