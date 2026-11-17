import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {cp, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative, sep} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {Capacity} from '../src/capacity.ts';
import {Ledger} from '../src/ledger.ts';
import {ChecklistItem, ConfirmResult, ExamResult, MapResult, type VerifyWorker, type VerifyWorkerCall} from '../src/verify-types.ts';
import {runSecurityVerification} from '../src/verify-runtime.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const exec = promisify(execFile);
const fixture = join(import.meta.dirname, 'fixtures', 'verify-lab');
const credentialShape = /(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;

type Hit = {
  id: string; file: string; line: number; kind: 'falha' | 'falso';
  severity: 'alta' | 'media' | 'baixa'; cwe: `CWE-${number}` | null;
  title: string; snippet: string; scenario: string; suggestion: string; reason: string; proof: string;
};

function preview(secret: string): string {
  return `${secret.slice(0, 4)}… (sha256:${createHash('sha256').update(secret).digest('hex')})`;
}

function scrub(text: string, secrets: readonly string[]): string {
  return [...secrets].sort((a, b) => b.length - a.length).reduce((out, secret) => out.split(secret).join(preview(secret)), text);
}

function codeLine(line: string): string {
  return line.replace(/\/\*.*?\*\//g, '').replace(/^\s*\/\/.*$/, '');
}

async function filesOf(repo: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, {withFileTypes: true})) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'planted.json') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(relative(repo, full).split(sep).join('/'));
    }
  }
  await walk(repo);
  return out.sort();
}

async function gitLog(repo: string): Promise<string> {
  try { return (await exec('git', ['-C', repo, 'log', '-p', '--all'], {maxBuffer: 2_000_000})).stdout; }
  catch { return ''; }
}

