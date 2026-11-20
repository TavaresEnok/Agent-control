import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Refusal} from '../src/contracts.ts';
import {findModuleExamRoutes, mapModuleSnapshot, moduleExamRouteMatcher} from '../src/module-exam-map.ts';
import {hasModuleReviewProof, moduleReviewTask, readModuleReviewVerdict} from '../src/module-exam-proof.ts';
import {examineFunctionalModule, moduleCollectorCandidate, moduleExamReviewEvidence, type ModuleExamSeat} from '../src/module-exam.ts';
import {qaStaticFinding, reviewFixtureVerdict, skipQuestion} from './fixtures/module-exam-review.ts';

const seat = (provider: string): ModuleExamSeat => ({provider, model: `${provider}-model`, accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()});
const intentId = randomUUID();
const skipped = 'test.skip("valida pedidos", () => {})';
const expressApp = "import express from 'express'; const app = express(); ";
const mainCode = expressApp + 'app.get("/pedidos", handler);\n' + skipped + ';';
const finding = qaStaticFinding('src/routes.ts', 2, skipped + ';');
const map = {files:[{file:'src/routes.ts', code:mainCode, reason:null}, {file:'bin.dat', code:null, reason:'binário'}], routes:[{file:'src/routes.ts', line:1, method:'GET', path:'/pedidos'}, {file:'bin.dat', line:1, method:'GET', path:'/ignorada'}]};

test('mapa inventaria fontes e rotas, omitindo credenciais, links e arquivos grandes', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.module-exam-test-'));
  try {
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'routes.ts'), expressApp + 'app.get("/pedidos", handler);\nconst token = "sintetico-privado";');
    await writeFile(join(dir, '.env'), 'DADO_SINTETICO_NAO_LER');
    await writeFile(join(dir, 'pem-in-code.txt'), '-----BEGIN PRIVATE KEY-----\nsynthetic-pem-only\n-----END PRIVATE KEY-----\napp.get("/depois", handler);');
    await writeFile(join(dir, 'huge.ts'), 'x'.repeat(17000));
    const sql = '\uFEFF-- Consulta\r\nSELECT 1;\r\n';
    await writeFile(join(dir, 'query.sql'), sql);
    await symlink('.env', join(dir, 'link'));
    const mapped = await mapModuleSnapshot(dir);
    assert.deepEqual(mapped.routes, [{file:'src/routes.ts', line:1, column:expressApp.length + 1, method:'GET', path:'/pedidos'}]);
    assert.doesNotMatch(mapped.files.find(f=>f.file==='pem-in-code.txt')!.code!, /synthetic-pem-only/);
    assert.equal(mapped.files.find(f=>f.file==='.env')?.code, null);
    assert.equal(mapped.files.find(f=>f.file==='link')?.code, null);
    assert.equal(mapped.files.find(f=>f.file==='huge.ts')?.code, null);
    assert.equal(mapped.files.find(f=>f.file==='query.sql')?.code, sql);
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
      if (task.checklist) return JSON.stringify({kind:'exame', binding: task.binding, filesRead:['src/routes.ts'], checklist:['qa'], routesReviewed: task.routes,
        findings:[{line:2, snippet:skipped, title:'PONTO DO EXAMINADOR', hypothesis:skipQuestion, severity:'baixa'}]});
      const verdict = reviewFixtureVerdict(task, skipped);
      return JSON.stringify({...verdict, proof: tasks.length === 2 ? '' : verdict.proof});
    }},
  });
  assert.equal(result.coverage[0]!.examiner?.profileId, examiner.profileId);
  assert.equal(result.coverage[1]!.status, 'nao_julgado');
  assert.deepEqual(result.routes.map(x=>x.status), ['lido']);
  assert.equal(result.findings[0]!.status, 'provavel');
  assert.equal(result.findings[1]!.status, 'confirmado');
  assert.equal(result.findings[1]!.verifier?.profileId, reviewer.profileId);
  assert.deepEqual(tasks.slice(1).map(({task}) => [task.file, task.line, task.rule, task.hypothesis]), [
    ['src/routes.ts', 2, finding.rule, skipQuestion],
    ['src/routes.ts', 2, 'exame-de-arquivo', skipQuestion],
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
    worker: {run: async call => JSON.stringify({kind:'exame', binding: JSON.parse(call.task).binding, filesRead:['src/routes.ts'], checklist:['qa'], findings:[]})},
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
    release: async () => {}, worker:{run:async call=>JSON.stringify({kind:'exame',binding:JSON.parse(call.task).binding,filesRead:['src/routes.ts'],checklist:['qa'],findings:[]})},
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
      return JSON.stringify({kind: 'exame', binding: JSON.parse(call.task).binding, filesRead: ['src/routes.ts'], checklist: ['qa'], findings: []});
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

test('somente atestados da declaração enviada contam mesmo quando o arquivo excede vinte rotas', async () => {
  const examiner = seat('a');
  const file = 'routes.ts';
  const methods = Array.from({length: 22}, (_, index) => ({file, line: index + 1, method: 'GET', path: `/route-${index}`}));
  const result = await examineFunctionalModule({module: 'qa', intentId, findings: [],
    map: {
      files: [{file, code: expressApp + methods.map(route => `app.get("${route.path}", handler);`).join('\n'), reason: null},
        {file: 'other.ts', code: expressApp + 'app.get("/foreign", handler);', reason: null}],
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
      if (task.file === file) assert.deepEqual(task.routes, methods.slice(0, 20).map((route, index) =>
        ({...route, column: index === 0 ? expressApp.length + 1 : 1})));
      return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: ['qa'], routesReviewed, findings: []});
    }},
  });
  assert.ok(result.coverage.every(row => row.status === 'lido'));
  assert.deepEqual(result.routes.filter(row => row.status === 'lido').map(({file, line}) => [file, line]), [[file, 1], [file, 20]]);
  assert.equal(result.routes.length, 23);
  assert.match(result.notes.join(' '), /Rotas fora dos limites de envio ao examinador: 2/);
});

