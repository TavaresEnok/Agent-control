import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Refusal} from '../src/contracts.ts';
import {mapModuleSnapshot} from '../src/module-exam-map.ts';
import {examineFunctionalModule, type ModuleExamSeat} from '../src/module-exam.ts';
import type {ModuleRawFinding} from '../src/verification-modules.ts';

const seat = (provider: string): ModuleExamSeat => ({provider, model: `${provider}-model`, accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()});
const intentId = randomUUID();
const finding: ModuleRawFinding = {tool:'sintetica', rule:'regra', file:'src/routes.ts', line:1, severity:'media', message:'CONCLUSAO_DO_AUTOR', evidence:'evidencia sintetica'};
const map = {files:[{file:'src/routes.ts', code:'app.get("/pedidos", handler);', reason:null}, {file:'bin.dat', code:null, reason:'binário'}], routes:[{file:'src/routes.ts', line:1, method:'GET', path:'/pedidos'}, {file:'bin.dat', line:1, method:'GET', path:'/ignorada'}]};

test('mapa inventaria fontes e rotas, omitindo credenciais, links e arquivos grandes', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.module-exam-test-'));
  try {
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'routes.ts'), 'app.get("/pedidos", handler);\nconst token = "sintetico-privado";');
    await writeFile(join(dir, '.env'), 'DADO_SINTETICO_NAO_LER');
    await writeFile(join(dir, 'pem-in-code.txt'), '-----BEGIN PRIVATE KEY-----\nsynthetic-pem-only\n-----END PRIVATE KEY-----\napp.get("/depois", handler);');
    await writeFile(join(dir, 'huge.ts'), 'x'.repeat(17000));
    await symlink('.env', join(dir, 'link'));
    const mapped = await mapModuleSnapshot(dir);
    assert.deepEqual(mapped.routes, [{file:'pem-in-code.txt', line:4, method:'GET', path:'/depois'},
      {file:'src/routes.ts', line:1, method:'GET', path:'/pedidos'}]);
    assert.equal(mapped.files.find(f=>f.file==='.env')?.code, null);
    assert.equal(mapped.files.find(f=>f.file==='link')?.code, null);
    assert.equal(mapped.files.find(f=>f.file==='huge.ts')?.code, null);
    assert.doesNotMatch(mapped.files.find(f=>f.file==='src/routes.ts')!.code!, /sintetico-privado/);
  } finally { await rm(dir, {recursive:true, force:true}); }
});

test('modo coletor conserva achado sem confirmação e rotas não julgadas', async () => {
  const result = await examineFunctionalModule({module:'qa', intentId, map, findings:[finding]});
  assert.equal(result.mode, 'somente_ferramentas');
  assert.equal(result.findings[0]!.status, 'provavel');
  assert.equal(result.findings[0]!.verifier, null);
  assert.ok(result.coverage.every(row=>row.status === 'nao_julgado'));
  assert.ok(result.routes.every(row=>row.status === 'nao_julgado'));
});

test('examinador e revisor distintos, só evidência no pedido e prova obrigatória para confirmação', async () => {
  const examiner = seat('a'), reviewer = seat('b');
  const tasks: any[] = [], releases: string[] = [];
  const result = await examineFunctionalModule({module:'qa', intentId, map, findings:[finding],
    reserve: async purpose => purpose === 'examiner' ? examiner : reviewer,
    release: async (_seat, state) => { releases.push(state); },
    worker: {run: async call => {
      const task = JSON.parse(call.task); tasks.push({task, call});
      if (task.checklist) return JSON.stringify({kind:'exame', filesRead:['src/routes.ts'], checklist:['qa'], routesReviewed: task.routes,
        findings:[{line:1, snippet:'app.get', title:'PONTO DO EXAMINADOR', hypothesis:'O método recebe o handler diretamente?', severity:'baixa'}]});
      return JSON.stringify({kind:'confirmacao', status:'confirmado', binding: task.binding,
        reason:'O segundo argumento de `app.get` é o handler, sem chamada intermediária.', proof: tasks.length === 2 ? '' : task.code});
    }},
  });
  assert.equal(result.coverage[0]!.examiner?.profileId, examiner.profileId);
  assert.equal(result.coverage[1]!.status, 'nao_julgado');
  assert.deepEqual(result.routes.map(x=>x.status), ['lido','nao_julgado']);
  assert.equal(result.findings[0]!.status, 'provavel');
  assert.equal(result.findings[1]!.status, 'confirmado');
  assert.equal(result.findings[1]!.verifier?.profileId, reviewer.profileId);
  assert.deepEqual(tasks.slice(1).map(({task}) => [task.file, task.line, task.rule, task.hypothesis]), [
    ['src/routes.ts', 1, 'regra', 'O código neste ponto apresenta a condição investigada pela regra regra?'],
    ['src/routes.ts', 1, 'exame-de-arquivo', 'O método recebe o handler diretamente?'],
  ]);
  assert.ok(tasks.every(x=>x.call.role === 'specialist' && x.call.writePaths.length === 0));
  assert.doesNotMatch(JSON.stringify(tasks.slice(1)), /CONCLUSAO_DO_AUTOR|PONTO DO EXAMINADOR/);
  assert.deepEqual(releases, ['exited','exited','exited']);
});

