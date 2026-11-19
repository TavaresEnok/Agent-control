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
      if (task.code && task.checklist) return JSON.stringify({kind:'exame', filesRead:['src/routes.ts'], checklist:['qa'], findings:[{line:1, snippet:'app.get', title:'PONTO DO EXAMINADOR', severity:'baixa'}]});
      return JSON.stringify({kind:'confirmacao', status:'confirmado', reason:'observação', proof: tasks.length === 2 ? '' : 'prova observada'});
    }},
  });
  assert.equal(result.coverage[0]!.examiner?.profileId, examiner.profileId);
  assert.equal(result.coverage[1]!.status, 'nao_julgado');
  assert.deepEqual(result.routes.map(x=>x.status), ['lido','nao_julgado']);
  assert.equal(result.findings[0]!.status, 'provavel');
  assert.equal(result.findings[1]!.status, 'confirmado');
  assert.equal(result.findings[1]!.verifier?.profileId, reviewer.profileId);
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

test('coletores isolados identificam apenas a evidência determinística da linha', async () => {
  const result = await examineFunctionalModule({module: 'qa', intentId, map, isolatedMeasurements: true, findings: [
    {...finding, evidence: 'app.get("/pedidos", handler);'},
    {...finding, evidence: 'app.get("/ausente", handler);'},
  ]});
  assert.equal(result.mode, 'somente_ferramentas');
  assert.deepEqual(result.findings.map(candidate => [candidate.status, candidate.verifier?.model]),
    [['confirmado', 'medição determinística'], ['provavel', undefined]]);
  assert.ok(result.coverage.every(row => row.status === 'nao_julgado'));
});