async function analyze(repo: string): Promise<{hits: Hit[]; secrets: string[]}> {
  const hits: Hit[] = [];
  const secrets = [...new Set((await gitLog(repo)).match(credentialShape) ?? [])];
  const present = new Set<string>();
  for (const file of await filesOf(repo)) {
    const text = await readFile(join(repo, file), 'utf8');
    for (const secret of secrets) if (text.includes(secret)) present.add(secret);
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      const code = codeLine(line);
      const lineNo = index + 1;
      const snippet = line.trim().slice(0, 240);
      if (file === 'src/store.js' && /\$1/.test(code) && /query\(/.test(code) && !/\+/.test(code)) {
        hits.push({id: 'sql-placeholder', file, line: lineNo, kind: 'falso', severity: 'baixa', cwe: null, title: 'sql-placeholder: consulta com placeholder', snippet, scenario: 'A consulta usa $1 e o valor vai separado, na lista de parâmetros.', suggestion: 'Manter o placeholder; isto não é concatenação.', reason: 'O texto SQL não concatena a entrada; o valor viaja como parâmetro $1.', proof: `${file}:${lineNo}`});
      }
      if (/(SELECT|INSERT|UPDATE|DELETE)/i.test(code) && /\+/.test(code)) {
        hits.push({id: 'sql-concat', file, line: lineNo, kind: 'falha', severity: 'alta', cwe: 'CWE-89', title: 'sql-concat: consulta SQL concatenada', snippet, scenario: 'A consulta monta o SQL juntando texto com a entrada do pedido.', suggestion: 'Usar placeholder e passar o valor fora do texto SQL.', reason: 'Há concatenação de SQL com dado do pedido.', proof: `${file}:${lineNo}`});
      }
      if (file === 'src/app.js' && (code.includes("'/admin'") || code.includes('"/admin"'))) {
        const around = lines.slice(Math.max(0, index - 5), index + 8).map(codeLine).join('\n');
        if (!/autoriz|isAdmin|session|requireAuth|\brole\b/.test(around)) {
          hits.push({id: 'admin-sem-autorizacao', file, line: lineNo, kind: 'falha', severity: 'alta', cwe: 'CWE-862', title: 'admin-sem-autorizacao: rota /admin sem autorização', snippet, scenario: 'GET /admin responde sem conferir quem chama.', suggestion: 'Exigir autorização antes de responder /admin.', reason: 'A rota /admin não tem checagem de autorização.', proof: `${file}:${lineNo}`});
        }
      }
      if (file === 'src/notes.js' && /^\s*\/\//.test(line) && /didático|didatico/i.test(line)) {
        hits.push({id: 'comentario-didatico', file, line: lineNo, kind: 'falso', severity: 'baixa', cwe: null, title: 'comentario-didatico: comentário didático', snippet: snippet.slice(0, 240), scenario: 'O arquivo só comenta uma falha; não registra rota nem executa SQL.', suggestion: 'Não tratar comentário didático como falha.', reason: 'É comentário, não código que atende pedido.', proof: `${file}:${lineNo}`});
      }
      if (file === 'src/files.js' && /\bjoin\s*\(/.test(code) && /req\./.test(code)) {
        hits.push({id: 'path-join-entrada', file, line: lineNo, kind: 'falha', severity: 'alta', cwe: 'CWE-22', title: 'path-join-entrada: path.join com entrada do pedido', snippet, scenario: 'path.join recebe um pedaço vindo do pedido.', suggestion: 'Fixar o diretório base e recusar o caminho que sair dele.', reason: 'path.join usa a entrada do pedido.', proof: `${file}:${lineNo}`});
      }
      if (file === 'Dockerfile' && /^\s*USER\s+root\s*$/i.test(line)) {
        hits.push({id: 'dockerfile-root', file, line: lineNo, kind: 'falha', severity: 'media', cwe: 'CWE-250', title: 'dockerfile-root: Dockerfile com USER root', snippet, scenario: 'A imagem declara USER root.', suggestion: 'Trocar por um usuário sem privilégio de root.', reason: 'O Dockerfile fixa USER root.', proof: `${file}:${lineNo}`});
      }
      if (file === 'Dockerfile.safe' && /^\s*USER\s+node\s*$/i.test(line)) {
        hits.push({id: 'dockerfile-node', file, line: lineNo, kind: 'falso', severity: 'baixa', cwe: null, title: 'dockerfile-node: USER node', snippet, scenario: 'Dockerfile.safe já usa USER node.', suggestion: 'Não marcar USER node como root.', reason: 'O usuário da imagem segura é node, não root.', proof: `${file}:${lineNo}`});
      }
    });
    if (file === 'package.json') {
      const pkg = JSON.parse(text) as {dependencies?: Record<string, string>; devDependencies?: Record<string, string>};
      const version = pkg.dependencies?.minimist ?? pkg.devDependencies?.minimist;
      if (version === '0.0.8') {
        const lineNo = lines.findIndex(line => line.includes('minimist')) + 1;
        hits.push({id: 'minimist-0-0-8', file, line: lineNo, kind: 'falha', severity: 'alta', cwe: 'CWE-1321', title: 'minimist-0-0-8: minimist 0.0.8', snippet: lines[lineNo - 1]?.trim().slice(0, 240) ?? 'minimist 0.0.8', scenario: 'package.json fixa minimist 0.0.8, versão com falha conhecida.', suggestion: 'Trocar minimist 0.0.8 por uma versão corrigida.', reason: 'A dependência declarada é minimist 0.0.8.', proof: `${file}:${lineNo}`});
      }
    }
  }
  const historical = secrets.filter(secret => !present.has(secret));
  if (historical.length && (await filesOf(repo)).includes('src/historico.js')) {
    const shown = historical.map(preview).join(', ');
    hits.push({id: 'segredo-historico', file: 'src/historico.js', line: 1, kind: 'falha', severity: 'alta', cwe: 'CWE-798', title: 'segredo-historico: credencial no histórico do git', snippet: shown.slice(0, 240), scenario: 'Um valor com cara de credencial foi commitado e depois apagado; o git log ainda o tem.', suggestion: 'Tirar a credencial do histórico e rotacionar o valor.', reason: `O git log tem credencial fora da árvore atual: ${shown}`, proof: `git log ${shown}`});
  }
  return {hits: hits.map(hit => ({...hit, snippet: scrub(hit.snippet, secrets), scenario: scrub(hit.scenario, secrets), suggestion: scrub(hit.suggestion, secrets), reason: scrub(hit.reason, secrets), proof: scrub(hit.proof, secrets), title: scrub(hit.title, secrets)})), secrets};
}

function checklistIds(task: string, known: readonly string[]): string[] {
  const mentioned = [...task.matchAll(/\b[A-Z][A-Z0-9-]{2,80}\b/g)].map(match => match[0]).filter(id => known.includes(id));
  return [...new Set(mentioned.length ? mentioned : known)].slice(0, 80);
}