test('não confirma com mesmo provedor, preserva cota ou indisponibilidade e não libera execução incerta', async () => {
  const examiner = seat('a'), reviewer = seat('a');
  const released: string[] = [];
  const result = await examineFunctionalModule({module:'qa', intentId, map, findings:[finding],
    reserve: async purpose => purpose === 'examiner' ? examiner : reviewer,
    release: async (_seat, state) => { released.push(state); },
    worker: {run: async () => JSON.stringify({kind:'exame', filesRead:['src/routes.ts'], checklist:['qa'], findings:[]})},
  });
  assert.equal(result.findings[0]!.failure, 'MODULE_EXAM_PROVIDER_NOT_DISTINCT');
  assert.equal(result.findings[0]!.status, 'provavel');
  assert.deepEqual(released, ['exited','not_started']);
  const quota = await examineFunctionalModule({module:'qa', intentId, map, findings:[finding],
    reserve: async () => { throw new Refusal('PROVIDER_USAGE_LIMIT'); }, release: async () => {}, worker:{run:async()=>''},
  });
  assert.equal(quota.coverage[0]!.reason, 'PROVIDER_USAGE_LIMIT');
  const uncertain = await examineFunctionalModule({module:'qa', intentId, map, findings:[],
    reserve: async () => examiner, release: async () => { throw Error('não deve liberar'); }, worker:{run:async()=>{ throw new Refusal('VERIFY_EXAM_TIMEOUT'); }},
  });
  assert.equal(uncertain.coverage[0]!.reason, 'VERIFY_EXAM_TIMEOUT');
});

test('falha de cota do revisor não inventa confirmação', async () => {
  const examiner = seat('a');
  const result = await examineFunctionalModule({module:'qa', intentId, map, findings:[finding],
    reserve: async purpose => { if (purpose === 'reviewer') throw new Refusal('PROVIDER_USAGE_LIMIT'); return examiner; },
    release: async () => {}, worker:{run:async()=>JSON.stringify({kind:'exame',filesRead:['src/routes.ts'],checklist:['qa'],findings:[]})},
  });
  assert.equal(result.findings[0]!.failure, 'PROVIDER_USAGE_LIMIT');
  assert.equal(result.findings[0]!.verifier, null);
  assert.equal(result.findings[0]!.status, 'provavel');
});

test('recusa de autorização encerra o exame', async () => {
  await assert.rejects(() => examineFunctionalModule({module:'qa', intentId, map, findings:[],
    reserve: async () => { throw new Refusal('PROJECT_FORBIDDEN', 403); },
    release: async () => {}, worker:{run:async()=>''},
  }), (error: unknown) => error instanceof Refusal && error.code === 'PROJECT_FORBIDDEN');
});


test('limite na fase de leitura preserva cobertura anterior e impede consumo do revisor', async () => {
  const examiner = seat('a');
  const extended = {...map, files: [...map.files,
    {file: 'pending.ts', code: 'export const one = 1;', reason: null},
    {file: 'unattempted.ts', code: 'export const two = 2;', reason: null},
  ]};
  const requests: string[] = [];
  let calls = 0;
  const result = await examineFunctionalModule({module: 'qa', intentId, map: extended, findings: [finding],
    async reserve(purpose) { requests.push(purpose); return examiner; },
    async release() {},
    worker: {async run(call) {
      calls++;
      assert.ok(!('repo' in call));
      if (calls === 2) throw new Refusal('PROVIDER_USAGE_LIMIT');
      return JSON.stringify({kind: 'exame', filesRead: ['src/routes.ts'], checklist: ['qa'], findings: []});
    }},
  });
  assert.deepEqual(requests, ['examiner', 'examiner']);
  assert.deepEqual(result.coverage.map(row => [row.status, row.reason]),
    [['lido', null], ['nao_julgado', 'binário'], ['nao_julgado', 'PROVIDER_USAGE_LIMIT'], ['nao_julgado', 'PROVIDER_USAGE_LIMIT']]);
  assert.equal(result.findings[0]?.status, 'provavel');
  assert.equal(result.findings[0]?.failure, 'PROVIDER_USAGE_LIMIT');
});

