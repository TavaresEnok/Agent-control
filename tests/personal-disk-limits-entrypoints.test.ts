import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {resolve} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const databaseUrl = process.env.AC_TEST_DATABASE_URL;

type Single = {hot: string; watch: number; worker: string; exam: string; design: string; unchanged: boolean; measuredHot: boolean; edgeWorker: string};
type Result = {
  volumes: string[];
  nonPersonalVolumes: string[];
  dockerStorage: string;
  dockerAsked: number;
  noDaemon: {worker: string; dockerMeasured: boolean; fullElsewhere: string};
  baseline: {reserve: string; counts: {grants: number; waits: number}};
  single: Single[];
  noExamDirectoryBeforeAdmission: boolean;
  full: Record<string, unknown>;
  edge: Record<string, unknown>;
  bareRootFallback: string;
};

// The child runs the real entrypoints with fs.promises.statfs replaced by a table of fake volumes (tests/fixtures/statfs-rules.mjs).
// Nothing fills a disk, and the installation, its data and its secrets are never touched: the database is disposable.
async function runChild(): Promise<Result> {
  const {stdout} = await exec(process.execPath, ['--import', 'tsx', '--import', resolve('tests/fixtures/statfs-rules.mjs'), resolve('tests/fixtures/disk-limits-child.ts')],
    {env: process.env, timeout: 240_000, maxBuffer: 8 * 1024 * 1024});
  const line = stdout.split('\n').find(row => row.startsWith('RESULT '));
  assert.ok(line, 'o filho não devolveu RESULT');
  return JSON.parse(line.slice('RESULT '.length)) as Result;
}

test('novos exames e novos trabalhadores recusam a 95% nos entrypoints reais; replay e reconciliação seguem; 94,99 admite',
  {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado', timeout: 300_000}, async () => {
    const result = await runChild();
    const [data, homes, planning, planningAccounts, execution, executionAccounts, temporary, projectsRoot, repository, secondRepository, docker] = result.volumes;
    assert.equal(result.volumes.length, 11, 'dados, homes, 2 raízes de planejamento, 2 de execução, temporário, raiz de projetos, 2 repositórios e armazenamento do Docker');
    assert.ok(result.volumes.every(volume => volume !== '/'), 'a raiz não é volume da instalação');
    assert.equal(docker, 'docker-storage:local');
    assert.deepEqual(result.nonPersonalVolumes, result.volumes.slice(0, 10), 'fora da instalação pessoal o Docker não é medido');
    assert.deepEqual(result.baseline, {reserve: 'OK', counts: {grants: 1, waits: 0}});

    // Cada volume da instalação sozinho a 95% bloqueia worker, exame de segurança e exame de design, com a raiz a 10%.
    assert.deepEqual(result.single.map(row => row.hot), [data, homes, planning, planningAccounts, execution, executionAccounts, temporary, projectsRoot, repository, secondRepository, docker]);
    for (const row of result.single) {
      assert.equal(row.worker, 'PERSONAL_DISK_FULL', `worker em ${row.hot}`);
      assert.equal(row.exam, 'PERSONAL_DISK_FULL', `exame em ${row.hot}`);
      assert.equal(row.design, 'PERSONAL_DISK_FULL', `design em ${row.hot}`);
      assert.equal(row.unchanged, true, `a recusa em ${row.hot} não grava concessão nem espera`);
      assert.equal(row.measuredHot, true, `${row.hot} foi medido`);
      assert.ok(row.watch >= 94.99 && row.watch <= 95.01, `o vigia enxerga ${row.hot} a 95%: ${row.watch}`);
      // Limiar 94,99 no mesmo volume: admitido.
      assert.equal(row.edgeWorker, 'OK', `94,99 em ${row.hot}`);
    }
    assert.equal(result.noExamDirectoryBeforeAdmission, true, 'a recusa não cria a árvore de verificações');

    // Tudo cheio: o novo é recusado; replay, liberação e leitura existentes continuam.
    assert.deepEqual(result.full, {refusedWorker: 'PERSONAL_DISK_FULL', refusedExam: 'PERSONAL_DISK_FULL', refusedDesign: 'PERSONAL_DISK_FULL',
      replay: 'OK', replayId: true, released: 'OK', progress: 'OK', state: 'released', newWork: 'unchanged', examDirectory: false});

    // Volumes da instalação a 94,99 com a raiz a 99%: admite os três, e a raiz nem é medida.
    assert.deepEqual(result.edge, {worker: 'OK', exam: 'OK/DISK_LIMITS_SENTINEL', design: 'OK', measuredRoot: false, measuredAll: true, examDirectory: true});

    // O Docker só é perguntado uma vez por execução, não a cada reserva; sem daemon local o volume some da medição e os demais continuam decidindo.
    assert.equal(result.dockerAsked, 1, 'a consulta ao daemon fica guardada entre as reservas');
    assert.deepEqual(result.noDaemon, {worker: 'OK', dockerMeasured: false, fullElsewhere: 'PERSONAL_DISK_FULL'});

    // Sem lista no Ledger o portão de capacidade cai para a raiz.
    assert.equal(result.bareRootFallback, 'PERSONAL_DISK_FULL');
  });
