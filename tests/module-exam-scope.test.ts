import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {VerificationModule} from '../src/ledger.ts';
import {examineFunctionalModule, moduleExamUnjudgedByFailure, type ModuleExamInput, type ModuleExamSeat} from '../src/module-exam.ts';
import {moduleExamScope} from '../src/module-exam-scope.ts';

const plain = 'func Handle() {}\n';
// [module, path, content, inside]: paths in the shape of a Go service with a web front end.
const table: [VerificationModule, string, string, boolean][] = [
  ['qa', 'internal/handler/user.go', plain, true],
  ['qa', 'internal/handler/user_test.go', plain, true],
  ['qa', 'web/src/App.tsx', plain, true],
  ['qa', 'docs/guia.md', '', false],
  // Code inside a docs/ folder is still code: a Go package or a swagger generator.
  ['qa', 'internal/docs/handler.go', plain, true],
  ['arquitetura', 'api/docs/docs.go', plain, true],
  ['qa', 'Docs/guia.md', '', false],
  ['qa', 'internal/db/dbgen/models.go', plain, false],
  ['qa', 'api/v1/chat.pb.go', plain, false],
  ['qa', 'vendor/github.com/x/y.go', plain, false],
  ['arquitetura', 'internal/handler/user.go', plain, true],
  ['arquitetura', 'internal/handler/user_test.go', plain, false],
  ['arquitetura', 'web/src/__tests__/App.tsx', plain, false],
  ['arquitetura', 'migrations/001_init.sql', 'CREATE TABLE x();', false],
  ['dependencias', 'go.mod', '', true],
  ['dependencias', 'go.sum', '', true],
  ['dependencias', 'web/package.json', '{}', true],
  ['dependencias', 'web/package-lock.json', '{}', true],
  ['dependencias', 'web/pnpm-lock.yaml', '', true],
  ['dependencias', 'requirements-dev.txt', '', true],
  ['dependencias', 'deploy/api.Dockerfile', '', true],
  ['dependencias', 'dockerfile', '', true],
  ['dependencias', '.github/workflows/ci.yml', '', true],
  ['dependencias', 'internal/handler/user.go', plain, false],
  ['banco', 'migrations/001_init.sql', 'CREATE TABLE x();', true],
  ['banco', 'db/queries/users.sql', 'SELECT 1;', true],
  ['banco', 'sqlc.yaml', '', true],
  ['banco', 'internal/store/user.go', 'rows, err := s.db.Query(ctx, q)\n', true],
  ['banco', 'internal/store/lock.go', 'const q = "SELECT id FROM t FOR UPDATE"\n', true],
  ['banco', 'internal/handler/user.go', plain, false],
  ['banco', 'internal/store/user_test.go', 'rows, err := s.db.Query(ctx, q)\n', false],
  ['prontidao', 'docker-compose.yml', '', true],
  ['prontidao', 'Caddyfile', '', true],
  ['prontidao', 'deploy/nginx.conf', '', true],
  ['prontidao', 'deploy/chatisp.service', '', true],
  ['prontidao', 'scripts/backup.sh', '', true],
  ['prontidao', 'cmd/api/main.go', plain, true],
  ['prontidao', 'internal/config/config.go', 'port := os.Getenv("PORT")\n', true],
  ['prontidao', 'internal/handler/user.go', plain, false],
  ['prontidao', 'docs/deploy.md', '', false],
  ['prontidao', 'internal/config/config_test.go', 'port := os.Getenv("PORT")\n', false],
  ['desempenho', 'internal/worker/poll.go', 'for _, item := range items {\n', true],
  ['desempenho', 'web/src/useChat.ts', 'useEffect(() => {}, []);\n', true],
  ['desempenho', 'db/queries/users.sql', 'SELECT 1;', true],
  ['desempenho', 'migrations/001_init.sql', 'CREATE TABLE x();', false],
  ['desempenho', 'internal/model/user.go', 'type User struct { Name string }\n', false],
  ['documentacao', 'README.md', '', true],
  ['documentacao', 'docs/arquitetura.md', '', true],
  ['documentacao', 'docs/api/openapi.yaml', '', true],
  ['documentacao', 'openapi.json', '{}', true],
  ['documentacao', 'docs/notas.txt', '', true],
  ['documentacao', 'docs/medicoes/2026-11.md', '', false],
  ['documentacao', 'internal/handler/user.go', plain, false],
  ['conformidade', 'LICENSE', '', true],
  ['conformidade', 'LICENSE.md', '', true],
  ['conformidade', 'go.mod', '', true],
  ['conformidade', 'internal/cliente/cliente.go', 'type Cliente struct { CPF string }\n', true],
  ['conformidade', 'migrations/002_contato.sql', 'ALTER TABLE c ADD telefone text;', true],
  ['conformidade', 'internal/handler/user.go', plain, false],
  ['conformidade', 'internal/cliente/cliente_test.go', 'cpf := "000"\n', false],
  ['conformidade', 'docs/lgpd.md', 'titular', false],
];

