import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Refusal} from './contracts.ts';
import type {DesignToolReports} from './design-collect.ts';
import {DESIGN_USER, designRunArguments, requirePinnedDesignImage} from './design-image.ts';
import {stylelintConfig} from './design-stylelint.ts';
import {designRawFinding, type DesignRawFinding} from './design-types.ts';

export type DesignComputedSample = {
  selector?: string;
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  margin?: string;
  padding?: string;
  gap?: string;
  borderRadius?: string;
  boxShadow?: string;
  transitionDuration?: string;
  width?: string;
  height?: string;
};

const REQUIRED_TOOLS = ['axe-core', 'pa11y', 'lighthouse', 'stylelint', 'css-analyzer'] as const;
const VIEWPORTS = [375, 768, 1440] as const;
const SHA = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_UID = Number(DESIGN_USER.split(':')[0]);

export type ToolCoverageRow = {
  tool: string;
  version: string;
  executed: string;
  findings: string;
  failure: string;
};

export type DesignImageSpawn = (argv: readonly string[], output: string) => Promise<{code: number | null; stderr: string}>;

export type DesignImageShot = {
  fileName: string;
  route: string;
  viewport: number;
  theme: string;
  state: string;
  bytes: Buffer;
};

export type DesignImageExecution = {
  ok: boolean;
  code: string;
  tools: DesignToolReports;
  coverage: ToolCoverageRow[];
  computed: DesignComputedSample[];
  shots: DesignImageShot[];
  notes: string[];
  document: unknown;
  declaredFindings: DesignRawFinding[];
};

function text(value: unknown, fallback: string, max = 240): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return (raw.length > 0 ? raw : fallback).replace(/\s+/g, ' ').slice(0, max);
}

/** Nenhuma célula da tabela fica vazia. Achado numérico vira texto. */
export function coverageRow(value: unknown): ToolCoverageRow {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const count = typeof row.findings === 'number' && Number.isFinite(row.findings)
    ? String(Math.max(0, Math.trunc(row.findings)))
    : text(row.findings, '0', 40);
  return {
    tool: text(row.tool, 'desconhecida', 80),
    version: text(row.version, 'desconhecida', 80),
    executed: text(row.executed, '0', 240),
    findings: count.length > 0 ? count : '0',
    failure: text(row.failure, 'nenhuma', 400),
  };
}

export function failedToolCoverage(code: string): ToolCoverageRow[] {
  const failure = text(code, 'DESIGN_IMAGE_FAILED', 400);
  return REQUIRED_TOOLS.map(tool => coverageRow({tool, version: 'desconhecida', executed: '0', findings: '0', failure}));
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '/').replace(/\s+/g, ' ');
}

export function toolCoverageTable(rows: readonly ToolCoverageRow[]): string {
  const body = rows.length > 0 ? rows : failedToolCoverage('DESIGN_IMAGE_NOT_RUN');
  return [
    '| Ferramenta | Versão | Executado | Achados | Falha |',
    '|---|---|---|---|---|',
    ...body.map(row => `| ${tableCell(row.tool)} | ${tableCell(row.version)} | ${tableCell(row.executed)} | ${tableCell(row.findings)} | ${tableCell(row.failure)} |`),
    '',
  ].join('\n');
}

export function toolCoverageMarkdown(rows: readonly ToolCoverageRow[]): string {
  return `## Cobertura das ferramentas\n\n${toolCoverageTable(rows)}`;
}

export function applyHostFindingCounts(rows: readonly ToolCoverageRow[], findings: readonly {tool: string}[]): ToolCoverageRow[] {
  const alias: Record<string, string> = {axe: 'axe-core', pa11y: 'pa11y', lighthouse: 'lighthouse', stylelint: 'stylelint'};
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const tool = alias[finding.tool] ?? finding.tool;
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return rows.map(row => counts.has(row.tool) ? {...row, findings: String(counts.get(row.tool))} : row);
}

function listOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item));
}

