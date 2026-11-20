import {assertDiskSpaceForLaunch} from './personal-disk.ts';
import {constants, existsSync} from 'node:fs';
import {mkdtemp, open, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Id, Refusal} from './contracts.ts';
import {EXAM_LOGIN_STALE_TEXT} from './exam-login.ts';
import {writeDesignLoginState} from './design-browser.ts';
import {readDesignCaptureStageNote, writeDesignExamCaptures} from './design-capture-stage.ts';
import {captureScreens, planCaptures, type DesignCaptureDriver, type DesignEmptyStateRecord} from './design-capture.ts';
import {collectDesignFindings, designRawDocument, type DesignSourceFile, type DesignToolReports} from './design-collect.ts';
import {discoverRoutesFromSource, dynamicRoutesMissingExample, screenCoverageMarkdown, sourceHasEmptyState, type DesignLogin, type DiscoveredRoute, type ScreenCoverageRow} from './design-discover.ts';
import {examineDesignScreens, type DesignExamineInput, type DesignScreenCapture, type DesignSeat} from './design-examine.ts';
import {takeExamStripNote} from './exam-strip-note.ts';
import {assertDesignTarget} from './design-image.ts';
import {
  applyHostFindingCounts,
  designExamPlan,
  executeDesignImage,
  toolCoverageMarkdown,
  toolCoverageTable,
  type DesignComputedSample,
  type DesignImageExecution,
  type DesignImageSpawn,
} from './design-image-run.ts';
import {parseDesignProjectConfig, planDesignRoutes, type DesignProjectConfig} from './design-project-config.ts';
import {stageDesignReferences} from './design-reference-files.ts';
import {approveDesignBaseline, baselineBuffer, regressionHits, regressionMarkdown} from './design-regression.ts';
import {stylelintConfig} from './design-stylelint.ts';
import {analyzeDesignTokens, loadDesignReferences, tokenReportMarkdown} from './design-tokens.ts';
import {visualReportMarkdown} from './design-visual.ts';
import {markPngRect} from './design-mark.ts';
import {readDesignReport, writeDesignReport, type DesignReportCapture} from './design-report.ts';
import {loadDesignChecklist} from './design-checklist.ts';
import {
  DESIGN_ACCEPTANCE,
  DesignAchado,
  type DesignAchado as DesignAchadoValue,
  type DesignConfirmResult,
  type DesignExamFinding,
  type DesignRawFinding,
  type DesignWorker,
} from './design-types.ts';

const MAX_SCREENS = 40;
const MAX_CAPTURE_ROUTES = 8;

export type DesignModuleMark = {
  fileName: string;
  rect: {x: number; y: number; width: number; height: number};
};

/**
 * Pedido do módulo 10. `files` é o projeto já lido pelo chamador.
 * `worker` é o especialista pessoal; o `reserve` do revisor tem de ser outro provedor.
 * A senha de `login`, quando há captura, não entra no relatório.
 */
export type DesignModuleInput = {
  activation: string;
  projectId: string;
  repo: string;
  targetUrl: string;
  dataDirectory: string;
  intentId: string;
  runId: string;
  createdAt: Date;
  commit: string;
  files: readonly DesignSourceFile[];
  worker: DesignWorker;
  reserve: DesignExamineInput['reserve'];
  release: (seat: DesignSeat) => Promise<void>;
  tools?: DesignToolReports;
  driver?: DesignCaptureDriver;
  login?: DesignLogin;
  captureDarkTheme?: boolean;
  forceStates?: boolean;
  marks?: readonly DesignModuleMark[];
  note?: string;
  /** Quando presente, o módulo executa a imagem antes do exame, como a CLI. */
  image?: {pinnedImage: string; run?: DesignImageSpawn; timeoutMs?: number};
  scoreVisual?: boolean;
  recordStates?: boolean;
  computedSamples?: readonly DesignComputedSample[];
  analyzeTokens?: boolean;
  regressionThreshold?: number;
  approveBaseline?: boolean;
  referenceFiles?: readonly {name: string; bytes: Buffer}[];
  /** Rotas já resolvidas, usadas pelo modo criar. */
  routes?: readonly {route: string}[];
};

export type DesignModuleResult = {
  findings: DesignRawFinding[];
  achados: DesignAchadoValue[];
  directory: string;
  directoryName: string;
  coverageMarkdown: string;
  visualLow: boolean;
  loginStale: boolean;
  visualUnjudged: boolean;
  visualRequested?: number;
  visualJudged?: number;
  visualMissing?: string[];
};

/**
 * Ponto de encaixe do módulo 10.
 * Recebe o projeto e a URL de homologação e devolve achados no formato do módulo 1:
 * `findings` repete RawFinding (ferramenta, regra, CWE, arquivo, linha, gravidade, trecho, impressão)
 * e `achados` repete Achado, já confirmado por outro provedor.
 * O modo locked não muda: qualquer ativação que não seja "personal" é recusada
 * sem consultar o banco e sem gravar relatório.
 */