test('cada módulo de 2 a 9 tem a sua regra de caminho e conteúdo', () => {
  for (const [module, file, code, inside] of table) {
    const rule = moduleExamScope(module, file, code);
    assert.equal(rule === null, inside, `${module} ${file}`);
    if (!inside) assert.match(rule!, file.startsWith('vendor/') ? /^vendor$/ : new RegExp(`^${module}-`), `${module} ${file}`);
  }
});

const seat = (): ModuleExamSeat => ({provider: 'claude', model: 'claude-sonnet-5-5', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()});
const intentId = randomUUID();
const files = [{file: 'src/a.ts', code: 'export const a = 1;\n'}, {file: 'README.md', code: '# Projeto\n'},
  {file: 'src/b.ts', code: 'export const b = 2;\n'}].map(file => ({...file, reason: null}));

function documentation(extra: Partial<ModuleExamInput> = {}) {
  const sent: string[] = [];
  const input: ModuleExamInput = {module: 'documentacao', intentId, commit: 'a'.repeat(40), map: {files, routes: []},
    // Collector evidence on src/b.ts puts it in the exam even outside the documentation rule.
    findings: [{tool: 'typedoc', rule: 'TYPEDOC-SEM-DOC', file: 'src/b.ts', line: 1, severity: 'baixa', message: 'sem doc', evidence: 'export const b'}],
    reserve: async () => seat(), release: async () => {}, reviewCap: 0,
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      sent.push(task.file);
      return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: [task.module], routesReviewed: [], findings: []});
    }}, ...extra};
  return {sent, input};
}

test('arquivo fora da regra fica sem julgamento com o motivo; achado de ferramenta entra sempre', async () => {
  const {sent, input} = documentation();
  const result = await examineFunctionalModule(input);
  assert.deepEqual(sent, ['README.md', 'src/b.ts']);
  assert.deepEqual(result.coverage.map(row => [row.file, row.status, row.reason]), [
    ['src/a.ts', 'nao_julgado', 'fora do escopo do módulo (regra documentacao-textos)'],
    ['README.md', 'lido', null],
    ['src/b.ts', 'lido', null],
  ]);
  assert.ok(result.notes.includes('Arquivos fora do escopo do módulo: 1. Arquivos sem julgamento por modelo: 0. Achados pendentes: 1.'));
  // Out of scope is a decision, not a failure: the run does not count it as unjudged.
  assert.equal(result.unjudgedByFailure, 0);
  assert.equal(moduleExamUnjudgedByFailure(result.coverage), 0);
  assert.equal(result.stopped, null);
});

test('scope false examina todos os arquivos, como antes', async () => {
  const {sent, input} = documentation({scope: false});
  const result = await examineFunctionalModule(input);
  assert.deepEqual(sent, ['src/a.ts', 'README.md', 'src/b.ts']);
  assert.ok(result.coverage.every(row => row.status === 'lido'));
  assert.ok(result.notes.includes('Arquivos sem julgamento por modelo: 0. Achados pendentes: 1.'));
});

test('examinador indisponível conta só os arquivos do escopo do módulo', async () => {
  const {sent, input} = documentation();
  const result = await examineFunctionalModule({...input, worker: undefined, reserve: undefined, release: undefined,
    unavailable: 'MODULE_EXAM_EXAMINER_UNAVAILABLE'});
  assert.deepEqual(sent, []);
  assert.deepEqual(result.coverage.map(row => row.reason), ['fora do escopo do módulo (regra documentacao-textos)',
    'MODULE_EXAM_EXAMINER_UNAVAILABLE', 'MODULE_EXAM_EXAMINER_UNAVAILABLE']);
  assert.deepEqual([result.stopped, result.unjudgedByFailure], ['MODULE_EXAM_EXAMINER_UNAVAILABLE', 2]);
});
