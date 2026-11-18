import {randomBytes} from 'node:crypto';
import {chmod, lstat, mkdir, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {Refusal} from './contracts.ts';
import {hasKnownSecret} from './verify-redact.ts';
import {Achado, CoverageRow, ReportSummary} from './verify-types.ts';

const REPORT_DIRECTORY = /^\d{8}-\d{6}(?:-[a-f0-9]{8})?-seguranca$/;
const NEW_REPORT_DIRECTORY = /^\d{8}-\d{6}-[a-f0-9]{8}-seguranca$/;
const ACHADO_FILE = /^ACH-\d{3}\.md$/;

function hasLiveAccessKey(text: string): boolean {
  return hasKnownSecret(text);
}

function assertNoLiveAccessKey(value: unknown): void {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (hasLiveAccessKey(current)) throw new Refusal('VERIFY_SECRET_IN_REPORT', 400);
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
      if (hasLiveAccessKey(key)) throw new Refusal('VERIFY_SECRET_IN_REPORT', 400);
      pending.push(item);
    }
  }
}

function guard(text: string): string {
  if (hasLiveAccessKey(text)) throw new Refusal('VERIFY_SECRET_IN_REPORT', 400);
  return text;
}

function serializedRaw(raw: unknown): string {
  assertNoLiveAccessKey(raw);
  let body: string;
  try {
    body = JSON.stringify(raw, null, 2);
  } catch {
    throw new Refusal('VERIFY_REPORT_INVALID', 400);
  }
  if (typeof body !== 'string') throw new Refusal('VERIFY_REPORT_INVALID', 400);
  return guard(`${body}\n`);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function assertSafeSegment(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240 || value === '.' || value === '..' || value.includes('..') || value.includes('/') || value.includes('\\') || value.includes('\0') || isAbsolute(value)) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
}

function assertInside(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
}

function stampOf(createdAt: Date): string {
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const pad = (value: number, width = 2) => value.toString().padStart(width, '0');
  return `${pad(createdAt.getUTCFullYear(), 4)}${pad(createdAt.getUTCMonth() + 1)}${pad(createdAt.getUTCDate())}-${pad(createdAt.getUTCHours())}${pad(createdAt.getUTCMinutes())}${pad(createdAt.getUTCSeconds())}`;
}

function reportSuffix(runId: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) return runId.slice(0, 8).toLowerCase();
  return randomBytes(4).toString('hex');
}

function directoryNameOf(createdAt: Date, runId: string): string {
  const name = `${stampOf(createdAt)}-${reportSuffix(runId)}-seguranca`;
  if (!NEW_REPORT_DIRECTORY.test(name)) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  return name;
}

function parseAchados(value: readonly Achado[]): Achado[] {
  if (!Array.isArray(value)) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const ids = new Set<string>();
  return value.map(item => {
    const parsed = Achado.safeParse(item);
    if (!parsed.success) throw new Refusal('VERIFY_REPORT_INVALID', 400);
    if (ids.has(parsed.data.id)) throw new Refusal('VERIFY_REPORT_INVALID', 400);
    ids.add(parsed.data.id);
    return parsed.data;
  });
}

function parseCoverage(value: readonly CoverageRow[]): CoverageRow[] {
  if (!Array.isArray(value)) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  return value.map(item => {
    const parsed = CoverageRow.safeParse(item);
    if (!parsed.success) throw new Refusal('VERIFY_REPORT_INVALID', 400);
    return parsed.data;
  });
}

function failureCounts(achados: readonly Achado[]): ReportSummary['counts'] {
  const counts = {alta: 0, media: 0, baixa: 0, informativa: 0};
  for (const achado of achados) {
    if (achado.status === 'confirmado' || achado.status === 'reaberto') counts[achado.severity] += 1;
  }
  return counts;
}