test('atesta a coluna exata e só aceita o formato antigo quando a identidade é única no arquivo', async () => {
  const examiner = seat('a');
  const file = 'checkout.ts';
  const expressRouter = 'const router = express.Router(); /* 🧾 */ ';
  const first = 'app.get("/checkout", first); ';
  const code = expressApp + expressRouter + first + 'router.get("/checkout", second); app.post("/pagamento", handler); '
    + 'const cache = new Map(); cache.get("/cupom", handler); router.get("/cupom", handler);';
  const [one, two, unique, withUnknownDuplicate] = findModuleExamRoutes(file, code);
  const older = ({column: _column, ...route}: typeof one) => route;
  assert.equal(one!.column, expressApp.length + expressRouter.length + 1);
  assert.equal(two!.column, one!.column + first.length);
  const run = (routes: typeof map.routes, routesReviewed: unknown[]) => examineFunctionalModule({
    module: 'qa', intentId, findings: [], map: {files: [{file, code, reason: null}], routes},
    reserve: async () => examiner, release: async () => {},
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: ['qa'], routesReviewed, findings: []});
    }},
  });
  const exact = await run([one!, two!, older(unique!), withUnknownDuplicate!],
    [one, older(two!), older(unique!), older(withUnknownDuplicate!)]);
  assert.deepEqual(exact.routes.map(route => [route.column, route.status]),
    [[one!.column, 'lido'], [two!.column, 'nao_julgado'], [unique!.column, 'lido'], [withUnknownDuplicate!.column, 'nao_julgado']]);
  const ambiguous = await run([one!, older(two!)], [older(one!)]);
  assert.deepEqual(ambiguous.routes, [{...one, status: 'nao_julgado'}]);
});

test('confirma três condições distintas na mesma linha e rejeita observações transplantadas com binding válido', async () => {
  const examiner = seat('a'), reviewer = seat('b');
  const file = 'pricing.test.ts', otherFile = 'billing.test.ts';
  const commit = 'a'.repeat(40);
  const random = 'Math.random()', wait = 'page.waitForTimeout(250)';
  const code = [skipped, 'test("cálculo", () => ' + random + ')', 'test("espera", () => ' + wait + ')'].join('; ') + ';';
  const disabled = qaStaticFinding(file, 1, code.slice(0, 140));
  const sampled = qaStaticFinding(file, 1, random, 'nondeterminism');
  const delayed = qaStaticFinding(file, 1, wait, 'nondeterminism');
  const inputFindings = [disabled, sampled, delayed, sampled, delayed,
    qaStaticFinding(otherFile, 1, code.slice(0, 140)),
    {...disabled, rule: 'QA-OPACO', evidence: skipped}, disabled, disabled, disabled, disabled];
  const valid: ReturnType<typeof reviewFixtureVerdict>[] = [];
  let reviews = 0;
  const result = await examineFunctionalModule({module: 'qa', intentId, commit, findings: inputFindings,
    map: {files: [{file, code, reason: null}, {file: otherFile, code, reason: null}], routes: []},
    reserve: async purpose => purpose === 'examiner' ? examiner : reviewer, release: async () => {},
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      if (task.checklist) return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: ['qa'], findings: []});
      assert.doesNotMatch(call.task, /CONCLUSAO_DO_AUTOR/);
      assert.equal(task.commit, commit);
      const index = reviews++;
      if (index < 3) {
        const verdict = reviewFixtureVerdict(task, [skipped, random, wait][index]!);
        valid.push(verdict);
        return JSON.stringify(verdict);
      }
      const original = valid[index === 4 ? 1 : 0]!;
      const transplanted = {...original, binding: task.binding};
      if (index === 6) assert.equal(task.criterion, null);
      if (index === 7) return JSON.stringify({...transplanted, status: 'descartado'});
      if (index === 8) return JSON.stringify({...transplanted, observation: undefined,
        reason: 'A linha contém a expressão `test.skip`.'});
      if (index === 9) return JSON.stringify({...transplanted, proof: skipped});
      if (index === 10) return JSON.stringify({...transplanted,
        observation: {...transplanted.observation, commit: 'b'.repeat(40)}});
      return JSON.stringify(transplanted);
    }},
  });
  assert.equal(reviews, inputFindings.length);
  assert.deepEqual(result.findings.map(candidate => candidate.status),
    ['confirmado', 'confirmado', 'confirmado', ...Array(8).fill('provavel')]);
  assert.ok(result.findings.slice(0, 3).every(candidate => candidate.verifier?.accountId === reviewer.accountId));
  assert.ok(result.findings.slice(3).every(candidate => candidate.verifier === null));
  assert.match(result.findings[0]!.reason, /usa skip/);
  assert.match(result.findings[1]!.reason, /chamada direta no código/);
  assert.match(result.findings[2]!.reason, /chamada direta no código/);
  const [verified, second] = result.findings;
  const evidence = moduleExamReviewEvidence('qa', verified!, code, disabled, undefined, result.coverage[0]?.read?.binding)!;
  assert.equal(hasModuleReviewProof(evidence, verified!), true);
  assert.equal(hasModuleReviewProof(evidence, {...verified!, reason: second!.reason}), false);
});

