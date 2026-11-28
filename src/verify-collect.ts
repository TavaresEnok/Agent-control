import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, open, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {normalizeToolOutput} from './verify-normalize.ts';
import {redactJsonDocument, redactUnknownSecrets} from './verify-redact.ts';
import {RawFinding, ToolResult, type ToolState} from './verify-types.ts';

const MAX_EXAM_FILE_BYTES = 50 * 1024 * 1024;

/**
 * What each exam tool is expected to leave behind, and what its exit code means. `clean` codes mean the run finished and the
 * report speaks for itself; `findings` codes mean the tool itself says it found something, so the report must carry findings.
 * Any other code is an error, never a clean run. 127 is "binary missing" for every tool (osv-scanner also uses it for a general error).
 * `optionalReport` tools write nothing when there is nothing to scan; a missing file then stays a clean run with a stated reason.
 */
type ToolSpec = {
  name: string;
  tool: string;
  file: string;
  clean: readonly number[];
  findings: readonly number[];
  /** Exit code that means "no package found" and writes no report. */
  noTarget?: readonly number[];
  optionalReport?: boolean;
  /** Parsed into findings. SBOM output is kept but not parsed. */
  parsed: boolean;
};

/** Names the exam entrypoint writes. Only these basenames are read. */
const TOOL_SPECS: readonly ToolSpec[] = [
  {name: 'gitleaks', tool: 'gitleaks', file: 'gitleaks.json', clean: [0], findings: [], parsed: true},
  {name: 'osv-scanner', tool: 'osv-scanner', file: 'osv.json', clean: [0], findings: [1], noTarget: [128], parsed: true},
  {name: 'syft', tool: 'syft', file: 'syft.cdx.json', clean: [0], findings: [], parsed: false},
  {name: 'grype', tool: 'grype', file: 'grype.json', clean: [0], findings: [], parsed: true},
  {name: 'opengrep', tool: 'opengrep', file: 'opengrep.json', clean: [0], findings: [], parsed: true},
  {name: 'hadolint', tool: 'hadolint', file: 'hadolint.json', clean: [0], findings: [], parsed: true},
  {name: 'trivy-config', tool: 'trivy', file: 'trivy-config.json', clean: [0], findings: [], parsed: true},
  {name: 'trivy-fs', tool: 'trivy', file: 'trivy-fs.json', clean: [0], findings: [], parsed: true},
  {name: 'checkov', tool: 'checkov', file: 'results_json.json', clean: [0], findings: [], optionalReport: true, parsed: true},
];

function examFilePath(root: string, name: string): string | null {
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  const path = join(root, name);
  const rel = relative(root, path);
  if (rel !== name || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return path;
}

/** Regular file only. A symlink or an oversized file is rejected and not read. */
async function readRegularExam(path: string): Promise<string | null> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_EXAM_FILE_BYTES) return null;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const opened = await handle.stat();
    if (opened.isSymbolicLink() || !opened.isFile() || opened.size > MAX_EXAM_FILE_BYTES) return null;
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const {bytesRead} = await handle.read(bytes, offset, opened.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_EXAM_FILE_BYTES) return null;
    return bytes.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Redact before the finding is built, then replace the file without following a symlink. */
async function rewriteRedactedExam(path: string, text: string): Promise<string | null> {
  const redacted = redactJsonDocument(text) ?? redactUnknownSecrets(text);
  if (redacted === text) return text;
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) return null;
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, redacted, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
    await chmod(temporary, 0o600);
    const again = await lstat(path);
    if (again.isSymbolicLink() || !again.isFile()) return null;
    await rename(temporary, path);
    await chmod(path, 0o600);
    const written = await lstat(path);
    if (written.isSymbolicLink() || !written.isFile() || (written.mode & 0o777) !== 0o600) return null;
    return redacted;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return null;
    throw error;
  } finally {
    await rm(temporary, {force: true});
  }
}

