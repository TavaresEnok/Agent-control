import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Id, Refusal} from './contracts.ts';
import {captureScreens, planCaptures, type DesignCaptureDriver} from './design-capture.ts';
import {collectDesignFindings, designRawDocument, type DesignSourceFile, type DesignToolReports} from './design-collect.ts';
import {discoverRoutesFromSource, screenCoverageMarkdown, type DesignLogin, type ScreenCoverageRow} from './design-discover.ts';
import {examineDesignScreens, type DesignExamineInput} from './design-examine.ts';
import {assertDesignTarget} from './design-image.ts';
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

type DesignSeat = {
  provider: string;
  model: string;
  accountId: string;
  profileId: string;
  grantId: string;
};

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
};

export type DesignModuleResult = {
  findings: DesignRawFinding[];
  achados: DesignAchadoValue[];
  directory: string;
  directoryName: string;
  coverageMarkdown: string;
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
  const findings = collectDesignFindings(input.files, input.tools);
  const routes = discoverRoutesFromSource(input.files);
  const notes: string[] = [];
  const captured = await captureIfAsked(input, target.origin, routes, notes);
  const chosen = chooseScreens(input.files, routes, findings);
  if (chosen.omitted > 0) notes.push(`O exame cobriu ${chosen.screens.length} de ${chosen.screens.length + chosen.omitted} arquivos de tela.`);
  const screens = chosen.screens.map(screen => ({
    ...screen,
    captureNote: captureNoteFor(screen.route, captured.records),
  }));
  if (screens.length === 0) notes.push('Nenhuma tela de código entrou no exame.');
  const examined = await examineDesignScreens({
    repo: input.repo,
    intentId: input.intentId,
    screens,
    checklist: loadDesignChecklist(),
    rawFindings: findings,
    worker: input.worker,
    reserve: input.reserve,
    release: input.release,
  });
  notes.push(...examined.notes);
  if (examined.confirmations.length > 999) throw new Refusal('DESIGN_FINDING_LIMIT');
  const achados = examined.confirmations.map((item, index) => toAchado(index + 1, item.finding, item.confirm, item.verifier));
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
  assertPasswordAbsent(input.login?.password, {mapMarkdown, raw, note, achados});
  const written = await writeDesignReport({
    dataDirectory: input.dataDirectory,
    projectId: input.projectId,
    runId: input.runId,
    createdAt: input.createdAt,
    commit: input.commit,
    mapMarkdown,
    coverage: examined.coverage,
    achados,
    raw,
    note,
    captures: captured.files,
  });
  const read = await readDesignReport(input.dataDirectory, input.projectId, input.runId);
  return {
    findings,
    achados: read.achados,
    directory: written.directory,
    directoryName: written.directoryName,
    coverageMarkdown: read.coverageMarkdown,
  };
}

function toAchado(
  index: number,
  finding: DesignExamFinding,
  confirm: DesignConfirmResult,
  verifier: {model: string; provider: string},
): DesignAchadoValue {
  const proof = [confirm.proof, confirm.reason]
    .filter((part, at, all) => part.length > 0 && all.indexOf(part) === at)
    .join('\n')
    .slice(0, 2000);
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
    sources: ['examinador', finding.reference, verifier.provider].filter(part => part.length > 0).slice(0, 20),
    secretPreview: null,
  });
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

function captureNoteFor(route: string, records: readonly {route: string; viewport: number; theme: string; fileName: string}[]): string {
  const related = records.filter(record => record.route === route);
  if (related.length === 0) return 'sem captura';
  return related.map(record => `${record.fileName} ${record.viewport}px ${record.theme}`).join('; ').slice(0, 500);
}

async function captureIfAsked(
  input: DesignModuleInput,
  origin: string,
  routes: readonly {id: string; route: string}[],
  notes: string[],
): Promise<{records: {route: string; viewport: number; theme: string; fileName: string}[]; files: DesignReportCapture[]}> {
  if (input.driver === undefined) return {records: [], files: []};
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
    return {
      records: metadata.captures.map(record => ({
        route: record.route,
        viewport: record.viewport,
        theme: record.theme,
        fileName: record.fileName,
      })),
      files,
    };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    const message = error instanceof Error ? error.message : 'erro';
    notes.push(`A captura não rodou: ${message}`.slice(0, 200));
    return {records: [], files: []};
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

function assertPasswordAbsent(password: string | undefined, value: unknown): void {
  if (password === undefined || password.length === 0) return;
  if (JSON.stringify(value).includes(password)) throw new Refusal('DESIGN_PASSWORD_LEAK');
}