test('nomes sombreados comprovam a grafia da chamada e deixam a hipótese funcional provável', async () => {
  const examiner = seat('a'), reviewer = seat('b');
  const file = 'pricing.test.ts';
  const examples = [
    {expression: 'Math.random()', code: 'const Math = {random: () => 7}; Math.random();',
      hypothesis: 'A chamada retorna um valor aleatório?'},
    {expression: 'page.waitForTimeout(250)', code: 'const page = {waitForTimeout: () => undefined}; page.waitForTimeout(250);',
      hypothesis: 'A chamada espera 250 milissegundos?'},
  ];
  for (const {expression, code, hypothesis} of examples) {
    const raw = {...qaStaticFinding(file, 1, expression, 'nondeterminism'), message: hypothesis};
    const evidence = moduleExamReviewEvidence('qa', moduleCollectorCandidate(raw), code, raw)!;
    const task = JSON.parse(moduleReviewTask(evidence));
    const observed = reviewFixtureVerdict(task, expression);
    const reason = `A expressão na coluna ${observed.observation.column} é uma chamada direta no código.`;
    assert.equal(hasModuleReviewProof(evidence, {...observed, reason}), true);
    assert.equal(hasModuleReviewProof(evidence, {...observed, reason: hypothesis}), false);
    const reread = readModuleReviewVerdict({...observed, reason: hypothesis});
    assert.equal(reread?.reason, hypothesis);
    assert.equal(hasModuleReviewProof(evidence, reread!), false);
    for (const unproved of [hypothesis, 'A linha atual ainda sustenta a observação original?']) {
      const functional = {...evidence, hypothesis: unproved, rule: 'exame-de-arquivo', tool: 'examinador', evidence: expression};
      const pending = JSON.parse(moduleReviewTask(functional));
      assert.equal(pending.criterion, null);
      assert.equal(hasModuleReviewProof(functional, {...observed, binding: pending.binding, reason}), false);
    }
    const result = await examineFunctionalModule({module: 'qa', intentId, findings: [raw],
      map: {files: [{file, code, reason: null}], routes: []},
      reserve: async purpose => purpose === 'examiner' ? examiner : reviewer, release: async () => {},
      worker: {async run(call) {
        const request = JSON.parse(call.task);
        if (!request.checklist) return JSON.stringify(reviewFixtureVerdict(request, expression));
        return JSON.stringify({kind: 'exame', binding: request.binding, filesRead: [file], checklist: ['qa'], findings: [
          {line: 1, snippet: expression, title: hypothesis, hypothesis: task.hypothesis, severity: 'baixa'},
          {line: 1, snippet: expression, title: hypothesis, hypothesis, severity: 'baixa'},
        ]});
      }},
    });
    assert.deepEqual(result.findings.map(finding => finding.status), ['confirmado', 'confirmado', 'provavel']);
    const call = expression.startsWith('Math') ? 'Math.random' : 'waitForTimeout';
    assert.equal(result.findings[0]!.title, moduleCollectorCandidate(raw).title);
    assert.equal(result.findings[1]!.title, `Chamada direta a ${call} no código`);
    assert.ok(result.findings.slice(0, 2).every(finding => finding.reason === reason));
    assert.equal(result.findings[2]!.title, hypothesis);
  }
});