/** Converte o JSON da imagem nos relatórios que os conversores do host já conhecem. */
export function interpretDesignImageDocument(document: unknown): Omit<DesignImageExecution, 'ok' | 'code' | 'shots'> & {shotMeta: {fileName: string; route: string; viewport: number; theme: string; state: string}[]} {
  const root = document && typeof document === 'object' ? document as Record<string, unknown> : {};
  const reports = root.reports && typeof root.reports === 'object' ? root.reports as Record<string, unknown> : {};
  const tools: DesignToolReports = {
    axe: listOf(reports.axe).map(item => ({file: text(item.file, 'pagina', 400), json: item.json})),
    pa11y: listOf(reports.pa11y).map(item => ({file: text(item.file, 'pagina', 400), json: item.json})),
    lighthouse: listOf(reports.lighthouse).map(item => ({file: text(item.file, 'pagina', 400), lhr: item.lhr})),
    stylelint: listOf(reports.stylelint).map(item => ({file: text(item.file, 'pagina', 400), report: item.report})),
    cssAnalyzer: listOf(reports.cssAnalyzer).map(item => ({file: text(item.file, 'pagina', 400), report: item.report})),
  };
  const present = new Set(listOf(root.coverage).map(item => text(item.tool, '', 80)));
  const coverage = listOf(root.coverage).map(item => coverageRow(item));
  for (const tool of REQUIRED_TOOLS) {
    if (!present.has(tool)) coverage.push(coverageRow({tool, version: 'desconhecida', executed: '0', findings: '0', failure: 'DESIGN_TOOL_MISSING'}));
  }
  const computed: DesignComputedSample[] = [];
  for (const block of listOf(root.computed)) {
    for (const sample of listOf(block.samples)) {
      if (computed.length >= 2000) break;
      computed.push(sample as DesignComputedSample);
    }
  }
  const notes = Array.isArray(root.notes) ? root.notes.filter((item): item is string => typeof item === 'string').map(item => item.slice(0, 300)) : [];
  const declared = routeFindings(root, notes);
  const shotMeta = listOf(root.screenshots).flatMap(item => {
    const fileName = text(item.fileName, '', 160);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,140}\.png$/.test(fileName)) return [];
    const viewport = item.viewport === 375 || item.viewport === 768 || item.viewport === 1440 ? item.viewport : 0;
    if (viewport === 0) return [];
    return [{
      fileName,
      route: text(item.route, '/', 200),
      viewport,
      theme: item.theme === 'escuro' ? 'escuro' : 'claro',
      state: text(item.state, 'padrao', 40),
    }];
  });
  return {tools, coverage, computed, notes, document, shotMeta, declaredFindings: declared};
}