async function readCode(root: string, name: string, present: ReadonlySet<string>): Promise<number | null> {
  const file = `${name}.code`;
  if (!present.has(file)) return null;
  const path = examFilePath(root, file);
  if (!path) return null;
  try {
    const text = await readRegularExam(path);
    if (text === null) return null;
    const trimmed = text.trim();
    return /^-?\d{1,5}$/.test(trimmed) ? Number(trimmed) : null;
  } catch { return null; }
}

async function readVersion(root: string, name: string, present: ReadonlySet<string>): Promise<string | null> {
  const file = `${name}.version`;
  if (!present.has(file)) return null;
  const path = examFilePath(root, file);
  if (!path) return null;
  try {
    const text = await readRegularExam(path);
    const line = text?.split('\n').map(item => item.trim()).find(item => item.length > 0);
    return line ? redactUnknownSecrets(line).slice(0, 200) : null;
  } catch { return null; }
}

/** Size of the original stdout and the redacted tail of stderr. The files themselves stay in the output folder. */
async function sideOutput(root: string, file: string, present: ReadonlySet<string>): Promise<{bytes: number | null; tail: string}> {
  if (!present.has(file)) return {bytes: null, tail: ''};
  const path = examFilePath(root, file);
  if (!path) return {bytes: null, tail: ''};
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return {bytes: null, tail: ''};
    if (!file.endsWith('.stderr')) return {bytes: info.size, tail: ''};
    const text = await readRegularExam(path);
    return {bytes: info.size, tail: redactUnknownSecrets((text ?? '').trim().slice(-300)).slice(0, 300)};
  } catch { return {bytes: null, tail: ''}; }
}

/**
 * One result per tool. A tool is only judged "clean" when its exit code is one the table allows, its report exists
 * (unless the tool writes none without a target) and the report parses. A killed or truncated run is never zero findings.
 */
async function judgeTool(
  root: string,
  spec: ToolSpec,
  present: ReadonlySet<string>,
  ran: boolean,
  parts: {tool: string; format: 'json'; body: unknown}[],
  files: string[],
  counter: {rejected: number},
): Promise<ToolResult | null> {
  const code = await readCode(root, spec.name, present);
  const fileFound = present.has(spec.file);
  const evidence = code !== null || fileFound || present.has(`${spec.name}.stdout`) || present.has(`${spec.name}.stderr`);
  if (!ran && !evidence) return null;
  const version = await readVersion(root, spec.name, present);
  const out = await sideOutput(root, `${spec.name}.stdout`, present);
  const err = await sideOutput(root, `${spec.name}.stderr`, present);
  const base = {
    name: spec.name, tool: spec.tool, version, exitCode: code, expectedFile: spec.file, fileFound,
    stdoutBytes: out.bytes, stderrTail: err.tail,
  };
  const result = (state: ToolState, reason: string | null, formatValid: boolean | null, findings: number): ToolResult =>
    ToolResult.parse({...base, state, reason, formatValid, findings});

  if (code === 127) return result('indisponivel', 'ferramenta ausente na imagem (código 127)', null, 0);
  const noTarget = code !== null && (spec.noTarget ?? []).includes(code);
  const says = code === null ? null : spec.findings.includes(code) ? 'achados' : spec.clean.includes(code) || noTarget ? 'limpo' : 'erro';
  if (says === 'erro') return result('indisponivel', `código de saída ${code} inesperado`, null, 0);
  if (code === null && ran) return result('indisponivel', 'sem código de saída registrado', null, 0);

  if (!fileFound) {
    if (noTarget) return result('limpa', `código ${code}: nada a examinar`, null, 0);
    if (says === 'achados') return result('truncada', 'a ferramenta indicou achados, mas o relatório não existe', null, 0);
    if (spec.optionalReport) return result('limpa', 'a ferramenta não gera relatório sem alvo', null, 0);
    return result('indisponivel', 'relatório esperado ausente', null, 0);
  }
  if (!spec.parsed) return result('limpa', null, null, 0);

  const path = examFilePath(root, spec.file);
  const text = path ? await readRegularExam(path).catch(() => null /* unreadable report: counted as rejected below */) : null;
  if (text === null) {
    counter.rejected += 1;
    return result('indisponivel', 'relatório recusado (link ou acima de 50 MB)', null, 0);
  }
  const redacted = path ? await rewriteRedactedExam(path, text).catch(() => null /* redaction refused: counted as rejected below */) : null;
  if (redacted === null) {
    counter.rejected += 1;
    return result('indisponivel', 'relatório recusado na redação', null, 0);
  }
  if (redacted.trim().length === 0) return result('truncada', 'relatório vazio', false, 0);
  let body: unknown;
  try {
    body = JSON.parse(redacted) as unknown;
  } catch {
    return result('truncada', 'JSON ilegível ou cortado', false, 0);
  }
  parts.push({tool: spec.tool, format: 'json', body});
  files.push(spec.file);
  const own = normalizeToolOutput([{tool: spec.tool, format: 'json', body}]);
  if (says === 'achados' && own.findings.length === 0) return result('truncada', `código ${code} indica achados, mas o relatório não traz nenhum`, true, 0);
  return result(own.findings.length > 0 ? 'achado' : 'limpa', null, true, own.findings.length);
}