export async function runDesignModule(input: DesignModuleInput): Promise<DesignModuleResult> {
  if (input.activation !== 'personal') throw new Refusal('PERSONAL_ACTIVATION_REQUIRED', 403);
  if (!Id.safeParse(input.intentId).success || !Id.safeParse(input.runId).success) {
    throw new Refusal('DESIGN_MODULE_INVALID', 400);
  }
  const target = assertDesignTarget(input.targetUrl);
  await assertDiskSpaceForLaunch(input.dataDirectory);
  const rawDesignConfig = await readRepoDesignConfig(input.repo, input.files);
  const projectConfig = parseDesignProjectConfig(rawDesignConfig);
  const hasProjectConfig = rawDesignConfig !== undefined && rawDesignConfig.trim().length > 0;
  const plannedStates = input.recordStates === true ? statePlan(input.files, projectConfig) : undefined;
  const reference = input.referenceFiles === undefined || input.referenceFiles.length === 0
    ? undefined
    : await stageDesignReferences({dataDirectory: input.dataDirectory, runId: input.runId, files: input.referenceFiles, repository: input.repo});
  let loginState: string | undefined;
  let loginDir: string | undefined;
  let loginNote = '';
  if (input.image !== undefined && plannedStates?.wantsLogin === true && input.login !== undefined) {
    try {
      loginState = await writeDesignLoginState(input.targetUrl, input.login, input.image.pinnedImage);
      loginDir = dirname(loginState);
    } catch (error) {
      if (error instanceof Refusal && error.code === 'DESIGN_PASSWORD_LEAK') throw error;
      loginNote = 'O estado logado não foi capturado: o login no host falhou.';
    }
  }
  const image = await (async () => {
    try {
      return input.image === undefined ? undefined : await executeDesignImage({
    image: input.image.pinnedImage,
    repository: input.repo,
    targetUrl: input.targetUrl,
    plan: input.routes !== undefined
      ? {
          routes: input.routes.slice(0, 40).map(route => ({
            route: route.route,
            themes: filesDark(input.files) ? ['claro' as const, 'escuro' as const] : ['claro' as const],
            states: ['padrao' as const],
          })),
          viewports: [375, 768, 1440],
          stylelint: stylelintConfig(),
        }
      : plannedStates === undefined
      ? designExamPlan(discoverRoutesFromSource(input.files), filesDark(input.files))
      : {
          routes: plannedStates.planned.map(route => ({
            route: route.route,
            themes: route.themes,
            states: imageStates(route),
          })),
          viewports: [375, 768, 1440],
          stylelint: stylelintConfig(),
        },
    ...(input.image.run === undefined ? {} : {run: input.image.run}),
    ...(input.image.timeoutMs === undefined ? {} : {timeoutMs: input.image.timeoutMs}),
    ...(loginState === undefined ? {} : {loginState}),
      });
    } finally {
      if (loginDir !== undefined) await rm(loginDir, {recursive: true, force: true});
    }
  })();
  if (image && !image.ok) {
    await writeImageFailure(input, target.origin, image);
    throw new Refusal(image.code === 'DESIGN_IMAGE_TIMEOUT' ? 'DESIGN_IMAGE_TIMEOUT' : 'DESIGN_IMAGE_FAILED');
  }
  const findings = attributeDesignFindings(
    collectDesignFindings(input.files, mergeTools(input.tools, image?.tools)),
    input.files,
    routeFileMap(input.files, projectConfig),
  );
  for (const item of image?.declaredFindings ?? []) {
    if (!findings.some(existing => existing.fingerprint === item.fingerprint)) findings.push(item);
  }
  const samples = [...(image?.computed ?? []), ...(input.computedSamples ?? [])];
  const tokens = samples.length > 0 || input.analyzeTokens === true
    ? analyzeDesignTokens(input.files[0]?.path ?? 'tokens', samples, loadDesignReferences(referencesDirectory()))
    : undefined;
  if (tokens) findings.push(...tokens.findings);
  const imageRows = image === undefined ? [] : applyHostFindingCounts(image.coverage, findings);
  const routes = screenRoutesForExam(input.files, input.routes);
  const loggedRoutes = new Set((image?.shots ?? []).filter(shot => shot.state === 'logado').map(shot => shot.route));
  const stateNotes = [
    ...(plannedStates?.notes ?? []).filter(note => {
      const route = note.split(':')[0] ?? '';
      return !(loggedRoutes.has(route) && note.includes('logado não capturado'));
    }),
    ...(loginNote.length > 0 ? [loginNote] : []),
    ...(image?.notes.filter(note => note.includes('indisponível')) ?? []),
  ];
  const notes: string[] = [...stateNotes];
  if (reference) notes.push(reference.note);
  const captured = await captureIfAsked(input, target.origin, routes, notes);
  for (const shot of image?.shots ?? []) {
    if (shot.theme !== 'claro' && shot.theme !== 'escuro') continue;
    if (captured.files.some(file => file.fileName === shot.fileName)) continue;
    captured.files.push({fileName: shot.fileName, bytes: shot.bytes});
    captured.records.push({route: shot.route, viewport: shot.viewport, theme: shot.theme, fileName: shot.fileName});
    captured.held.push({
      route: shot.route,
      viewport: shot.viewport,
      theme: shot.theme,
      state: shot.state,
      fileName: shot.fileName,
      bytes: shot.bytes,
    });
  }
  if (image) notes.push(`Imagem ${image.code}.`);
  const staged = await stageDesignCaptures(input.dataDirectory, input.runId, captured.held, input.referenceFiles ?? []);
  const routesByFile = new Map<string, string[]>();
  for (const route of routes) {
    const key = route.file.slice(0, 400);
    const list = routesByFile.get(key);
    if (list === undefined) routesByFile.set(key, [route.route]);
    else if (!list.includes(route.route)) list.push(route.route);
  }
  let examined: Awaited<ReturnType<typeof examineDesignScreens>>;
  try {
    const chosen = chooseScreens(input.files, routes, findings);
    if (chosen.omitted > 0) notes.push(`O exame cobriu ${chosen.screens.length} de ${chosen.screens.length + chosen.omitted} arquivos de tela.`);
    const screens = chosen.screens.map(screen => {
      const related = routesByFile.get(screen.file) ?? [screen.route];
      const captures = related.flatMap(route => staged.byRoute.get(route) ?? []);
      return {
        ...screen,
        captureNote: captureNoteFor(screen.route, captured.records),
        ...(captures.length > 0 ? {captures} : {}),
      };
    });
    if (screens.length === 0) notes.push('Nenhuma tela de código entrou no exame.');
    staged.publish();
    examined = await examineDesignScreens({
      repo: input.repo,
      intentId: input.intentId,
      screens,
      checklist: loadDesignChecklist(),
      rawFindings: findings,
      worker: input.worker,
      reserve: input.reserve,
      release: input.release,
      ...(input.scoreVisual === true ? {scoreVisual: true} : {}),
      ...(reference?.note ? {referenceNote: reference.note} : {}),
      ...(staged.references.length > 0 ? {references: staged.references} : {}),
    });
    const stageNote = await readDesignCaptureStageNote();
    if (stageNote !== undefined) notes.push(stageNote);
  } finally {
    staged.conceal();
    await staged.cleanup();
  }
  notes.push(...examined.notes);
  if (examined.loginStale) {
    const at = notes.indexOf(EXAM_LOGIN_STALE_TEXT);
    if (at >= 0) notes.splice(at, 1);
    notes.unshift(EXAM_LOGIN_STALE_TEXT);
  }
  const strip = takeExamStripNote(input.intentId);
  if (strip) notes.push(strip);
  const regression = await regressionSection(input, captured.files);
  for (const diff of regression.diffs) {
    if (!captured.files.some(file => file.fileName === diff.fileName)) captured.files.push(diff);
  }
  if (input.approveBaseline === true) await approveDesignBaseline({dataDirectory: input.dataDirectory, projectId: input.projectId, captures: captured.files.filter(file => !file.fileName.startsWith('diff-'))});
  const achados = assembleAchados(findings, examined.confirmations);
  if (achados.length > 999) throw new Refusal('DESIGN_FINDING_LIMIT');
  const coverageRows = screenRows(routes, captured.records);
  const mapMarkdown = [
    '# Mapa',
    '',
    `URL de homologação: ${target.origin}`,
    'Ativação: personal. O modo locked não foi alterado.',
    '',
    screenCoverageMarkdown(coverageRows),
  ].join('\n');
  const raw = designRawDocument(target.origin, findings);
  const note = [input.note, ...notes].filter(part => part && part.trim().length > 0).join(' ').replace(/\s+/g, ' ').trim().slice(0, 500)
    || 'Verificação de design somente leitura concluída.';
  const referenceMarkdown = referenceSection(reference?.note, staged.references);
  const extras = reportExtras(
    input,
    image,
    imageRows,
    tokens,
    examined,
    referenceMarkdown,
    regression.markdown,
    stateNotes,
    hasProjectConfig,
  );
  const split = measuredJudgedMarkdown(achados);
  if (split.length > 0) extras.sections = [...(extras.sections ?? []), {title: 'Medido e julgado', markdown: split}];
  assertPasswordAbsent(input.login?.password, {
    mapMarkdown,
    raw,
    note,
    achados,
    sections: extras.sections,
    files: extras.files,
    coverage: examined.coverage,
    modelCoverage: examined.modelCoverage,
  });
  const written = await writeDesignReport({
    dataDirectory: input.dataDirectory,
    projectId: input.projectId,
    runId: input.runId,
    createdAt: input.createdAt,
    commit: input.commit,
    mapMarkdown,
    coverage: examined.coverage,
    modelCoverage: examined.modelCoverage,
    achados,
    raw,
    note,
    captures: captured.files,
    emptyStates: captured.emptyStates,
    ...extras,
  });
  const read = await readDesignReport(input.dataDirectory, input.projectId, input.runId);
  const visualRequested = examined.modelCoverage.examiner.requested;
  const visualMissing = examined.visualMissing.map(item => `${item.route.replace(/\s+/g, ' ').trim()} (${item.file})`);
  const visualIncomplete = input.scoreVisual === true && (
    visualRequested === 0
    || examined.modelCoverage.reviewer.requested === 0
    || examined.modelCoverage.examiner.judged < visualRequested
    || examined.modelCoverage.reviewer.judged < examined.modelCoverage.reviewer.requested
    || examined.visual.length < visualRequested
  );
  return {
    findings,
    achados: read.achados,
    directory: written.directory,
    directoryName: written.directoryName,
    coverageMarkdown: read.coverageMarkdown,
    visualLow: examined.visual.some(row => row.examiner.some(score => score.score < 8)),
    loginStale: examined.loginStale,
    visualUnjudged: visualIncomplete,
    ...(input.scoreVisual === true
      ? {visualRequested, visualJudged: examined.visual.length, visualMissing}
      : {}),
  };
}

