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
    await writeFile(join(dir, 'huge.ts'), 'x'.repeat(17000));
    await symlink('.env', join(dir, 'link'));
    const mapped = await mapModuleSnapshot(dir);
    assert.deepEqual(mapped.routes, [{file:'src/routes.ts', line:1, method:'GET', path:'/pedidos'}]);
    assert.equal(mapped.files.find(f=>f.file==='.env')?.code, null);
    assert.equal(mapped.files.find(f=>f.file==='link')?.code, null);
    assert.equal(mapped.files.find(f=>f.file==='huge.ts')?.code, null);
    assert.doesNotMatch(mapped.files.find(f=>f.file==='src/routes.ts')!.code!, /sintetico-privado/);
  } finally { await rm(dir, {recursive:true, force:true}); }
});

test('modo coletor conserva achado sem confirmação e rotas não julgadas', async () => {
  const result = await examineFunctionalModule({module:'qa', intentId, repo:'/synthetic', map, findings:[finding]});
  assert.equal(result.mode, 'somente_ferramentas');
  assert.equal(result.findings[0]!.status, 'provavel');
  assert.equal(result.findings[0]!.verifier, null);
  assert.ok(result.coverage.every(row=>row.status === 'nao_julgado'));
  assert.ok(result.routes.every(row=>row.status === 'nao_julgado'));
});

test('examinador e revisor distintos, só evidência no pedido e prova obrigatória para confirmação', async () => {
  const examiner = seat('a'), reviewer = seat('b');
  const tasks: any[] = [], releases: string[] = [];
  const result = await examineFunctionalModule({module:'qa', intentId, repo:'/synthetic', map, findings:[finding],
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
  const result = await examineFunctionalModule({module:'qa', intentId, repo:'/synthetic', map, findings:[finding],
    reserve: async purpose => purpose === 'examiner' ? examiner : reviewer,
    release: async (_seat, state) => { released.push(state); },
    worker: {run: async () => JSON.stringify({kind:'exame', filesRead:['src/routes.ts'], checklist:['qa'], findings:[]})},
  });
  assert.equal(result.findings[0]!.failure, 'MODULE_EXAM_PROVIDER_NOT_DISTINCT');
  assert.equal(result.findings[0]!.status, 'provavel');
  assert.deepEqual(released, ['exited','not_started']);
  const quota = await examineFunctionalModule({module:'qa', intentId, repo:'/synthetic', map, findings:[finding],
    reserve: async () => { throw new Refusal('PROVIDER_USAGE_LIMIT'); }, release: async () => {}, worker:{run:async()=>''},
  });
  assert.equal(quota.coverage[0]!.reason, 'PROVIDER_USAGE_LIMIT');
  const uncertain = await examineFunctionalModule({module:'qa', intentId, repo:'/synthetic', map, findings:[],
    reserve: async () => examiner, release: async () => { throw Error('não deve liberar'); }, worker:{run:async()=>{ throw new Refusal('VERIFY_EXAM_TIMEOUT'); }},
  });
  assert.equal(uncertain.coverage[0]!.reason, 'VERIFY_EXAM_TIMEOUT');
});

test('falha de cota do revisor não inventa confirmação', async () => {
  const examiner = seat('a');
  const result = await examineFunctionalModule({module:'qa', intentId, repo:'/synthetic', map, findings:[finding],
    reserve: async purpose => { if (purpose === 'reviewer') throw new Refusal('PROVIDER_USAGE_LIMIT'); return examiner; },
    release: async () => {}, worker:{run:async()=>JSON.stringify({kind:'exame',filesRead:['src/routes.ts'],checklist:['qa'],findings:[]})},
  });
  assert.equal(result.findings[0]!.failure, 'PROVIDER_USAGE_LIMIT');
  assert.equal(result.findings[0]!.verifier, null);
  assert.equal(result.findings[0]!.status, 'provavel');
});

test('recusa de autorização encerra o exame', async () => {
  await assert.rejects(() => examineFunctionalModule({module:'qa', intentId, repo:'/synthetic', map, findings:[],
    reserve: async () => { throw new Refusal('PROJECT_FORBIDDEN', 403); },
    release: async () => {}, worker:{run:async()=>''},
  }), (error: unknown) => error instanceof Refusal && error.code === 'PROJECT_FORBIDDEN');
});
