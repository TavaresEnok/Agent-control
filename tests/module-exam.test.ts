import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Refusal} from '../src/contracts.ts';
import {findModuleExamRoutes, mapModuleSnapshot} from '../src/module-exam-map.ts';
import {hasModuleReviewProof, moduleReviewTask} from '../src/module-exam-proof.ts';
import {examineFunctionalModule, moduleCollectorCandidate, moduleExamReviewEvidence, type ModuleExamSeat} from '../src/module-exam.ts';
import {qaStaticFinding, reviewFixtureVerdict, skipQuestion} from './fixtures/module-exam-review.ts';

const seat = (provider: string): ModuleExamSeat => ({provider, model: `${provider}-model`, accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()});
const intentId = randomUUID();
const skipped = 'test.skip("valida pedidos", () => {})';
const finding = qaStaticFinding('src/routes.ts', 2, skipped + ';');
const map = {files:[{file:'src/routes.ts', code:'app.get("/pedidos", handler);\n' + skipped + ';', reason:null}, {file:'bin.dat', code:null, reason:'binário'}], routes:[{file:'src/routes.ts', line:1, method:'GET', path:'/pedidos'}, {file:'bin.dat', line:1, method:'GET', path:'/ignorada'}]};

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
    assert.deepEqual(mapped.routes, [{file:'src/routes.ts', line:1, method:'GET', path:'/pedidos'}]);
    assert.doesNotMatch(mapped.files.find(f=>f.file==='pem-in-code.txt')!.code!, /synthetic-pem-only/);
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
  assert.equal(result.routes.length, 23);
  assert.match(result.notes.join(' '), /Rotas fora dos limites de envio ao examinador: 2/);
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
      if (task.checklist) return JSON.stringify({kind: 'exame', filesRead: [task.file], checklist: ['qa'], findings: []});
      assert.doesNotMatch(call.task, /CONCLUSAO_DO_AUTOR/);
      assert.equal(task.commit, commit);
      const index = reviews++;
      if (index < 3) {
        const verdict = reviewFixtureVerdict(task, [skipped, random, wait][index]!);
        valid.push(verdict);
        return JSON.stringify({...verdict, reason: 'Texto livre do revisor.'});
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
  assert.match(result.findings[1]!.reason, /valor aleatório/);
  assert.match(result.findings[2]!.reason, /espera de duração fixa/);
  const [verified, second] = result.findings;
  const evidence = moduleExamReviewEvidence('qa', verified!, code, disabled)!;
  assert.equal(hasModuleReviewProof(evidence, verified!), true);
  assert.equal(hasModuleReviewProof(evidence, {...verified!, reason: second!.reason}), false);
});

test('o descarte da hipótese exige declaração direta do mesmo teste e origem no commit atual', () => {
  const raw = qaStaticFinding('pricing.test.ts', 1, skipped);
  const active = 'test("valida pedidos", () => {})';
  const {message: _message, severity: _severity, ...origin} = raw;
  const evidence = {module: 'qa' as const, ...origin, code: active + ';', commit: 'c'.repeat(40), hypothesis: skipQuestion};
  const verdict = reviewFixtureVerdict(JSON.parse(moduleReviewTask(evidence)), active, 'descartado');
  assert.equal(hasModuleReviewProof(evidence, verdict), true);
  for (const code of [skipped + ';', active + '; ' + skipped + ';', active.replace('pedidos', 'preços') + ';']) {
    const updated = {...evidence, code};
    const task = JSON.parse(moduleReviewTask(updated));
    assert.equal(hasModuleReviewProof(updated, reviewFixtureVerdict(task, code.split(';')[0]!, 'descartado')), false);
  }
  const moved = {...evidence, commit: 'd'.repeat(40)};
  assert.equal(hasModuleReviewProof(moved, {...verdict, binding: JSON.parse(moduleReviewTask(moved)).binding}), false);
});

test('linhas cortadas no limite não chegam à revisão nem viram rotas julgadas', async () => {
  const examiner = seat('a'), reviewer = seat('b');
  const file = 'limited.test.ts';
  const line = skipped + '; app.get("/cortada", handler);';
  const target = qaStaticFinding(file, 2, line);
  const route = {file, line: 2, method: 'GET', path: '/cortada'};
  const head = '//'.padEnd(15950, 'x') + '\n';
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
      return JSON.stringify({kind: 'exame', filesRead: [file], checklist: ['qa'], routesReviewed: [route],
        findings: [{line: 2, snippet: skipped, hypothesis: skipQuestion, title: 'Trecho incompleto', severity: 'media'}]});
    }},
  });
  assert.deepEqual(result.routes, [{...route, status: 'nao_julgado'}]);
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
      'const quoted = "app.get(\'/texto\', handler)";',
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
    const masked = 'app.get("/segura", handler);\nconst token = "sintetico-privado";';
    await writeFile(join(dir, file), code);
    await writeFile(join(dir, 'masked.ts'), masked);
    await writeFile(join(dir, 'regex.js'), 'const regex = /app.get("\\/regex", fn)/;\napp.get("/omitida", handler);');
    await writeFile(join(dir, 'jsx.tsx'), '<p>app.get("/jsx", handler)</p>');
    await writeFile(join(dir, 'interpolation.ts'), 'const value = `texto ${`app.get("/interpolada", fn)`}`;');
    await writeFile(join(dir, 'docs.md'), 'app.get("/exemplo", handler);');
    const mapped = await mapModuleSnapshot(dir);
    assert.deepEqual(mapped.routes, [
      {file: 'masked.ts', line: 1, method: 'GET', path: '/segura'},
      {file, line: 12, method: 'GET', path: '/multilinha'},
      {file, line: 15, method: 'POST', path: '/literal'},
    ]);
    assert.deepEqual(findModuleExamRoutes(file, code.replaceAll('\n', '\r\n')), mapped.routes.slice(1));
    const suggested = {file, line: 8, method: 'GET', path: '/comentario'};
    const result = await examineFunctionalModule({module: 'qa', intentId, findings: [], map: {...mapped, routes: [suggested, ...mapped.routes]}});
    assert.equal(result.routes.length, 3);
    assert.match(result.notes.join(' '), /sintaxe não reconhecida: 2/);
    assert.match(result.notes.join(' '), /sem declaração verificável omitidas: 1/);
    const insideLiteral = qaStaticFinding(file, 2, skipped);
    assert.equal(moduleExamReviewEvidence('qa', moduleCollectorCandidate(insideLiteral),
      'const fixture = `\n' + skipped + ';\n`;', insideLiteral), null);
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
      return JSON.stringify({kind: 'exame', filesRead: [finding.file], checklist: ['qa'], findings: []});
    }},
  });
  assert.deepEqual(reservations, ['examiner', 'reviewer']);
  assert.deepEqual(releases, ['exited']);
  assert.deepEqual(result.findings.map(f => [f.status, f.failure]), Array(2).fill(['provavel', 'PROVIDER_USAGE_LIMIT']));
});