function pt(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function failureNote(counts: ReportSummary['counts']): string {
  if (counts.alta > 0) return 'Nota de falha: reprovado por achado confirmado ou reaberto de gravidade alta.';
  if (counts.media > 0) return 'Nota de falha: ressalva por achado confirmado ou reaberto de gravidade média.';
  if (counts.baixa > 0) return 'Nota de falha: ressalva por achado confirmado ou reaberto de gravidade baixa.';
  if (counts.informativa > 0) return 'Nota de falha: ressalva por achado confirmado ou reaberto de gravidade informativa.';
  return 'Nota de falha: sem falha confirmada ou reaberta.';
}

function discardedText(discarded: number): string {
  if (discarded === 0) return 'Não há achados descartados. A contagem fica à parte e não entra na nota de falha.';
  return `Há ${pt(discarded, 'achado descartado', 'achados descartados')}. Essa contagem fica à parte e não entra na nota de falha.`;
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

function achadoMarkdown(achado: Achado): string {
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

function cell(value: string): string {
  return value.replace(/\r?\n/g, ' ');
}

function coverageMarkdown(rows: readonly CoverageRow[]): string {
  const lines = [
    '# Cobertura',
    '',
    '| Arquivo | Examinador (provedor/modelo) | Itens da lista |',
    '|---|---|---|',
    ...rows.map(row => `| ${cell(row.file)} | ${cell(`${row.examinerProvider}/${row.examinerModel}`)} | ${cell(row.checklist.join(', '))} |`),
    '',
  ];
  return lines.join('\n');
}

function readme(input: {
  runId: string; directoryName: string; createdAt: Date; commit: string; note: string;
  total: number; counts: ReportSummary['counts']; discarded: number;
}): string {
  const failing = input.counts.alta + input.counts.media + input.counts.baixa + input.counts.informativa;
  return [
    '# Relatório de verificação de segurança',
    '',
    '## Resumo',
    '',
    `Execução \`${input.runId}\`, diretório \`${input.directoryName}\`, commit \`${input.commit}\`, gerado em ${input.createdAt.toISOString()}.`,
    `Há ${pt(input.total, 'achado', 'achados')} no relatório. A nota de falha considera ${pt(failing, 'achado', 'achados')} com situação confirmado ou reaberto.`,
    '',
    '## Nota geral',
    '',
    input.note,
    '',
    '## Contagem por gravidade',
    '',
    'A contagem abaixo inclui só achados com situação confirmado ou reaberto.',
    '',
    '| Gravidade | Quantidade |',
    '|---|---|',
    `| alta | ${input.counts.alta} |`,
    `| média | ${input.counts.media} |`,
    `| baixa | ${input.counts.baixa} |`,
    `| informativa | ${input.counts.informativa} |`,
    '',
    '## Nota de falha',
    '',
    failureNote(input.counts),
    'Achados descartados não entram na nota de falha.',
    '',
    '## Descartados',
    '',
    discardedText(input.discarded),
    '',
    '## O que não foi possível verificar',
    '',
    input.note,
    '',
  ].join('\n');
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
  if (after.isSymbolicLink() || !after.isDirectory() || (after.mode & 0o777) !== 0o700) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
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

async function writePrivate(path: string, root: string, content: string): Promise<void> {
  const lexical = resolve(path);
  assertInside(root, lexical);
  await writeFile(lexical, content, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
  await chmod(lexical, 0o600);
  const info = await lstat(lexical);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const real = await realpath(lexical);
  if (real !== lexical) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  assertInside(root, real);
}

async function requireDataDirectory(dataDirectory: string): Promise<string> {
  try {
    const info = await lstat(dataDirectory);
    if (!info.isDirectory() && !info.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    const real = await realpath(dataDirectory);
    const realInfo = await lstat(real);
    if (!realInfo.isDirectory() || realInfo.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    return real;
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    throw error;
  }
}

async function resolveProject(dataDirectory: string, projectId: string): Promise<string | null> {
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
  const rootReal = await realpath(root);
  if (rootReal !== root) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const project = join(rootReal, projectId);
  assertInside(rootReal, project);
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
  assertInside(rootReal, real);
  return real;
}

async function readTextInside(root: string, path: string, missingCode: 'VERIFY_ACHADO_NOT_FOUND' | 'VERIFY_REPORT_INVALID'): Promise<string> {
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
  if (info.isSymbolicLink() || !info.isFile()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const real = await realpath(lexical);
  if (real !== lexical) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  assertInside(root, real);
  return readFile(real, 'utf8');
}

function parseSummaryText(text: string, directoryName: string): ReportSummary {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refusal('VERIFY_REPORT_INVALID', 400);
  }
  const parsed = ReportSummary.safeParse(body);
  if (!parsed.success || parsed.data.directoryName !== directoryName) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  return parsed.data;
}

function parseAchadosFile(text: string): Achado[] {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refusal('VERIFY_REPORT_INVALID', 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !('achados' in body)) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const list = (body as {achados: unknown}).achados;
  if (!Array.isArray(list)) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  return list.map(item => {
    const parsed = Achado.safeParse(item);
    if (!parsed.success) throw new Refusal('VERIFY_REPORT_INVALID', 400);
    return parsed.data;
  });
}

async function loadReports(project: string): Promise<{reports: {directory: string; summary: ReportSummary}[]; corrupt: string[]}> {
  const reports: {directory: string; summary: ReportSummary}[] = [];
  const corrupt: string[] = [];
  for (const name of await readdir(project)) {
    if (!REPORT_DIRECTORY.test(name)) continue;
    const path = join(project, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    if (!info.isDirectory()) continue;
    const real = await realpath(path);
    if (real !== path) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    assertInside(project, real);
    try {
      const text = await readTextInside(project, join(real, 'run.json'), 'VERIFY_REPORT_INVALID');
      reports.push({directory: real, summary: parseSummaryText(text, name)});
    } catch (error) {
      if (error instanceof Refusal && error.code === 'VERIFY_PATH_FORBIDDEN') throw error;
      if (error instanceof Refusal && error.code !== 'VERIFY_REPORT_INVALID') throw error;
      corrupt.push(name);
    }
  }
  reports.sort((a, b) => a.summary.directoryName.localeCompare(b.summary.directoryName) || a.summary.id.localeCompare(b.summary.id));
  corrupt.sort((a, b) => a.localeCompare(b));
  return {reports, corrupt};
}

async function findReport(dataDirectory: string, projectId: string, runId: string): Promise<{directory: string; summary: ReportSummary}> {
  assertSafeSegment(projectId);
  assertSafeSegment(runId);
  const project = await resolveProject(dataDirectory, projectId);
  if (!project) throw new Refusal('VERIFY_REPORT_NOT_FOUND', 404);
  const found = (await loadReports(project)).reports.filter(item => item.summary.id === runId);
  if (found.length === 0) throw new Refusal('VERIFY_REPORT_NOT_FOUND', 404);
  if (found.length > 1) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  return found[0];
}

export async function reserveSecurityReportDirectory(input: {
  dataDirectory: string; projectId: string; runId: string; createdAt: Date;
}): Promise<{directory: string; directoryName: string}> {
  assertSafeSegment(input.projectId);
  assertSafeSegment(input.runId);
  const directoryName = directoryNameOf(input.createdAt, input.runId);
  const dataReal = await requireDataDirectory(input.dataDirectory);
  const root = await ensureDir(dataReal, 'verificacoes');
  const project = await ensureDir(root, input.projectId);
  const directory = await createReportDir(project, directoryName);
  return {directory, directoryName};
}

export async function writeSecurityReport(input: {
  dataDirectory: string; projectId: string; runId: string; createdAt: Date; commit: string;
  mapMarkdown: string; coverage: CoverageRow[]; achados: Achado[]; raw: unknown; note: string;
  directoryName?: string;
}): Promise<{directory: string; directoryName: string}> {
  assertSafeSegment(input.projectId);
  assertSafeSegment(input.runId);
  const rawBody = serializedRaw(input.raw);
  const achados = parseAchados(input.achados);
  const coverage = parseCoverage(input.coverage);
  const givenName = input.directoryName;
  const reserved = typeof givenName === 'string';
  const directoryName = reserved ? givenName : directoryNameOf(input.createdAt, input.runId);
  if (!REPORT_DIRECTORY.test(directoryName)) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const counts = failureCounts(achados);
  const summaryParsed = ReportSummary.safeParse({
    id: input.runId,
    directoryName,
    createdAt: input.createdAt.toISOString(),
    counts,
    note: input.note,
  });
  if (!summaryParsed.success) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const summary = summaryParsed.data;
  const discarded = achados.filter(item => item.status === 'descartado').length;
  const planned: {segments: string[]; body: string}[] = [
    {segments: ['README.md'], body: guard(readme({
      runId: summary.id,
      directoryName,
      createdAt: input.createdAt,
      commit: input.commit,
      note: input.note,
      total: achados.length,
      counts,
      discarded,
    }))},
    {segments: ['mapa.md'], body: guard(input.mapMarkdown)},
    {segments: ['cobertura.md'], body: guard(coverageMarkdown(coverage))},
    {segments: ['achados.json'], body: guard(`${JSON.stringify({achados}, null, 2)}\n`)},
    ...achados.map(achado => ({segments: ['achados', `${achado.id}.md`], body: guard(achadoMarkdown(achado))})),
    {segments: ['bruto', 'achados-brutos.json'], body: rawBody},
    {segments: ['run.json'], body: guard(`${JSON.stringify(summary, null, 2)}\n`)},
  ];
  for (const file of planned) {
    for (const segment of file.segments) assertSafeSegment(segment);
    if (file.segments[0] === 'achados' && file.segments.length === 2 && !ACHADO_FILE.test(file.segments[1])) {
      throw new Refusal('VERIFY_REPORT_INVALID', 400);
    }
  }
  const dataReal = await requireDataDirectory(input.dataDirectory);
  const root = await ensureDir(dataReal, 'verificacoes');
  const project = await ensureDir(root, input.projectId);
  const directory = reserved ? await ensureDir(project, directoryName) : await createReportDir(project, directoryName);
  await ensureDir(directory, 'achados');
  await ensureDir(directory, 'bruto');
  for (const file of planned) {
    const path = file.segments.reduce((parent, segment) => {
      const next = join(parent, segment);
      assertInside(directory, next);
      return next;
    }, directory);
    await writePrivate(path, directory, file.body);
  }
  return {directory, directoryName};
}

export async function inspectSecurityReports(dataDirectory: string, projectId: string): Promise<{reports: ReportSummary[]; corrupt: string[]}> {
  const project = await resolveProject(dataDirectory, projectId);
  if (!project) return {reports: [], corrupt: []};
  const loaded = await loadReports(project);
  return {reports: loaded.reports.map(item => item.summary), corrupt: loaded.corrupt};
}

export async function listSecurityReports(dataDirectory: string, projectId: string): Promise<ReportSummary[]> {
  return (await inspectSecurityReports(dataDirectory, projectId)).reports;
}

export async function readSecurityReport(dataDirectory: string, projectId: string, runId: string): Promise<{summary: ReportSummary; achados: Achado[]; coverageMarkdown: string}> {
  const report = await findReport(dataDirectory, projectId, runId);
  const achados = parseAchadosFile(await readTextInside(report.directory, join(report.directory, 'achados.json'), 'VERIFY_REPORT_INVALID'));
  const coverageMarkdown = await readTextInside(report.directory, join(report.directory, 'cobertura.md'), 'VERIFY_REPORT_INVALID');
  return {summary: report.summary, achados, coverageMarkdown};
}

async function removeContainedDirectory(project: string, target: string): Promise<void> {
  const lexical = resolve(target);
  assertInside(project, lexical);
  let info;
  try {
    info = await lstat(lexical);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    if (isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    throw error;
  }
  if (info.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  if (!info.isDirectory()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const real = await realpath(lexical);
  if (real !== lexical) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  assertInside(project, real);
  await rm(real, {recursive: true});
}

/** Drop the report directory for this run and the raw tool directory that belongs to it. */
export async function removeSecurityReport(dataDirectory: string, projectId: string, runId: string): Promise<void> {
  assertSafeSegment(projectId);
  assertSafeSegment(runId);
  const project = await resolveProject(dataDirectory, projectId);
  if (!project) return;
  await removeContainedDirectory(project, join(project, 'ferramentas', runId));
  let directory: string | undefined;
  try {
    directory = (await findReport(dataDirectory, projectId, runId)).directory;
  } catch (error) {
    if (error instanceof Refusal && error.code === 'VERIFY_REPORT_NOT_FOUND') return;
    throw error;
  }
  await removeContainedDirectory(project, directory);
}

export async function readAchadoMarkdown(dataDirectory: string, projectId: string, runId: string, achadoId: string): Promise<string> {
  assertSafeSegment(achadoId);
  if (!/^ACH-\d{3}$/.test(achadoId)) throw new Refusal('VERIFY_ACHADO_NOT_FOUND', 404);
  const report = await findReport(dataDirectory, projectId, runId);
  return readTextInside(report.directory, join(report.directory, 'achados', `${achadoId}.md`), 'VERIFY_ACHADO_NOT_FOUND');
}
