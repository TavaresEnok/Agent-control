import {createHash, randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, mkdir, open, readdir, realpath} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {z} from 'zod';
import {Id, Refusal} from './contracts.ts';
import type {VerificationModule} from './ledger.ts';
import type {ModuleExamResult} from './module-exam.ts';
import {moduleCollectorHypothesis, moduleReviewTask} from './module-exam-proof.ts';
import {hasKnownSecret} from './verify-redact.ts';
import {Achado, CoverageRow} from './verify-types.ts';
import {ACHADO_FILE, ACHADO_ID, EXCERPT_LIMIT, MODULE_REPORT_DIR, MODULE_TITLES, ModuleCollectorOutput, ModuleReportSummary, ModuleToolCoverage, assertInside, assertModuleRepoRelativePath, assertSafeSegment, assertVerificationModule, documentationCoverage, isErrno, isProtectedLocation} from './verification-modules-contracts.ts';
import {sanitizeText, validateModuleCollectorObject, validateSingleLineString, validateTextBlock} from './verification-modules-collector.ts';
import {assertPinnedModuleImage} from './verification-modules-container.ts';

type ModuleReviewPromptInput = {
  module: VerificationModule;
  achadoId?: string;
  tool: string;
  rule: string;
  file: string;
  line: number;
  evidence: string;
  codeExcerpt: string;
  [key: string]: unknown;
};

export function moduleReviewPromptEvidence(input: ModuleReviewPromptInput) {
  assertVerificationModule(input.module);
  const file = assertModuleRepoRelativePath(input.file);
  if (!Number.isInteger(input.line) || input.line < 1) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  const tool = validateSingleLineString(input.tool, 1, 120, false);
  const rule = validateSingleLineString(input.rule, 1, 200, true);
  const evidence = validateTextBlock(input.evidence, 1, 2000);
  const code = sanitizeText(input.codeExcerpt).trim().slice(0, EXCERPT_LIMIT / 2);
  return {module: input.module, tool, rule, file, line: input.line, evidence, code, hypothesis: moduleCollectorHypothesis(rule)};
}

/** The request is assembled from source evidence and omits author conclusions. */
export function buildModuleReviewPrompt(input: ModuleReviewPromptInput): string {
  return moduleReviewTask(moduleReviewPromptEvidence(input));
}

export function assertNoLiveAccessKey(value: unknown): void {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (hasKnownSecret(current)) throw new Refusal('VERIFY_SECRET_IN_REPORT', 400);
      continue;
    }
    if (current === null || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (hasKnownSecret(key)) throw new Refusal('VERIFY_SECRET_IN_REPORT', 400);
      pending.push(item);
    }
  }
}

export function guardReportText(text: string): string {
  if (hasKnownSecret(text)) throw new Refusal('VERIFY_SECRET_IN_REPORT', 400);
  return text;
}

function stampOf(createdAt: Date): string {
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const pad = (value: number, width = 2) => value.toString().padStart(width, '0');
  return `${pad(createdAt.getUTCFullYear(), 4)}${pad(createdAt.getUTCMonth() + 1)}${pad(createdAt.getUTCDate())}-${pad(createdAt.getUTCHours())}${pad(createdAt.getUTCMinutes())}${pad(createdAt.getUTCSeconds())}`;
}

function reportSuffix(runId: string): string {
  if (Id.safeParse(runId).success) return runId.replaceAll('-', '').toLowerCase();
  return randomBytes(4).toString('hex');
}

export function moduleReportDirectoryName(createdAt: Date, runId: string, module: VerificationModule): string {
  assertVerificationModule(module);
  return `${stampOf(createdAt)}-${reportSuffix(runId)}-${module}`;
}

export function failureCounts(achados: readonly Achado[], all = false): ModuleReportSummary['counts'] {
  const counts = {alta: 0, media: 0, baixa: 0, informativa: 0};
  for (const achado of achados) {
    if (all ? achado.status !== 'descartado' : achado.status === 'confirmado' || achado.status === 'reaberto') counts[achado.severity] += 1;
  }
  return counts;
}