function toAchado(
  index: number,
  finding: DesignExamFinding,
  confirm: DesignConfirmResult,
  verifier: {model: string; provider: string} | null,
): DesignAchadoValue {
  const proof = [confirm.proof, confirm.reason]
    .filter((part, at, all) => part.length > 0 && all.indexOf(part) === at)
    .join('\n')
    .slice(0, 2000);
  const sources = verifier === null
    ? ['medida', finding.reference]
    : ['examinador', finding.reference, verifier.provider, ...(finding.measure ? ['medida'] : [])];
  return DesignAchado.parse({
    id: `ACH-${String(index).padStart(3, '0')}`,
    title: finding.title.slice(0, 200),
    severity: finding.severity,
    status: confirm.status,
    verifier,
    reference: finding.reference.slice(0, 200),
    where: {file: finding.file.slice(0, 400), line: finding.line},
    scenario: finding.scenario.slice(0, 2000),
    proof,
    suggestion: finding.suggestion.slice(0, 2000),
    acceptance: DESIGN_ACCEPTANCE,
    sources: sources.filter(part => part.length > 0).slice(0, 20),
    secretPreview: null,
  });
}

function assembleAchados(
  rawFindings: readonly DesignRawFinding[],
  confirmations: readonly {
    finding: DesignExamFinding;
    confirm: DesignConfirmResult;
    measurementFingerprint?: string;
    verifier: {model: string; provider: string} | null;
  }[],
): DesignAchadoValue[] {
  const achados: DesignAchadoValue[] = [];
  const covered = new Set<string>();
  for (const item of confirmations) {
    achados.push(toAchado(achados.length + 1, item.finding, item.confirm, item.verifier));
    if (item.measurementFingerprint) covered.add(item.measurementFingerprint);
  }
  for (const raw of rawFindings) {
    const routeDown = raw.tool === 'navegacao' && raw.rule === 'DESIGN-ROTA-INDISPONIVEL';
    if (raw.measure === undefined && !routeDown) continue;
    if (covered.has(raw.fingerprint)) continue;
    achados.push(raw.measure === undefined ? routeDownAchado(achados.length + 1, raw) : measuredRawAchado(achados.length + 1, raw));
  }
  return achados;
}