/** HTTP ≥ 400 vira achado de navegação. A folha do css-analyzer segue em tools.cssAnalyzer. */
function routeFindings(root: Record<string, unknown>, notes: string[]): DesignRawFinding[] {
  const found: DesignRawFinding[] = [];
  const seen = new Set<string>();
  const push = (file: string, snippet: string) => {
    const key = `${file}\u0000${snippet}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(designRawFinding({
      tool: 'navegacao',
      rule: 'DESIGN-ROTA-INDISPONIVEL',
      file,
      severity: 'media',
      snippet,
    }));
  };
  for (const item of listOf(root.findings)) {
    const rule = text(item.rule, '', 80);
    const tool = text(item.tool, '', 40);
    if (tool !== 'navegacao' && rule !== 'DESIGN-ROTA-INDISPONIVEL') continue;
    const status = typeof item.status === 'number' && Number.isFinite(item.status) ? String(Math.trunc(item.status)) : '';
    const snippet = text(item.snippet, status.length > 0 ? `rota indisponível (${status})` : 'rota indisponível', 240);
    push(text(item.file, text(item.route, '/', 200), 400), snippet);
  }
  for (const item of listOf(root.unavailable)) {
    const status = typeof item.status === 'number' && Number.isFinite(item.status) ? String(Math.trunc(item.status)) : text(item.status, 'erro', 40);
    const route = text(item.route, '/', 200);
    const snippet = `rota indisponível (${status})`.slice(0, 240);
    push(route, snippet);
    const line = `${route}: ${snippet}`;
    if (!notes.some(note => note.includes(snippet) && note.includes(route))) notes.push(line.slice(0, 300));
  }
  return found;
}

export function designExamPlan(routes: readonly {route: string}[], dark: boolean): {
  routes: {route: string; themes: Array<'claro' | 'escuro'>; states: ['padrao']}[];
  viewports: number[];
  stylelint: Record<string, unknown>;
} {
  const seen = new Set<string>();
  const planned: {route: string; themes: Array<'claro' | 'escuro'>; states: ['padrao']}[] = [];
  const source = routes.length > 0 ? routes : [{route: '/'}];
  for (const route of source) {
    if (!route.route.startsWith('/') || seen.has(route.route)) continue;
    seen.add(route.route);
    planned.push({
      route: route.route,
      themes: dark ? ['claro', 'escuro'] : ['claro'],
      states: ['padrao'],
    });
    if (planned.length >= 40) break;
  }
  if (planned.length === 0) planned.push({route: '/', themes: dark ? ['claro', 'escuro'] : ['claro'], states: ['padrao']});
  return {routes: planned, viewports: [...VIEWPORTS], stylelint: stylelintConfig()};
}

export function readRebuildImagePin(text: string): string {
  const line = text.trim().split(/\s+/u)[0] ?? '';
  if (SHA.test(line)) return requirePinnedDesignImage(`ac-design:reconstrucao@${line}`);
  return requirePinnedDesignImage(line);
}

async function defaultSpawn(argv: readonly string[], timeoutMs: number): Promise<{code: number | null; stderr: string}> {
  return new Promise(resolve => {
    const child = spawn(argv[0] ?? 'docker', argv.slice(1), {stdio: ['ignore', 'ignore', 'pipe']});
    const chunks: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      if (chunks.reduce((sum, item) => sum + item.length, 0) < 8000) chunks.push(chunk);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({code: 1, stderr: error.message});
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({code, stderr: Buffer.concat(chunks).toString('utf8').slice(0, 800)});
    });
  });
}

/**
 * Sobe a imagem com designRunArguments. O plano vai em pedido.json, fora do argv,
 * para os testes do contrato do contêiner continuarem iguais.
 * O diretório fica 0o1777 (sticky) só durante a escrita do contêiner: o processo
 * interno é o uid 65532 e o host não é esse uid. O finally apaga o diretório.
 */
export async function executeDesignImage(input: {
  image: string;
  repository: string;
  targetUrl: string;
  plan: unknown;
  timeoutMs?: number;
  run?: DesignImageSpawn;
  loginState?: string;
}): Promise<DesignImageExecution> {
  const output = await mkdtemp(join(tmpdir(), 'design-img-'));
  try {
    // 0o1777 só enquanto o uid 65532 escreve; o host não é esse uid.
    await chmod(output, 0o1777);
    const captures = join(output, 'capturas');
    await mkdir(captures, {mode: 0o1777});
    await chmod(captures, 0o1777);
    await writeFile(join(output, 'pedido.json'), `${JSON.stringify(input.plan)}\n`, {mode: 0o644});
    let argv: readonly string[];
    try {
      argv = designRunArguments({
        image: input.image,
        repository: input.repository,
        output,
        targetUrl: input.targetUrl,
        memoryBytes: 2147483648,
        nanoCpus: 2_000_000_000,
        pidsLimit: 512,
        ...(input.loginState === undefined ? {} : {loginState: input.loginState}),
      });
    } catch (error) {
      const code = error instanceof Refusal ? error.code : 'DESIGN_IMAGE_FAILED';
      return {ok: false, code, ...emptyExecution(code), shots: []};
    }
    const timeoutMs = input.timeoutMs ?? 1_200_000;
    let spawned: {code: number | null; stderr: string};
    try {
      spawned = input.run ? await input.run(argv, output) : await defaultSpawn(argv, timeoutMs);
    } catch (error) {
      const code = 'DESIGN_IMAGE_FAILED';
      return {
        ok: false,
        code,
        ...emptyExecution(code),
        notes: [error instanceof Error ? error.message.slice(0, 180) : 'falha'],
        shots: [],
      };
    }
    const parsed = await readContainerJson(join(output, 'achados-brutos.json'));
    if (parsed === undefined) {
      const code = spawned.code === null ? 'DESIGN_IMAGE_TIMEOUT' : 'DESIGN_IMAGE_FAILED';
      const note = spawned.stderr.trim().slice(0, 180);
      return {
        ok: false,
        code,
        ...emptyExecution(code),
        notes: note.length > 0 ? [note] : [],
        shots: [],
      };
    }
    if (spawned.code === 0 && !reportsObject(parsed)) {
      return {ok: false, code: 'DESIGN_IMAGE_FAILED', ...emptyExecution('DESIGN_IMAGE_FAILED'), shots: []};
    }
    const interpreted = interpretDesignImageDocument(parsed);
    const shots: DesignImageShot[] = [];
    const names = new Set(await readdir(captures).catch(() => [] as string[]));
    for (const meta of interpreted.shotMeta) {
      if (!names.has(meta.fileName)) continue;
      const bytes = await readFile(join(captures, meta.fileName));
      shots.push({...meta, bytes});
    }
    const containerFailed = spawned.code !== 0 && spawned.code !== null;
    const notes = containerFailed
      ? [...interpreted.notes, `O contêiner saiu com código ${spawned.code}.`.slice(0, 300)]
      : interpreted.notes;
    return {
      ok: true,
      code: spawned.code === 0 ? 'nenhuma' : 'DESIGN_IMAGE_FAILED',
      tools: interpreted.tools,
      coverage: interpreted.coverage,
      computed: interpreted.computed,
      notes,
      document: interpreted.document,
      declaredFindings: interpreted.declaredFindings,
      shots,
    };
  } finally {
    await rm(output, {recursive: true, force: true});
  }
}

function reportsObject(document: unknown): boolean {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
  const reports = (document as Record<string, unknown>).reports;
  return reports !== null && typeof reports === 'object' && !Array.isArray(reports);
}

/** lstat antes do parse. Symlink, outro uid ou modo de grupo/outros gravável não é lido. */
async function readContainerJson(path: string): Promise<unknown | undefined> {
  let listed;
  try {
    listed = await lstat(path);
  } catch {
    return undefined;
  }
  if (listed.isSymbolicLink() || !listed.isFile() || listed.uid !== CONTAINER_UID || (listed.mode & 0o022) !== 0) return undefined;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== CONTAINER_UID || (info.mode & 0o022) !== 0) return undefined;
    return JSON.parse(await handle.readFile({encoding: 'utf8'})) as unknown;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function emptyExecution(code: string): Omit<DesignImageExecution, 'ok' | 'code' | 'shots'> {
  return {
    tools: {},
    coverage: failedToolCoverage(code),
    computed: [],
    notes: [],
    document: null,
    declaredFindings: [],
  };
}
