import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {chmod, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {writeDesignLoginState} from '../src/design-browser.ts';
import {readDesignRepository} from '../src/design-command.ts';
import {designBenchWorker} from '../src/design-bench.ts';
import {readRebuildImagePin} from '../src/design-image-run.ts';
import {runDesignModule, type DesignModuleInput} from '../src/design-module.ts';
import {DESIGN_PLANTED_RULES, type DesignWorker} from '../src/design-types.ts';

const labRoot = fileURLToPath(new URL('./fixtures/design-lab-v2/', import.meta.url));
const labPassword = 'senha-lab-3';
const enabled = process.env.AC_DESIGN_LAB === '1';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function harness(tasks: string[]): Pick<DesignModuleInput, 'worker' | 'reserve' | 'release'> {
  const bench = designBenchWorker();
  const worker: DesignWorker = {
    async run(call) {
      tasks.push(call.task);
      return bench.run(call);
    },
  };
  return {
    worker,
    reserve: async role => ({
      provider: 'claude',
      model: role,
      accountId: randomUUID(),
      profileId: randomUUID(),
      grantId: randomUUID(),
    }),
    release: async () => {},
  };
}

test('a imagem real encontra os defeitos plantados do laboratório', {skip: !enabled}, async () => {
  const pin = readRebuildImagePin(await readFile(new URL('../deploy/design-image-digest.txt', import.meta.url), 'utf8'));
  const files = await readDesignRepository(labRoot);
  const data = await mkdtemp(join(tmpdir(), 'design-lab-v2-'));
  const tasks: string[] = [];
  const referenceName = 'referencia.png';
  let loginDir = '';
  try {
    loginDir = await mkdtemp(join(tmpdir(), 'design-lab-login-'));
    const loginFile = join(loginDir, 'login.json');
    const login = {
      username: 'ada',
      password: labPassword,
      usernameSelector: '#usuario',
      passwordSelector: '#senha',
      submitSelector: '#entrar',
    };
    await writeFile(loginFile, JSON.stringify(login), {mode: 0o600});
    await chmod(loginFile, 0o600);
    assert.equal((await stat(loginFile)).mode & 0o777, 0o600);
    const statePath = await writeDesignLoginState('http://design-lab.local:8080', login, pin);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    await rm(dirname(statePath), {recursive: true, force: true});
    const result = await runDesignModule({
      activation: 'personal',
      projectId: randomUUID(),
      repo: labRoot,
      targetUrl: 'http://design-lab.local:8080',
      dataDirectory: data,
      intentId: randomUUID(),
      runId: randomUUID(),
      createdAt: new Date('2026-11-18T18:00:00.000Z'),
      commit: 'lab',
      files,
      ...harness(tasks),
      referenceFiles: [{name: referenceName, bytes: PNG_1X1}],
      image: {pinnedImage: pin, timeoutMs: 1_800_000},
      scoreVisual: true,
      recordStates: true,
      regressionThreshold: 0.1,
      login,
    });
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    const raw = await readFile(join(result.directory, 'bruto', 'achados-brutos.json'), 'utf8');
    const coverage = await readFile(join(result.directory, 'cobertura-ferramentas.md'), 'utf8');
    const parsed = JSON.parse(raw) as {findings: {tool: string; file?: string; rule: string; severity: string; snippet: string; measure?: {kind?: string; px?: number}}[]};
    const rules = parsed.findings.map(item => `${item.tool} ${item.rule} ${item.severity} ${item.snippet}`);
    const summaryPath = join(data, 'lab-summary.json');
    await writeFile(summaryPath, JSON.stringify({
      directory: result.directory,
      coverage,
      readmeExcerpt: readme.slice(0, 12000),
      rules,
      achados: result.achados.map(item => ({id: item.id, reference: item.reference, status: item.status, severity: item.severity, verifier: item.verifier})),
    }, null, 2));
    console.log(await readFile(summaryPath, 'utf8'));
    const has = (tool: string, rule: string) => parsed.findings.some(item => item.tool === tool && item.rule.includes(rule));
    assert.equal(has('axe', 'WCAG-1-4-3-CONTRASTE') || has('axe', DESIGN_PLANTED_RULES.contrast), true, rules.join('\n'));
    assert.equal(parsed.findings.some(item => item.tool === 'pa11y' && /alt|image-alt|H37/i.test(item.rule + item.snippet)), true, rules.join('\n'));
    assert.equal(parsed.findings.some(item => item.tool === 'lighthouse' && (item.rule === 'LH-CLS' || item.rule === 'LH-LCP')), true, rules.join('\n'));
    assert.equal(has('stylelint', 'declaration-no-important'), true, rules.join('\n'));
    assert.equal(has('tokens', 'DESIGN-TOKENS-TIPO-CONTAGEM'), true, rules.join('\n'));
    assert.equal(has('tokens', DESIGN_PLANTED_RULES.grays), true, rules.join('\n'));
    assert.equal(parsed.findings.some(item => item.rule === 'DESIGN-ALVO-REFERENCIA' && item.measure?.kind === 'target' && item.measure.px === 30), true, rules.join('\n'));
    assert.match(readme, /Crítica visual/);
    assert.match(readme, /Julgamento incerto/);
    assert.match(readme, /A rota \/item\/:id usou o exemplo \/item\/42/);
    assert.match(readme, /\/painel: estado vazio, carregando, erro e logado não capturado/);
    assert.match(readme, /logado não capturado/);
    assert.doesNotMatch(readme, /\/: estado vazio, carregando, erro e logado não capturado/);
    assert.match(readme, /rota indisponível \(404\)/);
    assert.match(readme, /examinador \d+\/10, revisor /);
    assert.match(readme, /Medidos:/);
    assert.match(readme, /Esta rodada executou o contêiner/);
    assert.match(coverage, /css-analyzer/);
    const imageDoc = JSON.parse(await readFile(join(result.directory, 'imagem-achados-brutos.json'), 'utf8')) as {
      screenshots?: {route?: string; state?: string; fileName?: string; viewport?: number}[];
    };
    const shots = imageDoc.screenshots ?? [];
    assert.equal(shots.some(item => item.state === 'logado'), true);
    assert.equal(shots.some(item => item.route === '/' && item.state === 'logado'), true);
    const shotNamed = (state: string) => shots.find(item => item.route === '/' && item.state === state && item.viewport === 1440 && item.fileName);
    const anonShot = shotNamed('vazio') ?? shotNamed('padrao');
    const loggedShot = shotNamed('logado');
    assert.ok(anonShot?.fileName && loggedShot?.fileName);
    const anonBytes = await readFile(join(result.directory, 'capturas', anonShot.fileName));
    const loggedBytes = await readFile(join(result.directory, 'capturas', loggedShot.fileName));
    assert.notEqual(createHash('sha256').update(anonBytes).digest('hex'), createHash('sha256').update(loggedBytes).digest('hex'));
    const seen = await filesUnder(result.directory);
    for (const path of seen) {
      assert.equal((await readFile(path)).includes(Buffer.from(labPassword)), false, path);
    }
    assert.equal((await readFile(join(labRoot, 'public/index.html'), 'utf8')).includes(labPassword), false);
    assert.equal(shots.some(item => item.route === '/' && item.state === 'vazio'), true);
    assert.equal(shots.some(item => item.route === '/item/42' && item.state === 'padrao'), true);
    assert.equal(parsed.findings.some(item => item.rule === 'DESIGN-ROTA-INDISPONIVEL' && item.snippet.includes('404')), true, rules.join('\n'));
    assert.equal(parsed.findings.some(item => item.tool === 'css-analyzer' && item.rule.startsWith('DESIGN-WALLACE-') && item.measure?.kind === 'wallace'), true, rules.join('\n'));
    const wallace = parsed.findings.filter(item => item.tool === 'css-analyzer').length;
    const cssRow = coverage.split('\n').find(line => line.includes('css-analyzer'));
    assert.ok(cssRow, coverage);
    const cssCells = cssRow.split('|').slice(1, -1).map(cell => cell.trim());
    assert.equal(cssCells[3], String(wallace));
    assert.match(cssCells[2] ?? '', /folhas/);
    const referenceSha = createHash('sha256').update(PNG_1X1).digest('hex');
    assert.equal(tasks.some(task => task.includes('Referências visuais:') && task.includes(`nome=${referenceName}`) && task.includes(`contêiner=/planning/capturas/${referenceSha}.png`)), true);
    for (const line of coverage.split('\n')) {
      if (!line.startsWith('|') || line.startsWith('| Ferramenta') || line.startsWith('|---')) continue;
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
      assert.equal(cells.length, 5, line);
      for (const cell of cells) assert.notEqual(cell, '');
    }
    assert.match(coverage, /axe-core/);
    assert.match(coverage, /css-analyzer/);
    assert.equal(result.achados.some(item => item.reference.includes('WCAG') || item.reference.startsWith('DESIGN-')), true);
    // Régua e Tab real: /lab/sonda planta um defeito por regra. Depende da ligação no collect e no módulo.
    const onProbe = (tool: string, rule: string) => parsed.findings.filter(item => item.tool === tool && item.rule === rule);
    const scroll = onProbe('régua', 'DESIGN-TELA-ROLAGEM-HORIZONTAL');
    assert.equal(scroll.some(item => item.severity === 'alta' && item.measure?.kind === 'overflow'), true, rules.join('\n'));
    for (const rule of ['DESIGN-TEXTO-CORTADO-MEDIDO', 'DESIGN-IMAGEM-QUEBRADA', 'DESIGN-TEXTO-SOBRA', 'DESIGN-GRAFICO-SEM-ALTERNATIVA', 'DESIGN-CONTRASTE-ESTADO', 'DESIGN-MOVIMENTO-REDUZIDO']) {
      assert.equal(onProbe('régua', rule).length > 0, true, `${rule}\n${rules.join('\n')}`);
    }
    assert.equal(onProbe('régua', 'DESIGN-CONTRASTE-ESTADO').some(item => item.severity === 'alta' && item.measure?.kind === 'contrast'), true, rules.join('\n'));
    assert.equal(onProbe('teclado', 'WCAG-2-4-11-FOCO-ENCOBERTO').length > 0, true, rules.join('\n'));
    // As telas corretas do laboratório (/painel e /item/42) não disparam nenhuma regra da régua ou do Tab.
    const correct = (file: string) => file === 'app/painel/page.tsx' || file === 'public/painel.html' || file === 'public/item.html'
      || file.startsWith('/painel ') || file.startsWith('/item/42 ');
    const onCorrect = parsed.findings.filter(item => (item.tool === 'régua' || item.tool === 'teclado') && correct(item.file ?? ''));
    assert.deepEqual(onCorrect.map(item => `${item.tool} ${item.rule} ${item.file} ${item.snippet}`), []);
    assert.match(readme, /redirecionou para \/entrar/);
    assert.match(readme, /indisponível \(tela de erro do servidor de desenvolvimento\)/);
    assert.match(coverage, /\| régua \|/);
    assert.match(coverage, /\| teclado \|/);
  } finally {
    await rm(data, {recursive: true, force: true});
    await rm(loginDir, {recursive: true, force: true}).catch(() => undefined);
  }
});

async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(directory, {withFileTypes: true});
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}