function measuredRawAchado(index: number, finding: DesignRawFinding): DesignAchadoValue {
  const measure = finding.measure;
  if (measure === undefined) throw new Refusal('DESIGN_MODULE_INVALID', 400);
  const detail = measure.kind === 'contrast' ? `razão ${measure.ratio}`
    : measure.kind === 'empty' ? `captura ${measure.capture}`
      : measure.kind === 'lighthouse' ? `${measure.metric} ${measure.value}`
        : measure.kind === 'wallace' ? `${measure.metric} ${measure.value}`
          : `${measure.kind} ${measure.px}px`;
  return DesignAchado.parse({
    id: `ACH-${String(index).padStart(3, '0')}`,
    title: finding.rule.slice(0, 200),
    severity: finding.severity,
    status: 'confirmado',
    verifier: null,
    reference: finding.rule.slice(0, 200),
    where: {file: finding.file.slice(0, 400), line: finding.line},
    scenario: `Medido por ${finding.tool}. ${finding.snippet}`.slice(0, 2000),
    proof: `Medido: ${detail}. ${finding.snippet}`.replace(/\s+/g, ' ').trim().slice(0, 2000),
    suggestion: 'A medida confirma o achado. A correção precisa mudar o valor medido.',
    acceptance: DESIGN_ACCEPTANCE,
    sources: ['medida', finding.tool],
    secretPreview: null,
  });
}

