import {constants, type Stats} from 'node:fs';
import {chmod, lstat, mkdir, open, readFile, readdir, realpath, type FileHandle} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {Refusal} from './contracts.ts';
import {DESIGN_IMAGE, DESIGN_NETWORK, DESIGN_USER, designRunArguments, type DesignRunInput} from './design-image.ts';
import {captureProof} from './design-mark.ts';
import {DesignAchado, DesignCoverageRow, DesignReportSummary} from './design-types.ts';

const REPORT_DIRECTORY = /^\d{8}-\d{6}-design$/;
const ACHADO_FILE = /^ACH-\d{3}\.md$/;
const EXTRA_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:md|json)$/;
const SECTION_TITLE = /^[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9 ._-]{0,80}$/;
const LIVE_ACCESS_KEY = /AKIA[0-9A-Z]{16}/;
const MAX_CAPTURE_BYTES = 128 * 1024 * 1024;
const WRITE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const READ_OWN = constants.O_RDONLY | constants.O_NOFOLLOW;

const SEVERITY_LABEL: Record<DesignAchado['severity'], string> = {
  alta: 'alta',
  media: 'média',
  baixa: 'baixa',
  informativa: 'informativa',
};

const STATUS_LABEL: Record<DesignAchado['status'], string> = {
  confirmado: 'confirmado',
  provavel: 'provável',
  descartado: 'descartado',
  fechado: 'fechado',
  reaberto: 'reaberto',
};

export type DesignReportCapture = {fileName: string; bytes: Buffer};

export type DesignReportEmptyState = {
  route: string;
  status: 'capturado' | 'ausente' | 'nao-capturado';
};

export type DesignReportWriteInput = {
  dataDirectory: string;
  projectId: string;
  runId: string;
  createdAt: Date;
  commit: string;
  mapMarkdown: string;
  coverage: readonly DesignCoverageRow[];
  achados: readonly DesignAchado[];
  raw: unknown;
  note: string;
  captures?: readonly DesignReportCapture[];
  /** "capturado" ou "não deu", quando o chamador só tem um resultado. */
  emptyState?: 'capturado' | 'não deu';
  emptyStates?: readonly DesignReportEmptyState[];
  /** Seções extras no README. Ausentes, o texto antigo permanece. */
  sections?: readonly {title: string; markdown: string}[];
  /** Arquivos extras na raiz do relatório, modo 0600. */
  files?: readonly {name: string; body: string}[];
};

function hasLiveAccessKey(text: string): boolean {
  return LIVE_ACCESS_KEY.test(text);
}

function assertNoLiveAccessKey(value: unknown): void {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (hasLiveAccessKey(current)) throw new Refusal('DESIGN_SECRET_IN_REPORT', 400);
      continue;
    }
    if (current === null || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Buffer.isBuffer(current)) {
      if (hasLiveAccessKey(current.toString('latin1'))) throw new Refusal('DESIGN_SECRET_IN_REPORT', 400);
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (hasLiveAccessKey(key)) throw new Refusal('DESIGN_SECRET_IN_REPORT', 400);
      pending.push(item);
    }
  }
}

function guard(text: string): string {
  if (hasLiveAccessKey(text)) throw new Refusal('DESIGN_SECRET_IN_REPORT', 400);
  return text;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function assertSafeSegment(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240 || value === '.' || value === '..' || value.includes('..') || value.includes('/') || value.includes('\\') || value.includes('\0') || isAbsolute(value)) {
    throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  }
}

function assertInside(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
}

function directoryNameOf(createdAt: Date): string {
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  const pad = (value: number, width = 2) => value.toString().padStart(width, '0');
  const name = `${pad(createdAt.getUTCFullYear(), 4)}${pad(createdAt.getUTCMonth() + 1)}${pad(createdAt.getUTCDate())}-${pad(createdAt.getUTCHours())}${pad(createdAt.getUTCMinutes())}${pad(createdAt.getUTCSeconds())}-design`;
  if (!REPORT_DIRECTORY.test(name)) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  return name;
}