test('a decisão contraditória impede a confirmação da chamada mesmo com a âncora e a linha válidas', async () => {
  const examiner = seat('a'), reviewer = seat('b');
  const file = 'pricing.test.ts';
  const expression = 'Math.random()';
  const code = `const sample = ${expression};`;
  const raw = qaStaticFinding(file, 1, expression, 'nondeterminism');
  const result = await examineFunctionalModule({module: 'qa', intentId, findings: [raw],
    map: {files: [{file, code, reason: null}], routes: []},
    reserve: async purpose => purpose === 'examiner' ? examiner : reviewer, release: async () => {},
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      if (task.checklist) {
        return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [file], checklist: ['qa'], findings: []});
      }
      const valid = reviewFixtureVerdict(task, expression);
      return JSON.stringify({...valid, decision: 'contradiz', reason: 'A linha não contém a chamada direta.'});
    }},
  });
  const [pending] = result.findings;
  assert.equal(result.coverage[0]?.status, 'lido');
  assert.equal(pending?.status, 'provavel');
  assert.equal(pending?.verifier, null);
  assert.equal(pending?.decision, undefined);
  assert.equal(pending?.failure, 'MODULE_CONFIRMATION_INVALID');

  const evidence = moduleExamReviewEvidence('qa', moduleCollectorCandidate(raw), code, raw)!;
  const valid = reviewFixtureVerdict(JSON.parse(moduleReviewTask(evidence)), expression);
  assert.equal(hasModuleReviewProof(evidence, valid), true);
  assert.equal(hasModuleReviewProof(evidence, {...valid, decision: 'contradiz'}), false);
  assert.equal(hasModuleReviewProof(evidence, {...valid, decision: undefined}), false);
});

test('o descarte exige o mesmo teste e grupo, comparados nos dois arquivos completos', () => {
  const raw = qaStaticFinding('pricing.test.ts', 2, skipped);
  const active = 'test("valida pedidos", () => {})';
  const {message: _message, severity: _severity, ...origin} = raw;
  const evidence = {module: 'qa' as const, ...origin, code: active + ';', commit: 'c'.repeat(40), hypothesis: skipQuestion,
    skipSnapshot: {originalCommit: 'b'.repeat(40), original: `describe("preços", () => {\n  ${skipped};\n});`,
      current: `describe("preços", () => {\n  ${active};\n});`}};
  const prove = (input: typeof evidence | Omit<typeof evidence, 'skipSnapshot'>) => {
    const task = JSON.parse(moduleReviewTask(input));
    return hasModuleReviewProof(input, reviewFixtureVerdict(task, active, 'descartado'));
  };
  assert.equal(prove(evidence), true);
  const {skipSnapshot, ...lineOnly} = evidence;
  assert.equal(prove(lineOnly), false);
  const withHistory = {...evidence, originalCommit: skipSnapshot.originalCommit,
    originalCode: 'const linhaHistoricaSintetica = 7;', regressionProof: null};
  const task = JSON.parse(moduleReviewTask(withHistory));
  const discard = reviewFixtureVerdict(task, active, 'descartado');
  assert.equal(readModuleReviewVerdict({...discard, decision: 'sustenta'}), undefined);
  assert.equal(hasModuleReviewProof(withHistory, {...discard, decision: 'sustenta'}), false);
  assert.equal(hasModuleReviewProof(withHistory, {...discard, reason: 'A grafia ainda inclui skip.'}), false);
  assert.deepEqual(Object.keys(task).sort(),
    ['binding', 'code', 'commit', 'criterion', 'discardReasonTemplate', 'evidence', 'file', 'hypothesis',
      'instruction', 'line', 'reasonTemplate', 'rule', 'skipRemoval', 'tool']);
  assert.deepEqual(task.skipRemoval, {column: 1, expression: active});
  assert.equal(task.evidence, skipped);
  const unclassified = JSON.parse(moduleReviewTask({...withHistory, evidence: 'declaração indisponível'}));
  assert.equal(unclassified.criterion, null);
  assert.equal(unclassified.originalCode, undefined);
  assert.equal(unclassified.originalCommit, undefined);
  for (const current of [skipSnapshot.original, skipSnapshot.current.replace('preços', 'outro grupo'),
    skipSnapshot.current.replace('() => {}', 'outroHandler'), skipSnapshot.current + '\n' + skipped]) {
    assert.equal(prove({...evidence, code: current.split('\n')[1]!.trim(), skipSnapshot: {...skipSnapshot, current}}), false);
  }
  for (const copy of [skipped, skipped.replace('skip("', 'skip(\n  "'), active, 'test.skip(title, handler)', 'test["skip"](title, handler)']) {
    const tail = `\ndescribe("outro grupo", () => { ${copy}; });`;
    assert.equal(prove({...evidence, skipSnapshot: {...skipSnapshot,
      original: skipSnapshot.original + tail, current: skipSnapshot.current + tail}}), false);
  }
  for (const copy of ['test["sk" + "ip"]("valida " + "pedidos", () => {})',
    'test.skip("valida " + "pedidos", () => {})', 'test(title, options, () => {})',
    'test["to" + "do"]("outro", () => {})', 'describe["sk" + "ip"]("outro", () => {})', 'const register = test']) {
    const tail = `\n  ${copy};\n});`;
    assert.equal(prove({...evidence, skipSnapshot: {...skipSnapshot,
      original: skipSnapshot.original.replace('\n});', tail), current: skipSnapshot.current.replace('\n});', tail)}}), false, copy);
  }
  for (const args of [', options', ', options, () => {}', ', {["sk" + "ip"]: true}, () => {}']) {
    const original = `test.skip("valida pedidos"${args})`;
    const current = original.replace('.skip', '');
    assert.equal(prove({...evidence, evidence: qaStaticFinding(raw.file, raw.line, original).evidence, code: current + ';',
      skipSnapshot: {...skipSnapshot, original: skipSnapshot.original.replace(skipped, original),
        current: skipSnapshot.current.replace(active, current)}}), false, args);
  }
  const appendOther = (source: string) => source + '\nit.todo("valida estoque", async () => {});';
  assert.equal(prove({...evidence, skipSnapshot: {...skipSnapshot,
    original: appendOther(skipSnapshot.original), current: appendOther(skipSnapshot.current)}}), true);
  for (const imports of ['import {describe, test, expect as check} from "vitest";\n',
    'const {describe, test} = require("node:test");\n']) {
    const line = raw.line + 1;
    assert.equal(prove({...evidence, line, evidence: qaStaticFinding(raw.file, line, skipped).evidence,
      skipSnapshot: {...skipSnapshot, original: imports + skipSnapshot.original, current: imports + skipSnapshot.current}}), true);
  }
  const split = active + '; }); describe("original", () => { test.skip(\n"valida pedidos", () => {}); });';
  assert.equal(prove({...evidence, code: split.split('\n')[0]!, skipSnapshot: {...skipSnapshot,
    current: 'describe("cópia", () => {\n  ' + split}}), false);
  const moved = {...evidence, commit: 'd'.repeat(40)};
  const cleanTask = JSON.parse(moduleReviewTask(evidence));
  assert.equal(hasModuleReviewProof(moved, {...reviewFixtureVerdict(cleanTask, active, 'descartado'),
    binding: JSON.parse(moduleReviewTask(moved)).binding}), false);
  const withUnrelatedSource = {...evidence, skipSnapshot: {...skipSnapshot,
    original: appendOther(skipSnapshot.original), current: appendOther(skipSnapshot.current)}};
  const {binding: newBinding, ...newRequest} = JSON.parse(moduleReviewTask(withUnrelatedSource));
  const {binding, ...request} = cleanTask;
  assert.deepEqual(newRequest, request);
  assert.notEqual(newBinding, binding);
  assert.equal(hasModuleReviewProof(withUnrelatedSource, reviewFixtureVerdict(cleanTask, active, 'descartado')), false);
});