test('a evidência do coletor permanece provável mesmo se for toda a linha', async () => {
  const result = await examineFunctionalModule({module: 'qa', intentId, map, findings: [
    {...finding, evidence: 'app.get("/pedidos", handler);'},
    {...finding, evidence: 'app.get("/ausente", handler);'},
  ]});
  assert.equal(result.mode, 'somente_ferramentas');
  assert.deepEqual(result.findings.map(candidate => [candidate.status, candidate.verifier?.model]),
    [['provavel', undefined], ['provavel', undefined]]);
  assert.ok(result.coverage.every(row => row.status === 'nao_julgado'));
});

test('a prova vincula hipótese e regra na mesma linha, e rejeita a linha de outro arquivo', async () => {
  const examiner = seat('a'), reviewer = seat('b');
  const alternative = 'app.get("/outro", handler);';
  const otherFile = 'other.ts';
  const sameCode = map.files[0]!.code!;
  const inputFindings = [finding, {...finding, rule: 'outra-regra'}, {...finding, rule: 'terceira-regra'},
    {...finding, file: otherFile}, {...finding, rule: 'subtrecho'}, {...finding, rule: 'sem-explicacao'}];
  let initial: {binding: string; proof: string; reason: string; status: string; kind: string} | undefined;
  const result = await examineFunctionalModule({module: 'qa', intentId, findings: inputFindings,
    map: {...map, files: [...map.files, {file: otherFile, code: sameCode, reason: null},
      {file: 'different.ts', code: alternative, reason: null}]},
    reserve: async purpose => purpose === 'examiner' ? examiner : reviewer, release: async () => {},
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      if (task.checklist) return JSON.stringify({kind: 'exame', filesRead: [task.file], checklist: ['qa'], findings: []});
      if (!initial) {
        initial = {kind: 'confirmacao', binding: task.binding, status: 'confirmado', proof: task.code,
          reason: 'A chamada usa diretamente `handler` na rota de pedidos.'};
        return JSON.stringify(initial);
      }
      assert.notEqual(task.binding, initial.binding);
      if (task.rule === 'terceira-regra') return JSON.stringify({...initial, binding: task.binding, proof: alternative});
      if (task.rule === 'subtrecho') return JSON.stringify({...initial, binding: task.binding, proof: 'handler'});
      if (task.rule === 'sem-explicacao') return JSON.stringify({...initial, binding: task.binding, reason: 'Observação genérica que não cita a expressão examinada.'});
      return JSON.stringify(initial);
    }},
  });
  assert.deepEqual(result.findings.map(candidate => candidate.status),
    ['confirmado', 'provavel', 'provavel', 'provavel', 'provavel', 'provavel']);
  assert.ok(result.findings.slice(1).every(candidate => candidate.verifier === null));
});

test('somente atestados da declaração enviada contam mesmo quando o arquivo excede vinte rotas', async () => {
  const examiner = seat('a');
  const file = 'routes.ts';
  const methods = Array.from({length: 22}, (_, index) => ({file, line: index + 1, method: 'GET', path: `/route-${index}`}));
  const result = await examineFunctionalModule({module: 'qa', intentId, findings: [],
    map: {
      files: [{file, code: methods.map(route => `app.get("${route.path}", handler);`).join('\n'), reason: null},
        {file: 'other.ts', code: 'app.get("/foreign", handler);', reason: null}],
      routes: [methods[0]!, {file, line: 1, method: 'POST', path: '/route-0'}, ...methods.slice(1),
        {file: 'other.ts', line: 1, method: 'GET', path: '/foreign'}],
    },
    reserve: async () => examiner, release: async () => {},
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      const routesReviewed = task.file === file ? [
        task.routes[0], task.routes[19], {...methods[1]!, line: 1}, {...methods[2]!, method: 'POST'},
        {...methods[3]!, path: '/wrong'}, {file, line: 1, method: 'POST', path: '/route-0'},
        methods[20], methods[21], {file: 'other.ts', line: 1, method: 'GET', path: '/foreign'},
        ...Array.from({length: 20}, (_, index) => ({...methods[index], line: 0})),
      ] : [];
      if (task.file === file) assert.deepEqual(task.routes, methods.slice(0, 20));
      return JSON.stringify({kind: 'exame', filesRead: [task.file], checklist: ['qa'], routesReviewed, findings: []});
    }},
  });
  assert.ok(result.coverage.every(row => row.status === 'lido'));
  assert.deepEqual(result.routes.filter(row => row.status === 'lido').map(({file, line}) => [file, line]), [[file, 1], [file, 20]]);
  assert.equal(result.routes.length, 24);
});