function parseAchados(value: readonly DesignAchado[]): DesignAchado[] {
  if (!Array.isArray(value)) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  const ids = new Set<string>();
  return value.map(item => {
    const parsed = DesignAchado.safeParse(item);
    if (!parsed.success) throw new Refusal('DESIGN_REPORT_INVALID', 400);
    if (ids.has(parsed.data.id)) throw new Refusal('DESIGN_REPORT_INVALID', 400);
    ids.add(parsed.data.id);
    return parsed.data;
  });
}

function parseCoverage(value: readonly DesignCoverageRow[]): DesignCoverageRow[] {
  if (!Array.isArray(value)) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  return value.map(item => {
    const parsed = DesignCoverageRow.safeParse(item);
    if (!parsed.success) throw new Refusal('DESIGN_REPORT_INVALID', 400);
    return parsed.data;
  });
}

function failureCounts(achados: readonly DesignAchado[]): DesignReportSummary['counts'] {
  const counts = {alta: 0, media: 0, baixa: 0, informativa: 0};
  for (const achado of achados) {
    if (achado.status === 'confirmado' || achado.status === 'reaberto') counts[achado.severity] += 1;
  }
  return counts;
}

function pt(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function failureNote(counts: DesignReportSummary['counts']): string {
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

function achadoMarkdown(achado: DesignAchado): string {
  const where = achado.where.line === null ? achado.where.file : `${achado.where.file}:${achado.where.line}`;
  const measured = achado.verifier === null && achado.sources.includes('medida');
  const situacao = achado.verifier
    ? `${STATUS_LABEL[achado.status]} (verificador: ${achado.verifier.model}, ${achado.verifier.provider})`
    : measured
      ? `${STATUS_LABEL[achado.status]} (medido)`
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
  return value.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

function coverageMarkdown(rows: readonly DesignCoverageRow[]): string {
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

const PROBE_RUN: Omit<DesignRunInput, 'memoryBytes' | 'nanoCpus' | 'pidsLimit'> = {
  image: DESIGN_IMAGE,
  repository: '/var/lib/design/repo',
  output: '/var/lib/design/out',
  targetUrl: 'http://127.0.0.1:9/',
  network: DESIGN_NETWORK,
};

type LimitPoint = {memoryBytes: number; nanoCpus: number; pidsLimit: number};

function parseEmptyState(value: unknown): 'capturado' | 'não deu' | undefined {
  if (value === undefined) return undefined;
  if (value === 'capturado' || value === 'não deu') return value;
  throw new Refusal('DESIGN_REPORT_INVALID', 400);
}

function powerScale(): number[] {
  const values: number[] = [];
  let value = 1;
  while (values.length < 60 && value <= Number.MAX_SAFE_INTEGER / 4) {
    values.push(value);
    value *= 2;
  }
  return values;
}

function outward(values: readonly number[]): number[] {
  const mid = Math.floor(values.length / 2);
  const ordered = [values[mid]];
  for (let step = 1; ordered.length < values.length; step++) {
    if (mid - step >= 0) ordered.push(values[mid - step]);
    if (mid + step < values.length) ordered.push(values[mid + step]);
  }
  return ordered;
}

function runWithinLimits(memoryBytes: number, nanoCpus: number, pidsLimit: number): readonly string[] | null {
  if (!Number.isSafeInteger(memoryBytes) || !Number.isSafeInteger(nanoCpus) || !Number.isSafeInteger(pidsLimit)) return null;
  if (memoryBytes < 1 || nanoCpus < 1 || pidsLimit < 1) return null;
  try {
    return designRunArguments({...PROBE_RUN, memoryBytes, nanoCpus, pidsLimit});
  } catch (error) {
    if (error instanceof Refusal && error.code === 'DESIGN_LIMITS_INVALID') return null;
    throw error;
  }
}

function argumentOf(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.startsWith('--')) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  return value;
}

function findLimitSeed(): LimitPoint {
  const samples = outward(powerScale());
  for (const memoryBytes of samples) {
    for (const nanoCpus of samples) {
      for (const pidsLimit of samples) {
        if (runWithinLimits(memoryBytes, nanoCpus, pidsLimit)) return {memoryBytes, nanoCpus, pidsLimit};
      }
    }
  }
  throw new Refusal('DESIGN_REPORT_INVALID', 400);
}

function lowestAccepted(ok: (value: number) => boolean, accepted: number): number {
  let lo = 0;
  let hi = accepted;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

function highestAccepted(ok: (value: number) => boolean, accepted: number): number {
  const top = Number.MAX_SAFE_INTEGER;
  if (ok(top)) return top;
  let lo = accepted;
  let hi = top;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

function imageUserIsRoot(user: string): boolean {
  return user.split(':').some(part => part === '0' || part.toLowerCase() === 'root');
}

type ImageProof = {
  user: string;
  memoryMin: string;
  memoryMax: string;
  pidsMin: string;
  pidsMax: string;
  cpuMin: string;
  cpuMax: string;
  network: string;
};

let cachedImageProof: ImageProof | null = null;

function imageProof(): ImageProof {
  if (cachedImageProof) return cachedImageProof;
  const seed = findLimitSeed();
  const memoryMin = lowestAccepted(value => runWithinLimits(value, seed.nanoCpus, seed.pidsLimit) !== null, seed.memoryBytes);
  const memoryMax = highestAccepted(value => runWithinLimits(value, seed.nanoCpus, seed.pidsLimit) !== null, seed.memoryBytes);
  const pidsMin = lowestAccepted(value => runWithinLimits(seed.memoryBytes, seed.nanoCpus, value) !== null, seed.pidsLimit);
  const pidsMax = highestAccepted(value => runWithinLimits(seed.memoryBytes, seed.nanoCpus, value) !== null, seed.pidsLimit);
  const cpuMin = lowestAccepted(value => runWithinLimits(seed.memoryBytes, value, seed.pidsLimit) !== null, seed.nanoCpus);
  const cpuMax = highestAccepted(value => runWithinLimits(seed.memoryBytes, value, seed.pidsLimit) !== null, seed.nanoCpus);
  const outside = (value: number, kind: 'memory' | 'pids' | 'cpu'): boolean => {
    if (!Number.isSafeInteger(value) || value < 1) return false;
    if (kind === 'memory') return runWithinLimits(value, seed.nanoCpus, seed.pidsLimit) !== null;
    if (kind === 'pids') return runWithinLimits(seed.memoryBytes, seed.nanoCpus, value) !== null;
    return runWithinLimits(seed.memoryBytes, value, seed.pidsLimit) !== null;
  };
  if (outside(memoryMin - 1, 'memory') || outside(memoryMax + 1, 'memory')) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  if (outside(pidsMin - 1, 'pids') || outside(pidsMax + 1, 'pids')) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  if (outside(cpuMin - 1, 'cpu') || outside(cpuMax + 1, 'cpu')) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  const memoryAtMin = runWithinLimits(memoryMin, seed.nanoCpus, seed.pidsLimit);
  const memoryAtMax = runWithinLimits(memoryMax, seed.nanoCpus, seed.pidsLimit);
  const pidsAtMin = runWithinLimits(seed.memoryBytes, seed.nanoCpus, pidsMin);
  const pidsAtMax = runWithinLimits(seed.memoryBytes, seed.nanoCpus, pidsMax);
  const cpuAtMin = runWithinLimits(seed.memoryBytes, cpuMin, seed.pidsLimit);
  const cpuAtMax = runWithinLimits(seed.memoryBytes, cpuMax, seed.pidsLimit);
  if (!memoryAtMin || !memoryAtMax || !pidsAtMin || !pidsAtMax || !cpuAtMin || !cpuAtMax) {
    throw new Refusal('DESIGN_REPORT_INVALID', 400);
  }
  const user = argumentOf(memoryAtMin, '--user');
  const network = argumentOf(memoryAtMin, '--network');
  if (user !== DESIGN_USER || argumentOf(cpuAtMax, '--user') !== DESIGN_USER || imageUserIsRoot(user)) {
    throw new Refusal('DESIGN_REPORT_INVALID', 400);
  }
  if (network !== DESIGN_NETWORK || argumentOf(cpuAtMax, '--network') !== DESIGN_NETWORK) {
    throw new Refusal('DESIGN_REPORT_INVALID', 400);
  }
  if (memoryAtMin.filter(item => item === '--network').length !== 1) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  try {
    designRunArguments({
      ...PROBE_RUN,
      network: `${DESIGN_NETWORK}-extra`,
      memoryBytes: seed.memoryBytes,
      nanoCpus: seed.nanoCpus,
      pidsLimit: seed.pidsLimit,
    });
    throw new Refusal('DESIGN_REPORT_INVALID', 400);
  } catch (error) {
    if (!(error instanceof Refusal) || error.code !== 'DESIGN_NETWORK_FORBIDDEN') throw error;
  }
  const memoryLow = argumentOf(memoryAtMin, '--memory');
  const memoryHigh = argumentOf(memoryAtMax, '--memory');
  if (memoryLow !== argumentOf(memoryAtMin, '--memory-swap') || memoryHigh !== argumentOf(memoryAtMax, '--memory-swap')) {
    throw new Refusal('DESIGN_REPORT_INVALID', 400);
  }
  if (memoryLow !== String(memoryMin) || memoryHigh !== String(memoryMax)) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  const pidsLow = argumentOf(pidsAtMin, '--pids-limit');
  const pidsHigh = argumentOf(pidsAtMax, '--pids-limit');
  if (pidsLow !== String(pidsMin) || pidsHigh !== String(pidsMax)) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  cachedImageProof = {
    user,
    memoryMin: memoryLow,
    memoryMax: memoryHigh,
    pidsMin: pidsLow,
    pidsMax: pidsHigh,
    cpuMin: argumentOf(cpuAtMin, '--cpus'),
    cpuMax: argumentOf(cpuAtMax, '--cpus'),
    network,
  };
  return cachedImageProof;
}

function imageProofText(): string {
  const proof = imageProof();
  return `O usuário da imagem é ${proof.user} e não é root. Os limites são memória de ${proof.memoryMin} a ${proof.memoryMax} bytes, pids de ${proof.pidsMin} a ${proof.pidsMax} e CPU de ${proof.cpuMin} a ${proof.cpuMax}. A única rede é ${proof.network}.`;
}

function readme(input: {
  runId: string;
  directoryName: string;
  createdAt: Date;
  commit: string;
  note: string;
  total: number;
  counts: DesignReportSummary['counts'];
  discarded: number;
  emptyState?: 'capturado' | 'não deu';
  emptyStates?: readonly DesignReportEmptyState[];
  sections?: readonly {title: string; markdown: string}[];
}): string {
  const failing = input.counts.alta + input.counts.media + input.counts.baixa + input.counts.informativa;
  const lines = [
    '# Relatório de verificação de design',
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
    '## Prova da imagem',
    '',
    imageProofText(),
    '',
    designImageArgumentText().trimEnd(),
    '',
    '## O que não foi possível verificar',
    '',
    input.note,
    '',
    emptyStateBody(input.emptyState, input.emptyStates).trimEnd(),
    '',
  ];
  for (const section of input.sections ?? []) {
    lines.push(`## ${section.title}`, '', section.markdown.trimEnd(), '');
  }
  return lines.join('\n');
}

function emptyStateBody(
  singular: 'capturado' | 'não deu' | undefined,
  records: readonly DesignReportEmptyState[] | undefined,
): string {
  if (singular !== undefined && (records === undefined || records.length === 0)) {
    return `## Estado vazio\n\n${singular}\n`;
  }
  return emptyStateSection(records);
}

function emptyStateSection(records: readonly DesignReportEmptyState[] | undefined): string {
  if (records === undefined || records.length === 0) {
    return '## Estado vazio\n\nNão houve registro de estado vazio: a captura não aconteceu.\n';
  }
  const lines = records.map(record => `- ${record.route}: ${emptyStateLabel(record.status)}`);
  return ['## Estado vazio', '', ...lines, ''].join('\n');
}

function emptyStateLabel(status: DesignReportEmptyState['status']): string {
  if (status === 'capturado') return 'capturado';
  if (status === 'ausente') return 'ausente';
  return 'não capturado';
}

function designImageArgumentText(): string {
  const args = designRunArguments({
    image: DESIGN_IMAGE,
    repository: '/var/lib/design/repo',
    output: '/var/lib/design/out',
    targetUrl: 'http://127.0.0.1:4173',
    memoryBytes: 512 * 1024 * 1024,
    nanoCpus: 1_000_000_000,
    pidsLimit: 128,
    network: DESIGN_NETWORK,
  });
  return [
    '## Imagem de design',
    '',
    'O relatório não executou o contêiner. A lista é o que designRunArguments usaria.',
    `Usuário ${DESIGN_USER}, sem root. Rede somente ${DESIGN_NETWORK}.`,
    'A função já recusa outra rede e aplica somente leitura, cap-drop ALL, no-new-privileges e os limites de memória, pids e cpus.',
    '',
    args.join(' '),
    '',
  ].join('\n');
}

function serializedRaw(raw: unknown): string {
  assertNoLiveAccessKey(raw);
  let body: string;
  try {
    body = JSON.stringify(raw, null, 2);
  } catch {
    throw new Refusal('DESIGN_REPORT_INVALID', 400);
  }
  if (typeof body !== 'string') throw new Refusal('DESIGN_REPORT_INVALID', 400);
  return guard(`${body}\n`);
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
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  await chmod(path, 0o700);
  const after = await lstat(path);
  if (after.isSymbolicLink() || !after.isDirectory() || (after.mode & 0o777) !== 0o700) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  const real = await realpath(path);
  if (real !== path) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  assertInside(parentReal, real);
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
    if (existing.isSymbolicLink()) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    throw new Refusal('DESIGN_REPORT_EXISTS', 409);
  }
  await chmod(path, 0o700);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  const real = await realpath(path);
  if (real !== path) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  assertInside(parentReal, real);
  return path;
}

async function writePrivate(path: string, root: string, content: string | Buffer): Promise<void> {
  const lexical = resolve(path);
  assertInside(root, lexical);
  let handle: FileHandle;
  try {
    handle = await open(lexical, WRITE_NEW, 0o600);
  } catch (error) {
    if (isErrno(error, 'EEXIST') || isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    throw error;
  }
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  await chmod(lexical, 0o600);
  const info = await lstat(lexical);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  const real = await realpath(lexical);
  if (real !== lexical) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  assertInside(root, real);
}

async function requireDataDirectory(dataDirectory: string): Promise<string> {
  try {
    const info = await lstat(dataDirectory);
    if (!info.isDirectory() && !info.isSymbolicLink()) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    const real = await realpath(dataDirectory);
    const realInfo = await lstat(real);
    if (!realInfo.isDirectory() || realInfo.isSymbolicLink()) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    return real;
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
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
    if (isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    throw error;
  }
  const root = join(dataReal, 'verificacoes');
  let rootInfo: Stats;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  const rootReal = await realpath(root);
  if (rootReal !== root) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  const project = join(rootReal, projectId);
  assertInside(rootReal, project);
  let info: Stats;
  try {
    info = await lstat(project);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    if (isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  const real = await realpath(project);
  if (real !== project) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  assertInside(rootReal, real);
  return real;
}

async function readTextInside(root: string, path: string, missingCode: 'DESIGN_REPORT_INVALID'): Promise<string> {
  const lexical = resolve(path);
  assertInside(root, lexical);
  let info: Stats;
  try {
    info = await lstat(lexical);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new Refusal(missingCode, 400);
    if (isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  const real = await realpath(lexical);
  if (real !== lexical) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  assertInside(root, real);
  let handle: FileHandle;
  try {
    handle = await open(real, READ_OWN);
  } catch (error) {
    if (isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR') || isErrno(error, 'EEXIST')) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    throw error;
  }
  try {
    return await handle.readFile({encoding: 'utf8'});
  } finally {
    await handle.close();
  }
}

function parseSummaryText(text: string, directoryName: string): DesignReportSummary {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refusal('DESIGN_REPORT_INVALID', 400);
  }
  const parsed = DesignReportSummary.safeParse(body);
  if (!parsed.success || parsed.data.directoryName !== directoryName) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  return parsed.data;
}

function parseAchadosFile(text: string): DesignAchado[] {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refusal('DESIGN_REPORT_INVALID', 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !('achados' in body)) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  const list = (body as {achados: unknown}).achados;
  if (!Array.isArray(list)) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  return list.map(item => {
    const parsed = DesignAchado.safeParse(item);
    if (!parsed.success) throw new Refusal('DESIGN_REPORT_INVALID', 400);
    return parsed.data;
  });
}

async function loadReports(project: string): Promise<{directory: string; summary: DesignReportSummary}[]> {
  const found: {directory: string; summary: DesignReportSummary}[] = [];
  for (const name of await readdir(project)) {
    if (!REPORT_DIRECTORY.test(name)) continue;
    const path = join(project, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    if (!info.isDirectory()) continue;
    const real = await realpath(path);
    if (real !== path) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    assertInside(project, real);
    const summary = parseSummaryText(await readTextInside(project, join(real, 'run.json'), 'DESIGN_REPORT_INVALID'), name);
    found.push({directory: real, summary});
  }
  found.sort((a, b) => a.summary.directoryName.localeCompare(b.summary.directoryName) || a.summary.id.localeCompare(b.summary.id));
  return found;
}

async function findReport(dataDirectory: string, projectId: string, runId: string): Promise<{directory: string; summary: DesignReportSummary}> {
  assertSafeSegment(projectId);
  assertSafeSegment(runId);
  const project = await resolveProject(dataDirectory, projectId);
  if (!project) throw new Refusal('DESIGN_REPORT_NOT_FOUND', 404);
  const found = (await loadReports(project)).filter(item => item.summary.id === runId);
  if (found.length === 0) throw new Refusal('DESIGN_REPORT_NOT_FOUND', 404);
  if (found.length > 1) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  return found[0];
}

function capturePlans(captures: readonly DesignReportCapture[] | undefined): {segments: string[]; body: Buffer}[] {
  if (captures === undefined) return [];
  if (!Array.isArray(captures)) throw new Refusal('DESIGN_REPORT_INVALID', 400);
  const names = new Set<string>();
  return captures.map(capture => {
    if (capture === null || typeof capture !== 'object' || typeof capture.fileName !== 'string' || !Buffer.isBuffer(capture.bytes)) {
      throw new Refusal('DESIGN_REPORT_INVALID', 400);
    }
    if (capture.bytes.length > MAX_CAPTURE_BYTES) throw new Refusal('DESIGN_REPORT_INVALID', 400);
    const proof = captureProof(capture.fileName);
    const fileName = proof.slice('capturas/'.length);
    if (names.has(fileName)) throw new Refusal('DESIGN_REPORT_INVALID', 400);
    names.add(fileName);
    assertNoLiveAccessKey(fileName);
    assertNoLiveAccessKey(capture.bytes);
    return {segments: ['capturas', fileName], body: capture.bytes};
  });
}

export async function writeDesignReport(input: DesignReportWriteInput): Promise<{directory: string; directoryName: string}> {
  assertSafeSegment(input.projectId);
  assertSafeSegment(input.runId);
  if (typeof input.commit !== 'string' || typeof input.mapMarkdown !== 'string' || typeof input.note !== 'string') {
    throw new Refusal('DESIGN_REPORT_INVALID', 400);
  }
  const emptyState = parseEmptyState(input.emptyState);
  const sections = (input.sections ?? []).map(section => {
    if (!section || typeof section.title !== 'string' || !SECTION_TITLE.test(section.title) || typeof section.markdown !== 'string') {
      throw new Refusal('DESIGN_REPORT_INVALID', 400);
    }
    return {title: section.title, markdown: section.markdown};
  });
  const extras = (input.files ?? []).map(file => {
    if (!file || typeof file.name !== 'string' || !EXTRA_FILE.test(file.name) || typeof file.body !== 'string') {
      throw new Refusal('DESIGN_REPORT_INVALID', 400);
    }
    return {name: file.name, body: file.body};
  });
  assertNoLiveAccessKey({
    commit: input.commit,
    mapMarkdown: input.mapMarkdown,
    note: input.note,
    achados: input.achados,
    coverage: input.coverage,
    raw: input.raw,
    sections,
    extras,
  });
  const rawBody = serializedRaw(input.raw);
  const achados = parseAchados(input.achados);
  const coverage = parseCoverage(input.coverage);
  const captures = capturePlans(input.captures);
  const directoryName = directoryNameOf(input.createdAt);
  const counts = failureCounts(achados);
  const summaryParsed = DesignReportSummary.safeParse({
    id: input.runId,
    directoryName,
    createdAt: input.createdAt.toISOString(),
    counts,
    note: input.note,
  });
  if (!summaryParsed.success) throw new Refusal('DESIGN_REPORT_INVALID', 400);
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
      emptyState,
      emptyStates: input.emptyStates,
      sections,
    }))},
    {segments: ['mapa.md'], body: guard(input.mapMarkdown)},
    {segments: ['cobertura.md'], body: guard(coverageMarkdown(coverage))},
    {segments: ['achados.json'], body: guard(`${JSON.stringify({achados}, null, 2)}\n`)},
    ...achados.map(achado => ({segments: ['achados', `${achado.id}.md`], body: guard(achadoMarkdown(achado))})),
    {segments: ['bruto', 'achados-brutos.json'], body: rawBody},
    {segments: ['run.json'], body: guard(`${JSON.stringify(summary, null, 2)}\n`)},
    ...extras.map(file => ({segments: [file.name], body: guard(file.body.endsWith('\n') ? file.body : `${file.body}\n`)})),
  ];
  for (const file of planned) {
    for (const segment of file.segments) assertSafeSegment(segment);
    if (file.segments[0] === 'achados' && file.segments.length === 2 && !ACHADO_FILE.test(file.segments[1])) {
      throw new Refusal('DESIGN_REPORT_INVALID', 400);
    }
  }
  for (const file of captures) {
    for (const segment of file.segments) assertSafeSegment(segment);
  }
  const dataReal = await requireDataDirectory(input.dataDirectory);
  const root = await ensureDir(dataReal, 'verificacoes');
  const project = await ensureDir(root, input.projectId);
  const directory = await createReportDir(project, directoryName);
  await ensureDir(directory, 'achados');
  await ensureDir(directory, 'bruto');
  await ensureDir(directory, 'capturas');
  for (const file of planned) {
    const path = file.segments.reduce((parent, segment) => {
      const next = join(parent, segment);
      assertInside(directory, next);
      return next;
    }, directory);
    await writePrivate(path, directory, file.body);
  }
  for (const file of captures) {
    const path = file.segments.reduce((parent, segment) => {
      const next = join(parent, segment);
      assertInside(directory, next);
      return next;
    }, directory);
    await writePrivate(path, directory, file.body);
  }
  return {directory, directoryName};
}

export async function readDesignCaptureFiles(dataDirectory: string, projectId: string, runId: string): Promise<{fileName: string; bytes: Buffer}[]> {
  const report = await findReport(dataDirectory, projectId, runId);
  const directory = join(report.directory, 'capturas');
  const names = await readdir(directory).catch(() => [] as string[]);
  const files: {fileName: string; bytes: Buffer}[] = [];
  for (const fileName of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,140}\.png$/.test(fileName) || fileName.startsWith('diff-')) continue;
    files.push({fileName, bytes: await readFile(join(directory, fileName))});
  }
  return files;
}

export async function readDesignReport(dataDirectory: string, projectId: string, runId: string): Promise<{summary: DesignReportSummary; achados: DesignAchado[]; coverageMarkdown: string}> {
  const report = await findReport(dataDirectory, projectId, runId);
  const achados = parseAchadosFile(await readTextInside(report.directory, join(report.directory, 'achados.json'), 'DESIGN_REPORT_INVALID'));
  const coverageText = await readTextInside(report.directory, join(report.directory, 'cobertura.md'), 'DESIGN_REPORT_INVALID');
  return {summary: report.summary, achados, coverageMarkdown: coverageText};
}