test('linhas cortadas no limite não chegam à revisão nem viram rotas julgadas', async () => {
  const examiner = seat('a'), reviewer = seat('b');
  const file = 'limited.test.ts';
  const line = skipped + '; app.get("/cortada", handler);';
  const target = qaStaticFinding(file, 2, line);
  const route = {file, line: 2, method: 'GET', path: '/cortada'};
  const head = expressApp + '//'.padEnd(15950 - expressApp.length, 'x') + '\n';
  const code = head + line + ' //' + 'x'.repeat(120);
  assert.equal(moduleExamReviewEvidence('qa', moduleCollectorCandidate(target), code, target), null);
  const exact = '//'.padEnd(15999 - line.length, 'x') + '\n' + line;
  assert.equal(exact.length, 16000);
  assert.equal(moduleExamReviewEvidence('qa', moduleCollectorCandidate(target), exact + '\r\n// fim', target)?.code, line);
  const splitCrlf = exact.slice(0, 2) + exact.slice(3) + '\r\n// fim';
  assert.equal(moduleExamReviewEvidence('qa', moduleCollectorCandidate(target), splitCrlf, target)?.code, line);
  assert.equal(moduleExamReviewEvidence('qa', moduleCollectorCandidate(target),
    '// início\n' + line + ' ' + 'x'.repeat(2000), target), null);
  const result = await examineFunctionalModule({module: 'qa', intentId, findings: [target],
    map: {files: [{file, code, reason: null}], routes: [route]},
    reserve: async purpose => purpose === 'examiner' ? examiner : reviewer, release: async () => {},
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      assert.ok(task.checklist);
      assert.equal(task.code, head);
      assert.deepEqual(task.routes, []);
      return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [file], checklist: ['qa'], routesReviewed: [route],
        findings: [{line: 2, snippet: skipped, hypothesis: skipQuestion, title: 'Trecho incompleto', severity: 'media'}]});
    }},
  });
  assert.deepEqual(result.routes, [{...route, column: skipped.length + 3, status: 'nao_julgado'}]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.status, 'provavel');
  assert.match(result.notes.join(' '), /Rotas fora dos limites de envio ao examinador: 1/);
  assert.match(result.notes.join(' '), /Arquivos com envio limitado a linhas completas: 1/);
});