function routeDownAchado(index: number, finding: DesignRawFinding): DesignAchadoValue {
  return DesignAchado.parse({
    id: `ACH-${String(index).padStart(3, '0')}`,
    title: finding.rule.slice(0, 200),
    severity: finding.severity,
    status: 'confirmado',
    verifier: null,
    reference: finding.rule.slice(0, 200),
    where: {file: finding.file.slice(0, 400), line: finding.line},
    scenario: `Medido pela navegação. ${finding.snippet}`.slice(0, 2000),
    proof: finding.snippet.slice(0, 2000),
    suggestion: 'A rota precisa responder abaixo de 400 antes de entrar no exame.',
    acceptance: DESIGN_ACCEPTANCE,
    sources: ['medida', finding.tool],
    secretPreview: null,
  });
}

function referenceSection(note: string | undefined, references: readonly {name: string}[]): string | undefined {
  const lines: string[] = [];
  if (note !== undefined && note.trim().length > 0) lines.push(note.trim());
  if (references.length > 0) lines.push(`Imagens enviadas ao exame, ao lado da captura: ${references.map(item => item.name).join(', ')}.`);
  return lines.length === 0 ? undefined : lines.join('\n');
}

function measuredJudgedMarkdown(achados: readonly DesignAchadoValue[]): string {
  if (achados.length === 0) return '';
  const measured = achados.filter(item => item.verifier === null && item.sources.includes('medida'));
  const judged = achados.filter(item => item.verifier !== null);
  const line = (item: DesignAchadoValue) => `- ${item.id} ${item.reference} (${item.status})`;
  return [
    `Medidos: ${measured.length}. A medida confirma, sem modelo.`,
    ...measured.map(line),
    '',
    `Julgados: ${judged.length}. O revisor confirmou.`,
    ...judged.map(line),
  ].join('\n');
}