const SEVERITY_ORDER: readonly Achado['severity'][] = ['alta', 'media', 'baixa', 'informativa'];
const RULE_TABLE_LIMIT = 20;

/** Severity table: every finding, and the confirmed or reopened ones that set the failure note. */
function severityTable(counts: ModuleReportSummary['counts'], achados?: readonly Achado[]): string[] {
  if (!achados) {
    return ['| Gravidade | Quantidade |', '|---|---|', ...SEVERITY_ORDER.map(level => `| ${SEVERITY_LABEL[level]} | ${counts[level]} |`)];
  }
  const totals = failureCounts(achados, true);
  return ['| Gravidade | Total sem descartados | Confirmados ou reabertos (nota de falha) |', '|---|---|---|',
    ...SEVERITY_ORDER.map(level => `| ${SEVERITY_LABEL[level]} | ${totals[level]} | ${counts[level]} |`)];
}

/** The rules with the most findings, so a flood from one tool shows at a glance. */
function ruleTable(achados: readonly Achado[]): string[] {
  const groups = new Map<string, {count: number; severity: Achado['severity']; statuses: Map<Achado['status'], number>}>();
  for (const achado of achados) {
    const group = groups.get(achado.reference) ?? {count: 0, severity: achado.severity, statuses: new Map()};
    group.count += 1;
    if (SEVERITY_ORDER.indexOf(achado.severity) < SEVERITY_ORDER.indexOf(group.severity)) group.severity = achado.severity;
    group.statuses.set(achado.status, (group.statuses.get(achado.status) ?? 0) + 1);
    groups.set(achado.reference, group);
  }
  const rows = [...groups].sort(([a, left], [b, right]) => right.count - left.count || a.localeCompare(b));
  return [
    '## Por regra',
    '',
    ...(rows.length > RULE_TABLE_LIMIT ? [`As ${RULE_TABLE_LIMIT} regras com mais achados, de ${rows.length}.`, ''] : []),
    '| Regra | Achados | Maior gravidade | Situação |',
    '|---|---|---|---|',
    ...rows.slice(0, RULE_TABLE_LIMIT).map(([reference, group]) => `| ${tableCell(reference)} | ${group.count} | ${SEVERITY_LABEL[group.severity]} | ${
      [...group.statuses].map(([status, count]) => `${STATUS_LABEL[status]} ${count}`).join(', ')} |`),
    '',
  ];
}

function pt(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function failureNote(counts: ModuleReportSummary['counts'], toolFailures: number): string {
  if (toolFailures > 0) return `Nota de falha: execução com ${pt(toolFailures, 'falha de ferramenta', 'falhas de ferramentas')} na cobertura.`;
  if (counts.alta > 0) return 'Nota de falha: reprovado por achado confirmado ou reaberto de gravidade alta.';
  if (counts.media > 0) return 'Nota de falha: ressalva por achado confirmado ou reaberto de gravidade média.';
  if (counts.baixa > 0) return 'Nota de falha: ressalva por achado confirmado ou reaberto de gravidade baixa.';
  if (counts.informativa > 0) return 'Nota de falha: ressalva por achado confirmado ou reaberto de gravidade informativa.';
  return 'Nota de falha: sem falha confirmada ou reaberta.';
}

const SEVERITY_LABEL: Record<Achado['severity'], string> = {
  alta: 'alta',
  media: 'média',
  baixa: 'baixa',
  informativa: 'informativa',
};

const STATUS_LABEL: Record<Achado['status'], string> = {
  confirmado: 'confirmado',
  provavel: 'provável',
  descartado: 'descartado',
  fechado: 'fechado',
  reaberto: 'reaberto',
};

export function achadoMarkdown(achado: Achado): string {
  const where = achado.where.line === null ? achado.where.file : `${achado.where.file}:${achado.where.line}`;
  const situacao = achado.verifier
    ? `${STATUS_LABEL[achado.status]} (verificador: ${achado.verifier.model}, ${achado.verifier.provider})`
    : STATUS_LABEL[achado.status];
  return [
    `# ${achado.id}: ${achado.title}`,
    `- Gravidade: ${SEVERITY_LABEL[achado.severity]}`,
    `- Situação: ${situacao}`,
    `- Referência: ${achado.reference}`,
    `- Onde: ${where}`,
    `- Cenário: ${achado.scenario}`,
    `- Prova: ${achado.proof}`,
    `- Correção sugerida: ${achado.suggestion}`,
    `- Critério de aceite: ${achado.acceptance}`,
    `- Fontes: ${achado.sources.join(', ')}`,
    '',
  ].join('\n');
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '/').replace(/\r?\n/g, ' ').trim();
}