test('o leitor de rotas ignora texto literal e registra arquivos com sintaxe não reconhecida', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.module-exam-test-'));
  try {
    const file = 'real.ts';
    const code = [
      expressApp + 'const router = express.Router(); const quoted = "app.get(\'/texto\', handler)";',
      'const template = `',
      'app.get("/template", handler);',
      '`;',
      '/*',
      'app.get("/bloco", handler);',
      '*/',
      '// app.get("/comentario", handler);',
      'app.get("setting");',
      'app.get(dynamic, handler);',
      'other.app.get("/outra", handler);',
      'app.get("/multilinha",',
      '  handler',
      ');',
      'router.post(`/literal`, handler);',
    ].join('\n');
    const masked = expressApp + 'app.get("/segura", handler);\nconst token = "sintetico-privado";';
    await writeFile(join(dir, file), code);
    await writeFile(join(dir, 'masked.ts'), masked);
    await writeFile(join(dir, 'regex.js'), 'const regex = /app.get("\\/regex", fn)/;\napp.get("/omitida", handler);');
    await writeFile(join(dir, 'pages.tsx'), expressApp + 'app.get("/jsx", handler);');
    await writeFile(join(dir, 'jsx.jsx'), '<p>app.get("/jsx", handler)</p>');
    await writeFile(join(dir, 'pricing.py'), 'app.get("/python", handler)');
    await writeFile(join(dir, 'interpolation.ts'), 'const value = `texto ${`app.get("/interpolada", fn)`}`;');
    await writeFile(join(dir, 'docs.md'), 'app.get("/exemplo", handler);');
    const mapped = await mapModuleSnapshot(dir);
    assert.deepEqual(mapped.routes, [
      {file: 'masked.ts', line: 1, column: expressApp.length + 1, method: 'GET', path: '/segura'},
      {file, line: 12, column: 1, method: 'GET', path: '/multilinha'},
      {file, line: 15, column: 1, method: 'POST', path: '/literal'},
    ]);
    assert.deepEqual(findModuleExamRoutes(file, code.replaceAll('\n', '\r\n')), mapped.routes.slice(1));
    const suggested = {file, line: 8, method: 'GET', path: '/comentario'};
    const result = await examineFunctionalModule({module: 'qa', intentId, findings: [], map: {...mapped, routes: [suggested, ...mapped.routes]}});
    assert.equal(result.routes.length, 3);
    assert.match(result.notes.join(' '), /inventário de rotas parcial ou omitido: 6/);
    for (const unsupported of ['pages.tsx', 'jsx.jsx', 'pricing.py']) {
      assert.ok(result.notes.includes(`Inventário de rotas em ${unsupported} com omissão por linguagem não inventariada.`));
    }
    assert.match(result.notes.join(' '), /regex\.js com omissão por sintaxe não reconhecida/);
    assert.match(result.notes.join(' '), /sem declaração verificável omitidas: 1/);
    const insideLiteral = qaStaticFinding(file, 2, skipped);
    assert.equal(moduleExamReviewEvidence('qa', moduleCollectorCandidate(insideLiteral),
      'const fixture = `\n' + skipped + ';\n`;', insideLiteral), null);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('o mapa exige inicialização HTTP reconhecida e deixa chamadas com receptores sombreados fora do julgamento', async () => {
  const examiner = seat('a');
  const file = 'checkout.ts';
  const code = [
    "import {Hono as Web} from 'hono';",
    "import {Router as makeRouter} from 'express';",
    "import fastify from 'fastify';",
    'const routes = new Web(); const router = makeRouter(); const http = fastify();',
    'const app = new Map(); app.get("/cache", handler);',
    'unknown.get("/desconhecida", handler);',
    'function checkout(routes: unknown) { routes.get("/sombreada", handler); };',
    'routes.get("/pedidos", handler); router.get("/precos", handler); http.get("/faturas", handler);',
  ].join('\n');
  const declarations = findModuleExamRoutes(file, code);
  assert.deepEqual(declarations.map(route => route.path), ['/pedidos', '/precos', '/faturas']);
  const falseEntries = ['/cache', '/desconhecida', '/sombreada'].map((path, index) =>
    ({file, path, method: 'GET', line: 5 + index}));
  const result = await examineFunctionalModule({module: 'qa', intentId, findings: [],
    map: {files: [{file, code, reason: null}], routes: [...falseEntries, ...declarations]},
    reserve: async () => examiner, release: async () => {},
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      assert.deepEqual(task.routes, declarations);
      return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [file], checklist: ['qa'],
        routesReviewed: [...falseEntries, ...task.routes], findings: []});
    }},
  });
  assert.deepEqual(result.routes, declarations.map(route => ({...route, status: 'lido'})));
  assert.match(result.notes.join(' '), /sem declaração verificável omitidas: 3/);
});