/** Liga cada rota servida ao HTML de mesmo caminho. `/` usa `index.html`. */
export function screenRoutesForExam(
  files: readonly {path: string; text: string}[],
  served?: readonly {route: string}[],
): DiscoveredRoute[] {
  const discovered = discoverRoutesFromSource(files);
  if (served === undefined || served.length === 0) return discovered;
  const usedRoutes = new Set(discovered.map(item => item.route));
  const usedIds = new Set(discovered.map(item => item.id));
  const extra: DiscoveredRoute[] = [];
  for (const item of served) {
    if (usedRoutes.has(item.route) || item.route.length < 1 || item.route.length > 200) continue;
    const relative = item.route === '/' ? 'index.html' : item.route.replace(/^\//, '');
    const file = files.find(candidate => candidate.path === relative || candidate.path.endsWith(`/${relative}`));
    if (file === undefined) continue;
    let id = `servido-${relative.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'raiz'}`;
    while (usedIds.has(id)) id = `${id}-2`;
    usedIds.add(id);
    usedRoutes.add(item.route);
    extra.push({id, route: item.route, file: file.path, line: 1, title: item.route, source: 'codigo'});
  }
  return extra.length === 0 ? discovered : [...discovered, ...extra];
}

function chooseScreens(
  files: readonly DesignSourceFile[],
  routes: readonly {file: string; route: string}[],
  findings: readonly DesignRawFinding[],
): {screens: DesignExamineInput['screens']; omitted: number} {
  const routeOf = new Map<string, string>();
  for (const route of routes) {
    const key = route.file.slice(0, 400);
    if (!routeOf.has(key)) routeOf.set(key, route.route);
  }
  const hot = new Set(findings.filter(item => item.severity === 'alta' || item.severity === 'media').map(item => item.file));
  const candidates = files.filter(file => /\.(?:html?|tsx|jsx|vue|css)$/i.test(file.path));
  const ranked = [...candidates].sort((left, right) => {
    const score = (file: DesignSourceFile) => {
      const key = file.path.slice(0, 400);
      return (hot.has(key) ? 2 : 0) + (routeOf.has(key) ? 1 : 0);
    };
    return score(right) - score(left) || left.path.localeCompare(right.path);
  });
  const picked = ranked.slice(0, MAX_SCREENS);
  return {
    omitted: ranked.length - picked.length,
    screens: picked.map(file => {
      const key = file.path.slice(0, 400);
      return {
        file: key,
        route: routeOf.get(key) ?? '/',
        code: file.text,
        captureNote: 'sem captura',
      };
    }),
  };
}

function screenRows(
  routes: readonly {id: string; route: string; file: string}[],
  records: readonly {route: string}[],
): ScreenCoverageRow[] {
  return routes.map(route => {
    const captures = records.filter(record => record.route === route.route).length;
    return {
      screenId: route.id,
      route: route.route,
      file: route.file,
      fromCode: true,
      fromNavigation: captures > 0,
      captures,
    };
  });
}

function textFor(files: readonly {path: string; text: string}[], file: string | undefined): string {
  if (file === undefined) return '';
  return files.find(item => item.path === file)?.text ?? '';
}

function captureNoteFor(route: string, records: readonly {route: string; viewport: number; theme: string; fileName: string}[]): string {
  const related = records.filter(record => record.route === route);
  if (related.length === 0) return 'sem captura';
  return related.map(record => `${record.fileName} ${record.viewport}px ${record.theme}`).join('; ').slice(0, 500);
}

type HeldCapture = {
  route: string;
  viewport: number;
  theme: 'claro' | 'escuro';
  state: string;
  fileName: string;
  bytes: Buffer;
};

async function captureIfAsked(
  input: DesignModuleInput,
  origin: string,
  routes: readonly {id: string; route: string; file?: string}[],
  notes: string[],
): Promise<{records: {route: string; viewport: number; theme: string; fileName: string}[]; files: DesignReportCapture[]; held: HeldCapture[]; emptyStates: DesignEmptyStateRecord[]}> {
  if (input.driver === undefined) return {records: [], files: [], held: [], emptyStates: []};
  const selected = (routes.length > 0 ? routes : [{id: 'inicio', route: '/'}]).slice(0, MAX_CAPTURE_ROUTES);
  const directory = await mkdtemp(join(tmpdir(), 'design-cap-'));
  try {
    const metadata = await captureScreens(
      input.driver,
      origin,
      planCaptures(selected.map(route => ({
        id: route.id,
        route: route.route,
        hasDarkTheme: input.captureDarkTheme === true,
        forceStates: input.forceStates === true,
        hasEmptyState: sourceHasEmptyState(textFor(input.files, route.file)),
      }))),
      directory,
      input.login === undefined ? undefined : {login: input.login},
    );
    const marks = new Map((input.marks ?? []).map(mark => [mark.fileName, mark.rect]));
    const files: DesignReportCapture[] = [];
    for (const record of metadata.captures) {
      const bytes = await readFile(join(directory, record.fileName));
      const rect = marks.get(record.fileName);
      files.push({fileName: record.fileName, bytes: rect === undefined ? bytes : markPngRect(bytes, rect)});
    }
    const held: HeldCapture[] = [];
    for (let index = 0; index < metadata.captures.length; index += 1) {
      const record = metadata.captures[index];
      const file = files[index];
      if (!record || !file || file.fileName !== record.fileName) continue;
      if (record.theme !== 'claro' && record.theme !== 'escuro') continue;
      held.push({
        route: record.route,
        viewport: record.viewport,
        theme: record.theme,
        state: record.state,
        fileName: record.fileName,
        bytes: file.bytes,
      });
    }
    return {
      records: metadata.captures.map(record => ({
        route: record.route,
        viewport: record.viewport,
        theme: record.theme,
        fileName: record.fileName,
      })),
      files,
      held,
      emptyStates: metadata.emptyStates,
    };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    const message = error instanceof Error ? error.message : 'erro';
    notes.push(`A captura não rodou: ${message}`.slice(0, 200));
    return {records: [], files: [], held: [], emptyStates: []};
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

/**
 * Writes PNGs under `<dataDirectory>/design-captures/<runId>/` and deletes that run after the exam.
 * Publish the directory only while `worker.run` is in flight so the supervisor copies that run.
 */
async function stageDesignCaptures(
  dataDirectory: string,
  runId: string,
  held: readonly HeldCapture[],
  extras: readonly {name: string; bytes: Buffer}[],
): Promise<{
  byRoute: Map<string, DesignScreenCapture[]>;
  references: {path: string; sha256: string; name: string}[];
  publish: () => void;
  conceal: () => void;
  cleanup: () => Promise<void>;
}> {
  return writeDesignExamCaptures(dataDirectory, runId, held, extras);
}

function referencesDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../deploy/design-references'),
    join(here, '../../deploy/design-references'),
    join(process.cwd(), 'deploy/design-references'),
  ];
  return candidates.find(path => existsSync(path)) ?? candidates[0] ?? 'deploy/design-references';
}

function routeFileMap(files: readonly DesignSourceFile[], config: DesignProjectConfig): Map<string, string> {
  const discovered = discoverRoutesFromSource(files);
  const map = new Map<string, string>();
  for (const route of discovered) {
    if (!map.has(route.route)) map.set(route.route, route.file);
  }
  for (const [route, item] of Object.entries(config.routes)) {
    if (item.example === undefined || map.has(item.example)) continue;
    const owner = discovered.find(found => found.route === route)?.file
      ?? files.find(file => file.text.includes(route))?.path;
    if (owner) map.set(item.example, owner);
  }
  return map;
}

/** Achado da imagem vem com a rota no arquivo. O exame só lê o achado cujo arquivo é o da tela. */
function attributeDesignFindings(
  findings: DesignRawFinding[],
  files: readonly DesignSourceFile[],
  routes: ReadonlyMap<string, string>,
): DesignRawFinding[] {
  const known = new Set(files.map(file => file.path));
  const css = files.filter(file => file.path.endsWith('.css')).map(file => file.path);
  return findings.map(finding => {
    if (known.has(finding.file)) return finding;
    const head = finding.file.split(' ')[0] ?? '';
    const fromRepo = head.startsWith('/repository/') ? head.slice('/repository/'.length) : '';
    const next = known.has(fromRepo) ? fromRepo : routes.get(head);
    if (next) return {...finding, file: next};
    if (finding.tool === 'stylelint' && (finding.file === 'repository' || finding.file.startsWith('repository')) && css.length === 1) {
      const only = css[0];
      if (only) return {...finding, file: only};
    }
    return finding;
  });
}

function filesDark(files: readonly {text: string}[]): boolean {
  return files.some(file => /prefers-color-scheme\s*:\s*dark|data-theme|color-scheme\s*:/i.test(file.text));
}

const DESIGN_CONFIG_FILE = 'design.config.json';
const MAX_DESIGN_CONFIG_BYTES = 200_000;

/**
 * O leitor do repositório não inclui JSON, para a palavra "routes" não virar rota.
 * O config vale só na raiz, sem seguir symlink. O texto já presente em `files` ganha.
 */
async function readRepoDesignConfig(repo: string, files: readonly DesignSourceFile[]): Promise<string | undefined> {
  const fromFiles = files.find(file => file.path === DESIGN_CONFIG_FILE || file.path.endsWith(`/${DESIGN_CONFIG_FILE}`))?.text;
  if (fromFiles !== undefined) return fromFiles;
  const handle = await open(join(repo, DESIGN_CONFIG_FILE), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    if (info.size > MAX_DESIGN_CONFIG_BYTES) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
    const bytes = await handle.readFile();
    if (bytes.length > MAX_DESIGN_CONFIG_BYTES || bytes.includes(0)) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
    return bytes.toString('utf8');
  } finally {
    await handle.close();
  }
}

function imageStates(route: {states: readonly {name: string; url?: string; acoes?: readonly string[]}[]; loginState: boolean}): unknown[] {
  const states: unknown[] = route.states.map(state => ({...state}));
  if (route.loginState && !route.states.some(state => state.name === 'logado')) states.push({name: 'logado'});
  return states;
}

function statePlan(files: readonly DesignSourceFile[], config: DesignProjectConfig) {
  return planDesignRoutes({
    discovered: discoverRoutesFromSource(files),
    dynamicSkipped: dynamicRoutesMissingExample(files),
    config,
    darkInSource: filesDark(files),
  });
}

function withoutHeading(markdown: string): string {
  return markdown.replace(/^## [^\n]+\n+/, '');
}

function visualSectionMarkdown(
  scoreVisual: boolean | undefined,
  visual: Parameters<typeof visualReportMarkdown>[0],
  requested: number,
  missing: readonly {file: string; route: string}[],
): string | undefined {
  if (scoreVisual !== true && visual.length === 0) return undefined;
  const parts: string[] = [];
  if (visual.length > 0) {
    parts.push(withoutHeading(visualReportMarkdown(visual)).trimEnd());
  } else if (scoreVisual === true && requested === 0) {
    parts.push('A crítica visual foi pedida, mas nenhuma tela entrou no exame.');
  } else {
    parts.push('Nenhuma tela recebeu nota visual.');
  }
  if (missing.length > 0) {
    parts.push(
      '',
      'Telas sem crítica visual completa:',
      ...missing.map(item => `- ${item.route.replace(/\s+/g, ' ').trim()} (${item.file})`),
    );
  }
  return parts.join('\n');
}

function reportExtras(
  input: DesignModuleInput,
  image: DesignImageExecution | undefined,
  imageRows: ReturnType<typeof applyHostFindingCounts>,
  tokens: ReturnType<typeof analyzeDesignTokens> | undefined,
  examined: Pick<Awaited<ReturnType<typeof examineDesignScreens>>, 'visual' | 'visualMissing' | 'modelCoverage'>,
  referenceNote: string | undefined,
  regression: string,
  stateNotes: readonly string[] | undefined,
  hasProjectConfig: boolean,
): {sections?: {title: string; markdown: string}[]; files?: {name: string; body: string}[]} {
  const sections: {title: string; markdown: string}[] = [];
  const files: {name: string; body: string}[] = [];
  if (image) {
    sections.push(
      {title: 'Cobertura das ferramentas', markdown: toolCoverageTable(imageRows)},
      {title: 'Execução da imagem', markdown: `Esta rodada executou o contêiner \`${input.image?.pinnedImage ?? ''}\`. Código ${image.code}.`},
    );
    files.push({name: 'cobertura-ferramentas.md', body: toolCoverageMarkdown(imageRows)});
    if (image.document !== null) files.push({name: 'imagem-achados-brutos.json', body: JSON.stringify(image.document)});
  }
  if (tokens) {
    sections.push({title: 'Tokens', markdown: withoutHeading(tokenReportMarkdown(tokens))});
    files.push({name: 'tokens.json', body: JSON.stringify(tokens.document, null, 2)});
  }
  const visualMarkdown = visualSectionMarkdown(
    input.scoreVisual,
    examined.visual as Parameters<typeof visualReportMarkdown>[0],
    examined.modelCoverage.examiner.requested,
    examined.visualMissing,
  );
  if (visualMarkdown !== undefined) sections.push({title: 'Crítica visual', markdown: visualMarkdown});
  if (referenceNote) sections.push({title: 'Referências', markdown: referenceNote});
  if (regression.trim().length > 0) sections.push({title: 'Regressão visual', markdown: withoutHeading(regression)});
  if (hasProjectConfig || (stateNotes && stateNotes.length > 0)) {
    const configSourceNote = hasProjectConfig
      ? 'A configuração de estados (design.config.json) vem do repositório do próprio titular.'
      : 'Quando presente, a configuração de estados (design.config.json) vem do repositório do próprio titular.';
    sections.push({
      title: 'Estados',
      markdown: [configSourceNote, ...(stateNotes ?? [])].join('\n'),
    });
  }
  return {
    ...(sections.length > 0 ? {sections} : {}),
    ...(files.length > 0 ? {files} : {}),
  };
}

async function regressionSection(
  input: DesignModuleInput,
  files: readonly {fileName: string; bytes: Buffer}[],
): Promise<{markdown: string; diffs: {fileName: string; bytes: Buffer}[]}> {
  if (input.regressionThreshold === undefined) return {markdown: '', diffs: []};
  const pairs = [];
  for (const file of files) {
    if (file.fileName.startsWith('diff-')) continue;
    pairs.push({
      fileName: file.fileName,
      baseline: await baselineBuffer(input.dataDirectory, input.projectId, file.fileName),
      current: file.bytes,
    });
  }
  const hits = regressionHits({pairs, threshold: input.regressionThreshold});
  const diffs: {fileName: string; bytes: Buffer}[] = [];
  for (const hit of hits) {
    const diff = (hit as {diff?: Buffer}).diff;
    if (hit.diffFileName && diff) diffs.push({fileName: hit.diffFileName, bytes: diff});
  }
  return {markdown: regressionMarkdown(hits), diffs};
}

function assertPasswordAbsent(password: string | undefined, value: unknown): void {
  if (password === undefined || password.length === 0) return;
  if (JSON.stringify(value).includes(password)) throw new Refusal('DESIGN_PASSWORD_LEAK');
}

function mergeTools(left: DesignToolReports | undefined, right: DesignToolReports | undefined): DesignToolReports | undefined {
  if (left === undefined && right === undefined) return undefined;
  const axe = [...(left?.axe ?? []), ...(right?.axe ?? [])];
  const pa11y = [...(left?.pa11y ?? []), ...(right?.pa11y ?? [])];
  const lighthouse = [...(left?.lighthouse ?? []), ...(right?.lighthouse ?? [])];
  const stylelint = [...(left?.stylelint ?? []), ...(right?.stylelint ?? [])];
  const cssAnalyzer = [...(left?.cssAnalyzer ?? []), ...(right?.cssAnalyzer ?? [])];
  const keyboard = [...(left?.keyboard ?? []), ...(right?.keyboard ?? [])];
  return {
    ...(axe.length > 0 ? {axe} : {}),
    ...(pa11y.length > 0 ? {pa11y} : {}),
    ...(lighthouse.length > 0 ? {lighthouse} : {}),
    ...(stylelint.length > 0 ? {stylelint} : {}),
    ...(cssAnalyzer.length > 0 ? {cssAnalyzer} : {}),
    ...(keyboard.length > 0 ? {keyboard} : {}),
  };
}

async function writeImageFailure(input: DesignModuleInput, origin: string, image: DesignImageExecution): Promise<void> {
  await writeDesignReport({
    dataDirectory: input.dataDirectory,
    projectId: input.projectId,
    runId: input.runId,
    createdAt: input.createdAt,
    commit: input.commit,
    mapMarkdown: `# Mapa\n\nURL de homologação: ${origin}\nA imagem não produziu achados.\n`,
    coverage: [],
    achados: [],
    raw: designRawDocument(origin, []),
    note: `A imagem falhou com ${image.code}.`.slice(0, 500),
    sections: [
      {title: 'Cobertura das ferramentas', markdown: toolCoverageTable(image.coverage)},
      {title: 'Execução da imagem', markdown: `O contêiner não entregou achados. Código ${image.code}.`},
    ],
    files: [{name: 'cobertura-ferramentas.md', body: toolCoverageMarkdown(image.coverage)}],
  });
}