export function renderModuleCoverageMarkdown(
  toolCoverage: readonly ModuleToolCoverage[],
  fileCoverage: readonly CoverageRow[],
): string {
  return [
    '# Cobertura',
    '',
    '## Cobertura das ferramentas',
    '',
    '| Ferramenta | Versão | Situação | Detalhe |',
    '|---|---|---|---|',
    ...toolCoverage.map(row => `| ${tableCell(row.tool)} | ${tableCell(row.version)} | ${tableCell(row.status)} | ${tableCell(row.detail)} |`),
    '',
    '## Cobertura de arquivos',
    '',
    '| Arquivo | Examinador (provedor/modelo) | Itens da lista |',
    '|---|---|---|',
    ...fileCoverage.map(row => `| ${tableCell(row.file)} | ${tableCell(`${row.examinerProvider}/${row.examinerModel}`)} | ${tableCell(row.checklist.join(', '))} |`),
    '',
  ].join('\n');
}

export function renderModuleReadme(input: {
  module: VerificationModule;
  runId: string;
  directoryName: string;
  createdAt: Date;
  commit: string;
  note: string;
  total: number;
  counts: ModuleReportSummary['counts'];
  discarded: number;
  toolCoverage: readonly ModuleToolCoverage[];
  /** With the findings, the severity table also shows totals and a per-rule table follows. */
  achados?: readonly Achado[];
}): string {
  const title = MODULE_TITLES[input.module];
  const failing = input.counts.alta + input.counts.media + input.counts.baixa + input.counts.informativa;
  const failedTools = input.toolCoverage.filter(row => row.status === 'failed');
  const skippedTools = input.toolCoverage.filter(row => row.status === 'skipped');
  const unverifiedLines = [
    ...failedTools.map(row => `- ${row.tool} (${row.version}) [failed]: ${row.detail}`),
    ...skippedTools.map(row => `- ${row.tool} (${row.version}) [skipped]: ${row.detail}`),
  ];
  return [
    `# Relatório de verificação — ${title} (${input.module})`,
    '',
    '## Resumo',
    '',
    `Execução \`${input.runId}\`, módulo \`${input.module}\`, diretório \`${input.directoryName}\`, commit \`${input.commit}\`, gerado em ${input.createdAt.toISOString()}.`,
    `Há ${pt(input.total, 'achado', 'achados')} no relatório. A nota de falha considera ${pt(failing, 'achado', 'achados')} com situação confirmado ou reaberto.`,
    '',
    '## Nota geral',
    '',
    input.note,
    '',
    '## Contagem por gravidade',
    '',
    ...severityTable(input.counts, input.achados),
    '',
    ...(input.achados?.length ? ruleTable(input.achados) : []),
    '## Nota de falha',
    '',
    failureNote(input.counts, failedTools.length),
    '',
    '## Cobertura das ferramentas',
    '',
    '| Ferramenta | Versão | Situação | Detalhe |',
    '|---|---|---|---|',
    ...input.toolCoverage.map(row => `| ${tableCell(row.tool)} | ${tableCell(row.version)} | ${tableCell(row.status)} | ${tableCell(row.detail)} |`),
    '',
    '## Falhas de ferramentas',
    '',
    ...(failedTools.length > 0
      ? failedTools.map(row => `- ${row.tool} (${row.version}): ${row.detail}`)
      : ['Nenhuma falha de ferramenta registrada.']),
    '',
    '## O que não foi possível verificar',
    '',
    ...(unverifiedLines.length > 0 ? unverifiedLines : [input.note]),
    '',
  ].join('\n');
}