test('o mapa registra omissões indexadas e de métodos sobrescritos e impede atestados ambíguos', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.module-exam-test-'));
  try {
    const indexed = 'indexed.ts';
    const mutated = 'mutated.ts';
    const source = expressApp + 'app.get("/pedidos", first); app["get"]("/pedidos", second);\n'
      + 'app.get("/precos", first); app[method]("/precos", second);\n'
      + 'app.post("/faturas", handler);\n';
    await writeFile(join(dir, indexed), source);
    await writeFile(join(dir, 'indexed-only.ts'), expressApp + 'app["put"]("/entrega", handler);');
    const changed = expressApp + 'const router = express.Router(); const dynamic = express.Router(); '
      + 'app.get = lookup; app["delete"] ??= lookup; Reflect.set(app, "put", lookup); dynamic[method] = lookup;\n'
      + 'app.get("/pedidos", handler); app.delete("/pedidos", handler); app.put("/pedidos", handler); '
      + 'dynamic.get("/pedidos", handler); app.post("/faturas", handler); router.get("/precos", handler);';
    await writeFile(join(dir, mutated), changed);
    const mapped = await mapModuleSnapshot(dir);
    assert.equal(mapped.routeOmissions, 3);
    assert.deepEqual(mapped.routeOmissionDetails, [
      {file: 'indexed-only.ts', reason: 'acesso indexado ou dinâmico'},
      {file: indexed, reason: 'acesso indexado ou dinâmico'},
      {file: mutated, reason: 'método do receptor sobrescrito'},
    ]);
    const [orders, prices, bills, otherBills, otherPrices] = mapped.routes;
    assert.deepEqual(mapped.routes.map(({file, method, path}) => [file, method, path]),
      [[indexed, 'GET', '/pedidos'], [indexed, 'GET', '/precos'], [indexed, 'POST', '/faturas'],
        [mutated, 'POST', '/faturas'], [mutated, 'GET', '/precos']]);
    const old = ({column: _column, ...route}: typeof orders) => route;
    const resolve = moduleExamRouteMatcher(indexed, source);
    assert.equal(resolve(old(orders!)), undefined);
    assert.equal(resolve(old(prices!)), undefined);
    assert.deepEqual(resolve(old(bills!)), bills);
    const indexedClaim = {...orders!, column: source.indexOf('app["get"]') + 1};
    const overwrittenClaim = {file: mutated, line: 2, column: 1, method: 'GET', path: '/pedidos'};
    const result = await examineFunctionalModule({module: 'qa', intentId, findings: [],
      map: {...mapped, routes: [...mapped.routes, indexedClaim, overwrittenClaim]},
      reserve: async () => seat('a'), release: async () => {},
      worker: {async run(call) {
        const task = JSON.parse(call.task);
        const routesReviewed = task.file === indexed ? [old(orders!), prices, old(bills!), indexedClaim]
          : task.file === mutated ? [overwrittenClaim, otherBills, otherPrices] : [];
        assert.deepEqual(task.routes, mapped.routes.filter(route => route.file === task.file));
        return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: ['qa'], findings: [], routesReviewed});
      }},
    });
    assert.equal(result.notes.filter(note => note.includes('com omissão por acesso indexado ou dinâmico')).length, 2);
    assert.match(result.notes.join(' '), /sem declaração verificável omitidas: 2/);
    assert.deepEqual(result.routes.map(route => route.status), ['nao_julgado', 'lido', 'lido', 'lido', 'lido']);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('cota devolvida por revisor reservado conserva os achados e não presume término', async () => {
  const examiner = seat('a'), reviewer = seat('b');
  const releases: string[] = [];
  const reservations: string[] = [];
  const result = await examineFunctionalModule({module: 'qa', intentId, map, findings: [finding, finding],
    async reserve(purpose) { reservations.push(purpose); return purpose === 'examiner' ? examiner : reviewer; },
    async release(_seat, state) { releases.push(state); },
    worker: {async run(call) {
      if (call.provider === reviewer.provider) throw new Refusal('PROVIDER_USAGE_LIMIT');
      return JSON.stringify({kind: 'exame', binding: JSON.parse(call.task).binding, filesRead: [finding.file], checklist: ['qa'], findings: []});
    }},
  });
  assert.deepEqual(reservations, ['examiner', 'reviewer']);
  assert.deepEqual(releases, ['exited']);
  assert.deepEqual(result.findings.map(f => [f.status, f.failure]), Array(2).fill(['provavel', 'PROVIDER_USAGE_LIMIT']));
});