function worker(knownChecklist: readonly string[]): VerifyWorker {
  return {async run(call: VerifyWorkerCall) {
    if (call.writePaths.length !== 0) throw new Error('writePaths');
    const task = call.task.toLowerCase();
    const {hits, secrets} = await analyze(call.repo);
    const clean = (value: string) => scrub(value, secrets);
    if (call.role === 'reviewer' || task.includes('confirmresult') || task.includes('confirmação') || task.includes('confirmacao')) {
      const cited = hits.find(hit => call.task.includes(hit.id))
        ?? hits.find(hit => hit.snippet.length > 8 && call.task.includes(hit.snippet))
        ?? hits.find(hit => call.task.includes(hit.file) && new RegExp(`${hit.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:${hit.line}\\b`).test(call.task))
        ?? (hits.filter(hit => call.task.includes(hit.file)).length === 1 ? hits.find(hit => call.task.includes(hit.file)) : undefined);
      const result = ConfirmResult.parse(cited ? {
        kind: 'confirmacao',
        status: cited.kind === 'falha' ? 'confirmado' : 'descartado',
        reason: clean(cited.reason),
        proof: clean(cited.proof),
      } : {kind: 'confirmacao', status: 'descartado', reason: 'O trecho citado não é uma falha lida no código nem no git log.', proof: 'releitura do repositório'});
      return JSON.stringify(result);
    }
    const wantsExam = task.includes('examresult') || (task.includes('exame') && !task.includes('mapresult'));
    const wantsMap = !wantsExam && (task.includes('mapresult') || task.includes('mapa') || task.includes('kind":"mapa"'));
    if (wantsMap) {
      const routes = hits.filter(hit => hit.id === 'admin-sem-autorizacao').map(hit => ({method: 'GET', path: '/admin', file: hit.file, line: hit.line}));
      const health = (await readFile(join(call.repo, 'src/app.js'), 'utf8')).split('\n').findIndex(line => line.includes("'/saude'"));
      if (health >= 0) routes.push({method: 'GET', path: '/saude', file: 'src/app.js', line: health + 1});
      return JSON.stringify(MapResult.parse({kind: 'mapa', routes, surfaces: ['rotas', 'sql', 'arquivos', 'dockerfile', 'dependencias', 'git']}));
    }
    const scoped = (await filesOf(call.repo)).filter(file => call.task.includes(file));
    const selected = hits.filter(hit => scoped.length === 0 || scoped.includes(hit.file));
    const filesRead = [...new Set(selected.map(hit => hit.file))];
    const allFiles = await filesOf(call.repo);
    return JSON.stringify(ExamResult.parse({
      kind: 'exame',
      filesRead: (filesRead.length ? filesRead : allFiles).slice(0, 80),
      checklist: checklistIds(call.task, knownChecklist),
      findings: selected.map(hit => ({title: hit.title, severity: hit.severity, file: hit.file, line: hit.line, scenario: hit.scenario, suggestion: hit.suggestion, cwe: hit.cwe, reference: hit.id, snippet: hit.snippet})),
    }));
  }};
}

async function treeText(dir: string): Promise<string> {
  let out = '';
  async function walk(current: string) {
    for (const entry of await readdir(current, {withFileTypes: true})) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out += await readFile(full, 'utf8');
    }
  }
  await walk(dir);
  return out;
}