/** Left by the entrypoint when the databases have no Trivy Java database (storage.verifyDb.javaDb). */
const TRIVY_WITHOUT_JAVA_DB = 'trivy-fs.sem-java-db';
export const TRIVY_JAVA_DB_MISSING_NOTE = 'cobertura reduzida para Java: base Java do Trivy ausente, arquivos .jar/.war/.ear não examinados pelo Trivy';

function withoutJavaDb(result: ToolResult): ToolResult {
  const reason = result.reason ? `${result.reason}; ${TRIVY_JAVA_DB_MISSING_NOTE}` : TRIVY_JAVA_DB_MISSING_NOTE;
  return ToolResult.parse({...result, reason: reason.slice(0, 300)});
}

export async function collectToolFindings(outputDirectory: string): Promise<{findings: RawFinding[]; rejected: number; files: string[]; tools: ToolResult[]}> {
  const root = resolve(outputDirectory);
  const present = new Set(await readdir(root));
  const parts: {tool: string; format: 'json'; body: unknown}[] = [];
  const files: string[] = [];
  const counter = {rejected: 0};
  const tools: ToolResult[] = [];
  // The entrypoint always leaves status.json. Without it the directory came from another runner and only what exists is judged.
  const ran = present.has('status.json');
  for (const spec of TOOL_SPECS) {
    const judged = await judgeTool(root, spec, present, ran, parts, files, counter);
    if (judged) tools.push(judged.name === 'trivy-fs' && present.has(TRIVY_WITHOUT_JAVA_DB) ? withoutJavaDb(judged) : judged);
  }
  // The older checkov basename stays accepted. An unreadable one adds nothing and was never counted as a clean run.
  if (present.has('checkov.json') && !files.includes('results_json.json')) {
    const path = examFilePath(root, 'checkov.json');
    const text = path ? await readRegularExam(path).catch(() => null /* unreadable report: counted as rejected below */) : null;
    const redacted = path && text !== null ? await rewriteRedactedExam(path, text).catch(() => null /* redaction refused: counted as rejected below */) : null;
    if (redacted === null) counter.rejected += 1;
    else {
      try {
        parts.push({tool: 'checkov', format: 'json', body: JSON.parse(redacted) as unknown});
        files.push('checkov.json');
      } catch { /* ignored on purpose */ }
    }
  }
  const normalized = normalizeToolOutput(parts);
  return {
    findings: normalized.findings.map(finding => RawFinding.parse(finding)),
    rejected: normalized.rejected + counter.rejected,
    files,
    tools,
  };
}