test('pedido do examinador comunica o contrato estrito e aceita JSON único em cerca Markdown única sem afrouxar vínculos', async () => {
  const examiner = seat('a'), reviewer = seat('b');
  const file = 'src/service.ts';
  const line1 = 'export function handleOrder(id: string) {';
  const line2 = '  return eval(id);';
  const code = `${line1}\n${line2}\n}`;
  const tasks: Record<string, any>[] = [];
  const baseInput = {
    module: 'arquitetura' as const,
    intentId,
    map: {files: [{file, code, reason: null}], routes: []},
    findings: [],
    reserve: async (purpose: 'examiner' | 'reviewer') => (purpose === 'examiner' ? examiner : reviewer),
    release: async () => {},
  };

  const valid = await examineFunctionalModule({
    ...baseInput,
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      tasks.push(task);
      if (!task.checklist) {
        return JSON.stringify({kind: 'confirmacao', status: 'provavel', binding: task.binding,
          reason: 'Falta prova determinística para confirmar.', proof: ''});
      }
      const payload = JSON.stringify({
        kind: 'exame',
        binding: task.binding,
        filesRead: [task.file],
        checklist: [task.module],
        routesReviewed: [],
        findings: [{
          line: 2,
          snippet: 'return eval(id);',
          hypothesis: 'O uso de eval acopla entrada externa à execução dinâmica?',
          title: 'Execução dinâmica com ```eval``` acoplada ao fluxo',
          severity: 'média',
        }],
      });
      return `\uFEFF\`\`\`json\n${payload}\n\`\`\``;
    }},
  });

  const examTask = tasks[0]!;
  assert.match(examTask.instruction, /filesRead \(array JSON com exatamente 1 string igual ao campo file/);
  assert.match(examTask.instruction, /checklist \(array JSON com exatamente 1 string igual ao campo module\/checklist\.id/);
  assert.match(examTask.instruction, /"alta", "media", "baixa" ou "informativa", sem acento/);
  assert.match(examTask.instruction, /até 20 itens/);
  assert.equal(valid.coverage[0]?.status, 'lido');
  assert.equal(valid.coverage[0]?.checklist[0], 'arquitetura');
  assert.equal(valid.findings.length, 1);
  assert.equal(valid.findings[0]?.severity, 'media');
  assert.equal(valid.findings[0]?.status, 'provavel');

  const plainFence = await examineFunctionalModule({
    ...baseInput,
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      return '```\n' + JSON.stringify({
        kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: [task.module], findings: [],
      }) + '\n```';
    }},
  });
  assert.equal(plainFence.coverage[0]?.status, 'lido');

  const rejectCases: ((task: Record<string, any>) => string)[] = [
    () => '{"binding":"You hit your usage limit","binding":"outro"}',
    () => 'Failed to authenticate: exemplo citado no texto do arquivo.',
    task => 'Segue o JSON:\n```json\n' + JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: [task.module], findings: []}) + '\n```',
    task => '```json\n' + JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: [task.module], findings: []}) + '\n```\nFim.',
    task => '```json\n' + JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: [task.module], findings: []}) + '\n```\n```json\n{"extra":true}\n```',
    task => JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: [task.module], findings: []}) + JSON.stringify({extra: 1}),
    task => JSON.stringify({kind: 'exame', binding: '0'.repeat(64), filesRead: [task.file], checklist: [task.module], findings: []}),
    task => JSON.stringify({kind: 'exame', binding: task.binding, filesRead: task.file, checklist: [task.module], findings: []}),
    task => JSON.stringify({kind: 'exame', binding: task.binding, filesRead: ['outro.ts'], checklist: [task.module], findings: []}),
    task => JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: [task.checklist.item], findings: []}),
    task => JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: [task.checklist], findings: []}),
    task => JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: ['qa'], findings: []}),
    task => JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: [task.module], extra: true, findings: []}),
    task => JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: [task.module]}),
    task => JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: [task.module],
      findings: [{line: 2, snippet: 'return eval(id);', hypothesis: 'Falta ponto de interrogação.', title: 'Sem ?', severity: 'baixa'}]}),
    task => JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: [task.module],
      findings: [{line: 2, snippet: 'return eval(id);', hypothesis: 'Severidade desconhecida?', title: 'Invalida', severity: 'desconhecida'}]}),
  ];

  for (const build of rejectCases) {
    const rejected = await examineFunctionalModule({
      ...baseInput,
      worker: {async run(call) { return build(JSON.parse(call.task)); }},
    });
    assert.equal(rejected.coverage[0]?.status, 'nao_julgado');
    assert.equal(rejected.coverage[0]?.reason, 'MODULE_EXAM_RESPONSE_INVALID');
    assert.equal(rejected.findings.length, 0);
  }

  const unprovedSnippet = await examineFunctionalModule({
    ...baseInput,
    worker: {async run(call) {
      const task = JSON.parse(call.task);
      return JSON.stringify({
        kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: [task.module], routesReviewed: [],
        findings: [{line: 2, snippet: 'trecho inexistente na linha', hypothesis: 'Trecho inventado?', title: 'Inventado', severity: 'alta'}],
      });
    }},
  });
  assert.equal(unprovedSnippet.coverage[0]?.status, 'lido');
  assert.equal(unprovedSnippet.findings.length, 0);
});