function renderModuleMapMarkdown(
  module: VerificationModule,
  files: readonly string[],
  toolCoverage: readonly ModuleToolCoverage[],
): string {
  const tools = [...new Set(toolCoverage.map(item => `${item.tool}@${item.version}`))];
  return [
    `# Mapa — ${MODULE_TITLES[module]} (${module})`,
    '',
    '## Ferramentas executadas',
    ...(tools.length > 0 ? tools.map(item => `- ${item}`) : ['- nenhuma']),
    '',
    '## Arquivos examinados',
    ...(files.length > 0 ? files.map(item => `- ${item}`) : ['- nenhum']),
    '',
  ].join('\n');
}

export async function requireDataDirectory(dataDirectory: string): Promise<string> {
  try {
    const info = await lstat(dataDirectory);
    if (!info.isDirectory() && !info.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    const real = await realpath(dataDirectory);
    const realInfo = await lstat(real);
    if (!realInfo.isDirectory() || realInfo.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    return real;
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) {
      throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    }
    throw error;
  }
}

async function ensureDir(parentReal: string, name: string): Promise<string> {
  assertSafeSegment(name);
  const path = join(parentReal, name);
  assertInside(parentReal, path);
  try {
    await mkdir(path, {mode: 0o700});
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const real = await realpath(path);
  if (real !== path) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  assertInside(parentReal, real);
  await chmod(path, 0o700);
  const after = await lstat(path);
  if (after.isSymbolicLink() || !after.isDirectory() || (after.mode & 0o777) !== 0o700) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
  return path;
}

async function createReportDir(parentReal: string, name: string): Promise<string> {
  assertSafeSegment(name);
  const path = join(parentReal, name);
  assertInside(parentReal, path);
  try {
    await mkdir(path, {mode: 0o700});
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
    const existing = await lstat(path);
    if (existing.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    throw new Refusal('VERIFY_REPORT_EXISTS', 409);
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const real = await realpath(path);
  if (real !== path) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  assertInside(parentReal, real);
  await chmod(path, 0o700);
  return path;
}

export async function writePrivate(path: string, root: string, content: string): Promise<void> {
  const lexical = resolve(path);
  assertInside(root, lexical);
  const parent = dirname(lexical);
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || await realpath(parent) !== parent)
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const handle = await open(lexical, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content, {encoding: 'utf8'});
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const info = await lstat(lexical);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
  const real = await realpath(lexical);
  if (real !== lexical) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  assertInside(root, real);
}

export async function syncReportDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeModuleReport(input: {
  dataDirectory: string;
  projectId: string;
  module: VerificationModule;
  runId: string;
  createdAt: Date;
  commit: string;
  image?: string;
  previousPerformanceRunId?: string;
  deferPublication?: boolean;
  toolCoverage: readonly ModuleToolCoverage[];
  fileCoverage: readonly CoverageRow[];
  achados: readonly Achado[];
  raw: ModuleCollectorOutput;
  measuredFiles?: ReadonlyMap<string, readonly ModuleToolCoverage[]>;
  exam?: Pick<ModuleExamResult, 'mode' | 'coverage' | 'routes' | 'notes'> & {findings?: ModuleExamResult['findings']};
  note?: string;
  directoryName?: string;
}): Promise<{directory: string; directoryName: string; summary: ModuleReportSummary; examOriginSha256?: string}> {
  assertVerificationModule(input.module);
  assertSafeSegment(input.projectId);
  assertSafeSegment(input.runId);
  if (!/^[a-f0-9]{40}$/.test(input.commit)) throw new Refusal('VERIFY_COMMIT_INVALID', 400);
  const sourceCoverage = input.toolCoverage.map(row => ModuleToolCoverage.parse(row));
  const doc = input.module === 'documentacao' ? documentationCoverage(sourceCoverage) : undefined;
  if (!doc && sourceCoverage.some(row => row.tool.endsWith(':artefato'))) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const toolCoverage = doc?.coverage ?? sourceCoverage;
  if (toolCoverage.length < 1) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const fileCoverage = input.fileCoverage.map(row => CoverageRow.parse(row));
  const ids = new Set<string>();
  const achados = input.achados.map(item => {
    const parsed = Achado.safeParse(item);
    if (!parsed.success || ids.has(parsed.data.id)) throw new Refusal('VERIFY_REPORT_INVALID', 400);
    ids.add(parsed.data.id);
    return parsed.data;
  });
  assertNoLiveAccessKey(input.raw);
  const raw = validateModuleCollectorObject(input.raw, input.module);
  if (JSON.stringify(raw.coverage) !== JSON.stringify(sourceCoverage)) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  for (const row of fileCoverage) {
    if (input.module === 'prontidao' && isProtectedLocation(row.file)) {
      if (!raw.findings.some(finding => finding.file === row.file)) throw new Refusal('VERIFY_REPORT_INVALID', 400);
    } else assertModuleRepoRelativePath(row.file);
  }
  for (const achado of achados) {
    if (!isProtectedLocation(achado.where.file)) {
      assertModuleRepoRelativePath(achado.where.file);
      continue;
    }
    const finding = raw.findings[Number(achado.id.slice(4)) - 1];
    if (input.module !== 'prontidao' || !finding || finding.file !== achado.where.file
      || finding.line !== achado.where.line || achado.scenario !== finding.message
      || achado.proof !== finding.evidence || achado.sources[0] !== finding.tool || achado.sources[1] !== finding.rule)
      throw new Refusal('VERIFY_REPORT_INVALID', 400);
  }
  const safeRaw = {...raw, coverage: toolCoverage};
  assertNoLiveAccessKey(safeRaw);
  assertNoLiveAccessKey(achados);
  const rawBody = guardReportText(`${JSON.stringify(safeRaw, null, 2)}\n`);
  const reserved = typeof input.directoryName === 'string';
  const directoryName = reserved
    ? input.directoryName!
    : moduleReportDirectoryName(input.createdAt, input.runId, input.module);
  const counts = failureCounts(achados);
  const toolFailures = toolCoverage.filter(row => row.status === 'failed').length;
  const defaultNote = toolFailures > 0
    ? `Módulo ${input.module} concluído com ${pt(toolFailures, 'falha de ferramenta', 'falhas de ferramentas')} registrada na cobertura.`
    : `Verificação do módulo ${input.module} concluída.`;
  const note = sanitizeText(input.note ?? defaultNote).slice(0, 500);
  const summaryParsed = ModuleReportSummary.safeParse({
    id: input.runId,
    module: input.module,
    directoryName,
    commit: input.commit,
    ...(input.image ? {image: assertPinnedModuleImage(input.image)} : {}),
    ...(input.previousPerformanceRunId ? {previousPerformanceRunId: Id.parse(input.previousPerformanceRunId)} : {}),
    createdAt: input.createdAt.toISOString(),
    counts,
    toolFailures,
    note,
  });
  if (!summaryParsed.success) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const summary = summaryParsed.data;
  const discarded = achados.filter(item => item.status === 'descartado').length;
  let mapMarkdown = renderModuleMapMarkdown(input.module, fileCoverage.map(row => row.file), toolCoverage);
  let coverageBody = renderModuleCoverageMarkdown(toolCoverage, fileCoverage);
  if (summary.previousPerformanceRunId) coverageBody += '\nMedição anterior de desempenho: ' + summary.previousPerformanceRunId + '\n';
  const cell = (value: string) => sanitizeText(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('|', '&#124;').replace(/[\r\n]+/g, ' ');
  if (input.measuredFiles?.size) {
    const measurements = [...input.measuredFiles].map(([file, rows]) =>
      `| ${cell(file)} | ${[...new Set(rows.map(row => cell(row.tool) + '@' + cell(row.version)))].join(', ')} |`);
    coverageBody += ['', '## Medições do coletor por arquivo', '', '| Arquivo | Ferramentas |', '|---|---|', ...measurements, ''].join('\n');
  }
  if (input.exam) {
    const files = input.exam.coverage.map(row =>
      `| ${cell(row.file)} | ${cell(row.status)} | ${cell(row.reason ?? row.examiner?.model ?? '')} |`);
    const routes = input.exam.routes.map(row =>
      `| ${cell(row.method)} | ${cell(row.path)} | ${cell(row.file)}#${row.line} | ${cell(row.status)} |`);
    mapMarkdown += ['','## Inventário de arquivos','','| Arquivo | Exame | Motivo ou modelo |','|---|---|---|', ...files,
      '', '## Rotas identificadas', '', '| Método | Rota | Origem | Exame |', '|---|---|---|---|', ...routes, ''].join('\n');
    coverageBody += ['', '## Exame independente', '', `Modo: ${cell(input.exam.mode)}`, '',
      '| Arquivo | Estado | Motivo ou modelo |','|---|---|---|', ...files, '', ...input.exam.notes.map(n => `- ${cell(n)}`), ''].join('\n');
  }
  const examOrigin = input.exam ? guardReportText(JSON.stringify(
      achados.flatMap((item, index) => {
        if (item.sources[0] !== 'examinador' || item.sources[1] !== 'exame-de-arquivo') return [];
        const hypothesis = input.exam?.findings?.[index]?.hypothesis;
        return [{id: item.id, file: item.where.file, line: item.where.line, evidence: item.scenario,
          ...(hypothesis ? {hypothesis: sanitizeText(hypothesis)} : {})}];
      }),
    )) : undefined;
  const planned: {segments: string[]; body: string}[] = [
    {
      segments: ['README.md'],
      body: guardReportText(renderModuleReadme({
        module: input.module,
        runId: summary.id,
        directoryName,
        createdAt: input.createdAt,
        commit: input.commit,
        note,
        total: achados.length,
        counts,
        discarded,
        toolCoverage,
        achados,
      })),
    },
    {segments: ['mapa.md'], body: guardReportText(mapMarkdown)},
    {segments: ['cobertura.md'], body: guardReportText(coverageBody)},
    {segments: ['achados.json'], body: guardReportText(`${JSON.stringify({achados}, null, 2)}\n`)},
    ...achados.map(achado => ({segments: ['achados', `${achado.id}.md`], body: guardReportText(achadoMarkdown(achado))})),
    {segments: ['bruto', 'achados-brutos.json'], body: rawBody},
    ...(examOrigin !== undefined ? [{segments: ['bruto', 'exame.json'], body: examOrigin}] : []),
    ...Object.entries(doc?.artifacts ?? {}).flatMap(([name, artifact]) => artifact.status === 'present'
      ? [{segments: [name], body: guardReportText(artifact.content)}] : []),
    {segments: [input.deferPublication ? '.run-pending.json' : 'run.json'], body: guardReportText(`${JSON.stringify(summary, null, 2)}\n`)},
  ];
  for (const file of planned) {
    for (const segment of file.segments) assertSafeSegment(segment);
    if (file.segments[0] === 'achados' && file.segments.length === 2 && !ACHADO_FILE.test(file.segments[1]!)) {
      throw new Refusal('VERIFY_REPORT_INVALID', 400);
    }
  }
  const dataReal = await requireDataDirectory(input.dataDirectory);
  const root = await ensureDir(dataReal, 'verificacoes');
  const project = await ensureDir(root, input.projectId);
  const directory = reserved ? await ensureDir(project, directoryName) : await createReportDir(project, directoryName);
  const findingsDirectory = await ensureDir(directory, 'achados');
  const rawDirectory = await ensureDir(directory, 'bruto');
  for (const file of planned) {
    const path = file.segments.reduce((parent, segment) => {
      const next = join(parent, segment);
      assertInside(directory, next);
      return next;
    }, directory);
    await writePrivate(path, directory, file.body);
  }
  await Promise.all([syncReportDirectory(findingsDirectory), syncReportDirectory(rawDirectory)]);
  for (const ancestor of [directory, project, root, dataReal]) await syncReportDirectory(ancestor);
  return {directory, directoryName, summary,
    ...(examOrigin !== undefined ? {examOriginSha256: createHash('sha256').update(examOrigin).digest('hex')} : {})};
}

export async function resolveProjectVerificationsDir(dataDirectory: string, projectId: string): Promise<string | null> {
  assertSafeSegment(projectId);
  let dataReal: string;
  try {
    dataReal = await realpath(dataDirectory);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    if (isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    throw error;
  }
  const root = join(dataReal, 'verificacoes');
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const project = join(root, projectId);
  assertInside(root, project);
  let info;
  try {
    info = await lstat(project);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    if (isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const real = await realpath(project);
  if (real !== project) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  assertInside(root, real);
  return real;
}

export async function readTextInside(root: string, path: string, missingCode: 'VERIFY_ACHADO_NOT_FOUND' | 'VERIFY_REPORT_INVALID', expectedSha256?: string): Promise<string> {
  const lexical = resolve(path);
  assertInside(root, lexical);
  let info;
  try {
    info = await lstat(lexical);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new Refusal(missingCode, missingCode === 'VERIFY_ACHADO_NOT_FOUND' ? 404 : 400);
    if (isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    throw error;
  }
  if (info.isDirectory() && await realpath(lexical) === lexical) throw new Refusal(missingCode, missingCode === 'VERIFY_ACHADO_NOT_FOUND' ? 404 : 400);
  if (info.isSymbolicLink() || !info.isFile()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const real = await realpath(lexical);
  if (real !== lexical) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  assertInside(root, real);
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!expectedSha256) return await handle.readFile('utf8');
    const bytes = await handle.readFile();
    if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Refusal('VERIFY_REPORT_INVALID', 400);
    return bytes.toString('utf8');
  } finally {
    await handle.close();
  }
}

export function requiredModuleArtifacts(coverage: readonly ModuleToolCoverage[]): string[] {
  const published = new Set(coverage.filter(row => row.status === 'ok').map(row => row.tool));
  const names: string[] = [];
  if (published.has('typedoc:artefato')) names.push('api.json');
  if (published.has('dependency-cruiser:artefato')) names.push('dependencias.mmd');
  return names;
}

async function loadModuleReports(
  projectDir: string,
  module?: VerificationModule,
): Promise<{directory: string; summary: ModuleReportSummary}[]> {
  if (module !== undefined) assertVerificationModule(module);
  const found: {directory: string; summary: ModuleReportSummary}[] = [];
  for (const entry of await readdir(projectDir, {withFileTypes: true})) {
    const name = entry.name;
    if (!MODULE_REPORT_DIR.test(name)) continue;
    if (module !== undefined && !name.endsWith(`-${module}`)) continue;
    const path = join(projectDir, name);
    if (entry.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    if (!entry.isDirectory() || !await reportDirectoryExists(path)) continue;
    try {
      const text = await readTextInside(projectDir, join(path, 'run.json'), 'VERIFY_REPORT_INVALID');
      const parsed = ModuleReportSummary.safeParse(JSON.parse(text));
      if (!parsed.success || parsed.data.directoryName !== name) continue;
      if (module !== undefined && parsed.data.module !== module) continue;
      const rawText = await readTextInside(path, join(path, 'bruto', 'achados-brutos.json'), 'VERIFY_REPORT_INVALID');
      const raw = validateModuleCollectorObject(JSON.parse(rawText), parsed.data.module);
      const findingsText = await readTextInside(path, join(path, 'achados.json'), 'VERIFY_REPORT_INVALID');
      const findings = z.object({achados: z.array(Achado).max(999)}).parse(JSON.parse(findingsText));
      const required = ['README.md', 'mapa.md', 'cobertura.md', ...requiredModuleArtifacts(raw.coverage),
        ...findings.achados.map(item => join('achados', item.id + '.md'))];
      for (const file of required) {
        const fullPath = join(path, file);
        const info = await lstat(fullPath);
        if (info.isSymbolicLink() || await realpath(fullPath) !== fullPath) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
        if (!info.isFile()) throw new Refusal('VERIFY_REPORT_INVALID', 400);
      }
      found.push({directory: path, summary: parsed.data});
    } catch (error) {
      if (error instanceof Refusal && error.code === 'VERIFY_PATH_FORBIDDEN') throw error;
    }
  }
  found.sort((a, b) => a.summary.directoryName.localeCompare(b.summary.directoryName) || a.summary.id.localeCompare(b.summary.id));
  return found;
}

export async function listModuleReports(
  dataDirectory: string,
  projectId: string,
  module?: VerificationModule,
): Promise<ModuleReportSummary[]> {
  const projectDir = await resolveProjectVerificationsDir(dataDirectory, projectId);
  if (!projectDir) return [];
  return (await loadModuleReports(projectDir, module)).map(item => item.summary);
}

export async function readModuleReport(
  dataDirectory: string,
  projectId: string,
  runId: string,
  module?: VerificationModule,
): Promise<{
  summary: ModuleReportSummary;
  achados: Achado[];
  coverageMarkdown: string;
  mapMarkdown: string;
  readmeMarkdown: string;
  toolCoverage: ModuleToolCoverage[];
}> {
  assertSafeSegment(projectId);
  assertSafeSegment(runId);
  const projectDir = await resolveProjectVerificationsDir(dataDirectory, projectId);
  if (!projectDir) throw new Refusal('VERIFY_REPORT_NOT_FOUND', 404);
  const matches = (await loadModuleReports(projectDir, module)).filter(item => item.summary.id === runId);
  if (matches.length === 0) throw new Refusal('VERIFY_REPORT_NOT_FOUND', 404);
  if (matches.length > 1) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const report = matches[0]!;
  const achadosRaw = JSON.parse(await readTextInside(report.directory, join(report.directory, 'achados.json'), 'VERIFY_REPORT_INVALID')) as {achados?: unknown};
  if (!achadosRaw || typeof achadosRaw !== 'object' || !Array.isArray(achadosRaw.achados)) {
    throw new Refusal('VERIFY_REPORT_INVALID', 400);
  }
  const achados = achadosRaw.achados.map(item => Achado.parse(item));
  const coverageMarkdown = await readTextInside(report.directory, join(report.directory, 'cobertura.md'), 'VERIFY_REPORT_INVALID');
  const mapMarkdown = await readTextInside(report.directory, join(report.directory, 'mapa.md'), 'VERIFY_REPORT_INVALID');
  const readmeMarkdown = await readTextInside(report.directory, join(report.directory, 'README.md'), 'VERIFY_REPORT_INVALID');
  const rawJson = JSON.parse(await readTextInside(report.directory, join(report.directory, 'bruto', 'achados-brutos.json'), 'VERIFY_REPORT_INVALID')) as unknown;
  const raw = validateModuleCollectorObject(rawJson, report.summary.module);
  return {summary: report.summary, achados, coverageMarkdown, mapMarkdown, readmeMarkdown, toolCoverage: raw.coverage};
}

export async function readModuleAchadoMarkdown(
  dataDirectory: string,
  projectId: string,
  runId: string,
  achadoId: string,
  module?: VerificationModule,
): Promise<string> {
  assertSafeSegment(achadoId);
  if (!ACHADO_ID.safeParse(achadoId).success) throw new Refusal('VERIFY_ACHADO_NOT_FOUND', 404);
  const projectDir = await resolveProjectVerificationsDir(dataDirectory, projectId);
  if (!projectDir) throw new Refusal('VERIFY_REPORT_NOT_FOUND', 404);
  const matches = (await loadModuleReports(projectDir, module)).filter(item => item.summary.id === runId);
  if (matches.length !== 1) throw new Refusal('VERIFY_REPORT_NOT_FOUND', 404);
  return readTextInside(matches[0]!.directory, join(matches[0]!.directory, 'achados', `${achadoId}.md`), 'VERIFY_ACHADO_NOT_FOUND');
}

export async function reportDirectoryExists(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory) {
      throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    }
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}