test('régua confirma falhas plantadas e descarta falsos positivos', async () => {
  const databaseUrl = process.env.AC_TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'AC_TEST_DATABASE_URL');
  const database = await isolatedDatabase(databaseUrl, 'ruler');
  const db = new Ledger(database.url);
  const repo = await mkdtemp(join(tmpdir(), 'ac-verify-ruler-'));
  const data = await mkdtemp(join(tmpdir(), 'ac-verify-data-'));
  const secret = ['ghp', 'VerifyLabFicticioNaoUsar00000000'].join('_');
  try {
    await cp(fixture, repo, {recursive: true, filter: source => !source.endsWith(`${sep}planted.json`)});
    await exec('git', ['-C', repo, 'init']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'verify-lab@localhost']);
    await exec('git', ['-C', repo, 'config', 'user.name', 'verify-lab']);
    await writeFile(join(repo, 'credencial.txt'), `${secret}\n`, {mode: 0o600});
    await exec('git', ['-C', repo, 'add', '-A']);
    await exec('git', ['-C', repo, 'commit', '-m', 'adiciona credencial ficticia']);
    await rm(join(repo, 'credencial.txt'));
    await exec('git', ['-C', repo, 'add', '-A']);
    await exec('git', ['-C', repo, 'commit', '-m', 'remove credencial ficticia']);
    const commit = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    assert.match(commit, /^[a-f0-9]{40}$/);
    assert.equal((await readFile(join(repo, 'credencial.txt'), 'utf8').catch(() => '')).includes(secret), false);
    await db.migrate();
    const principal = 'verify-ruler-owner';
    const project = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Régua de verificação']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 4, evaluationLimit: 8});
    const claude = randomUUID();
    const grok = randomUUID();
    const specialist = randomUUID();
    const reviewer = randomUUID();
    await capacity.registerModel(principal, {provider: 'claude', model: 'claude-opus-5-5', efforts: ['high'], roles: ['specialist'], source: 'synthetic://verify-ruler'});
    await capacity.registerModel(principal, {provider: 'grok', model: 'grok-4.7', efforts: ['high'], roles: ['reviewer'], source: 'synthetic://verify-ruler'});
    await capacity.addAccount(principal, project, {id: claude, provider: 'claude', label: 'claude', resourceIdentity: `claude:${claude}`, mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://verify-ruler', maxConcurrent: 4});
    await capacity.addAccount(principal, project, {id: grok, provider: 'grok', label: 'grok', resourceIdentity: `grok:${grok}`, mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://verify-ruler', maxConcurrent: 4});
    await capacity.addProfile(principal, project, {id: specialist, accountId: claude, model: 'claude-opus-5-5', effort: 'high', role: 'specialist'});
    await capacity.addProfile(principal, project, {id: reviewer, accountId: grok, model: 'grok-4.7', effort: 'high', role: 'reviewer'});
    const revision = await capacity.publish(principal, project, 0, {schemaVersion: 1, maxProgrammersPerContext: 2, maxEvaluatorsPerContext: 4, roles: {specialist: {regular: [specialist], emergency: []}, reviewer: {regular: [reviewer], emergency: []}}});
    const context = await db.createContext(principal, project, randomUUID());
    await capacity.assignPolicy(principal, context, revision);
    await capacity.observeQuota(principal, claude, {status: 'available', source: 'synthetic://verify-ruler', ttlSeconds: 3600});
    await capacity.observeQuota(principal, grok, {status: 'available', source: 'synthetic://verify-ruler', ttlSeconds: 3600});
    const authority = await db.acquire(principal, context, randomUUID(), 'verify-ruler', 60);
    const checklist = [
      ChecklistItem.parse({id: 'LAB-SQL', source: 'CWE-TOP-25', title: 'Consulta SQL', appliesTo: 'code', prompt: 'Concatenação de SQL com entrada.'}),
      ChecklistItem.parse({id: 'LAB-AUTH', source: 'OWASP-2025', title: 'Autorização', appliesTo: 'route', prompt: 'Rota sem autorização.'}),
      ChecklistItem.parse({id: 'LAB-PATH', source: 'CWE-TOP-25', title: 'Caminho', appliesTo: 'code', prompt: 'path.join com entrada do pedido.'}),
      ChecklistItem.parse({id: 'LAB-DOCKER', source: 'ASVS-5.0', title: 'Imagem', appliesTo: 'dockerfile', prompt: 'USER root.'}),
      ChecklistItem.parse({id: 'LAB-DEP', source: 'CWE-TOP-25', title: 'Dependência', appliesTo: 'dependency', prompt: 'Versão vulnerável declarada.'}),
      ChecklistItem.parse({id: 'LAB-SECRET', source: 'ASVS-5.0', title: 'Segredo', appliesTo: 'secret', prompt: 'Credencial no histórico do git.'}),
    ];
    const oracle = JSON.parse(await readFile(join(fixture, 'planted.json'), 'utf8')) as {failures: {id: string; file: string}[]; falsePositives: {id: string; file: string}[]};
    const result = await runSecurityVerification({
      ledger: db, principal, authority, projectId: project, repoPath: repo, dataDirectory: data, commit, policyRevision: revision, worker: worker(checklist.map(item => item.id)), checklist,
    });
    const mentions = (achado: {title: string; reference: string; where: {file: string}; sources: string[]; scenario: string; proof: string}, item: {id: string; file: string}) =>
      achado.where.file === item.file && JSON.stringify({title: achado.title, reference: achado.reference, sources: achado.sources, scenario: achado.scenario, proof: achado.proof}).includes(item.id);
    for (const failure of oracle.failures) {
      assert.ok(result.achados.some(achado => achado.status === 'confirmado' && mentions(achado, failure)), failure.id);
    }
    for (const falsePositive of oracle.falsePositives) {
      const discarded = result.achados.filter(achado => achado.status === 'descartado' && mentions(achado, falsePositive));
      assert.equal(discarded.length, 1, falsePositive.id);
      assert.equal(result.achados.some(achado => achado.status === 'confirmado' && mentions(achado, falsePositive)), false, falsePositive.id);
    }
    const report = JSON.stringify(result.achados) + await treeText(result.directory);
    assert.equal(report.includes(secret), false);
  } finally {
    await db.close();
    await database.close();
    await rm(repo, {recursive: true, force: true});
    await rm(data, {recursive: true, force: true});
  }
});
