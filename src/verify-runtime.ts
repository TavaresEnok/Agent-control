import {randomUUID} from 'node:crypto';
import {readFile, realpath} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';
import {Capacity, type Grant} from './capacity.ts';
import {Refusal, type Authority} from './contracts.ts';
import {Ledger, type Intent} from './ledger.ts';
import {loadSecurityChecklist} from './verify-checklist.ts';
import {acceptSecurityVerification, assertPersonalActivation} from './verify-intent.ts';
import {writeSecurityReport} from './verify-report.ts';
import {listExamFiles, sliceExamFiles} from './verify-slices.ts';
import {
  Achado,
  ConfirmResult,
  CoverageRow,
  ExamResult,
  MapResult,
  REMEDIATION_ACCEPTANCE,
  RawFinding,
  VerifyWorkerCall,
  type ChecklistItem,
  type VerifySeverity,
  type VerifyWorker,
} from './verify-types.ts';

export type SecurityVerificationInput = {
  ledger: Ledger;
  principal: string;
  authority: Authority;
  projectId: string;
  repoPath: string;
  dataDirectory: string;
  commit: string;
  policyRevision: number;
  worker: VerifyWorker;
  rawFindings?: RawFinding[];
  checklist?: readonly ChecklistItem[];
};

type Seat = {
  provider: string;
  model: string;
  accountId: string;
  profileId: string;
  grantId: string;
};

type OpenFinding = {
  file: string;
  line: number | null;
  title: string;
  rule: string | null;
  snippet: string;
  severity: VerifySeverity;
  scenario: string;
  suggestion: string;
  reference: string;
  sources: string[];
  examinerProvider: string | null;
  examinerAccountId: string | null;
};

const FILE_TEXT_LIMIT = 20_000;

export async function runSecurityVerification(input: SecurityVerificationInput): Promise<{
  runId: string;
  directory: string;
  achados: Achado[];
  coverage: CoverageRow[];
}> {
  await assertPersonalActivation(input.ledger);
  assertReportOutsideRepo(input.repoPath, input.dataDirectory);
  const intent = await acceptSecurityVerification(input.ledger, input.principal, input.authority, {
    projectId: input.projectId,
    commit: input.commit,
    policyRevision: input.policyRevision,
  });
  const runId = randomUUID();
  const createdAt = new Date();
  await insertRun(input, intent, runId);
  try {
    return await examine(input, intent, runId, createdAt);
  } catch (error) {
    try { await markFailed(input.ledger, runId); } catch { /* the original failure stays visible */ }
    throw error;
  }
}

function assertReportOutsideRepo(repoPath: string, dataDirectory: string) {
  const repo = resolve(repoPath);
  const data = resolve(dataDirectory);
  const rel = relative(repo, data);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Refusal('VERIFY_REPORT_INSIDE_REPO', 403);
}

async function insertRun(input: SecurityVerificationInput, intent: Intent, runId: string) {
  await input.ledger.tx(async c => {
    const context = await input.ledger.authorize(c, input.principal, input.authority.contextId);
    await input.ledger.fence(c, input.authority);
    if (context.project_id !== input.projectId) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);
    await c.query(
      `INSERT INTO ac_verify_runs (id, project_id, context_id, intent_id, principal_id, commit_id, status, report_dir)
       VALUES ($1,$2,$3,$4,$5,$6,'running','pending')`,
      [runId, input.projectId, input.authority.contextId, intent.id, input.principal, input.commit],
    );
  });
}

async function markFailed(ledger: Ledger, runId: string) {
  await ledger.pool.query(
    "UPDATE ac_verify_runs SET status='failed', finished_at=clock_timestamp() WHERE id=$1 AND status='running'",
    [runId],
  );
}

async function examine(input: SecurityVerificationInput, intent: Intent, runId: string, createdAt: Date) {
  const capacity = new Capacity(input.ledger);
  const rawFindings = (input.rawFindings ?? []).map(item => RawFinding.parse(item));
  const checklist = input.checklist ?? loadSecurityChecklist();
  const files = await listExamFiles(input.repoPath);
  const slices = sliceExamFiles(files, checklist);
  const notes: string[] = [];
  const coverage = new Map<string, CoverageRow>();
  const open: OpenFinding[] = [];
  const exams: unknown[] = [];
  let map: MapResult = minimalMap(files);
  let mapMarkdown = mapToMarkdown(map, files);
  let mapProvider: string | null = null;
  let mapAccountId: string | null = null;
  let mapSeat: Seat | null = null;

  if (files.length === 0 && rawFindings.length === 0) {
    notes.push('Nenhum arquivo para examinar.');
  } else {
    const mapped = await reserveAndRun(input, capacity, intent.id, 'specialist', mapTask(files), 'verify-map');
    mapSeat = mapped.seat;
    mapProvider = mapped.seat.provider;
    mapAccountId = mapped.seat.accountId;
    const parsed = MapResult.safeParse(parseJson(mapped.output));
    if (parsed.success) map = parsed.data;
    else {
      map = minimalMap(files);
      notes.push('O mapa não veio em JSON válido. A lista de arquivos ficou no lugar.');
    }
    mapMarkdown = mapToMarkdown(map, files);
    for (const slice of slices) {
      if (!slice.files.length) continue;
      const examined = await reserveAndRun(input, capacity, intent.id, 'specialist', examTask(slice, mapMarkdown, rawFindings), 'verify-exam');
      const exam = ExamResult.safeParse(parseJson(examined.output));
      exams.push(exam.success ? exam.data : {slice: slice.id, invalid: true});
      const read = new Set(exam.success ? exam.data.filesRead : []);
      const ids = checklistIds(slice.checklist, exam.success ? exam.data.checklist : []);
      for (const file of slice.files) addCoverage(coverage, file, examined.seat, ids);
      const missing = slice.files.filter(file => !read.has(file));
      if (!exam.success) notes.push(`A fatia ${slice.id} não devolveu exame válido.`);
      else if (missing.length) notes.push(`O examinador não marcou como lido: ${missing.join(', ')}.`);
      if (!exam.success) continue;
      for (const finding of exam.data.findings) {
        open.push({
          file: finding.file,
          line: finding.line,
          title: finding.title,
          rule: null,
          snippet: finding.snippet,
          severity: finding.severity,
          scenario: finding.scenario,
          suggestion: finding.suggestion,
          reference: [finding.reference, finding.cwe].filter((part): part is string => Boolean(part)).join(', ').slice(0, 200),
          sources: [`examinador ${examined.seat.provider}`, `fatia ${slice.id}`, finding.reference].slice(0, 20),
          examinerProvider: examined.seat.provider,
          examinerAccountId: examined.seat.accountId,
        });
      }
    }
  }

  for (const raw of rawFindings) {
    open.push({
      file: raw.file,
      line: raw.line,
      title: raw.rule,
      rule: raw.rule,
      snippet: raw.snippet,
      severity: raw.severity,
      scenario: `A ferramenta ${raw.tool} apontou ${raw.rule}.`,
      suggestion: 'Corrigir o ponto indicado pela ferramenta e cobrir com teste de regressão.',
      reference: (raw.cwe ?? raw.rule).slice(0, 200),
      sources: [raw.tool, raw.rule, ...(raw.cwe ? [raw.cwe] : [])].slice(0, 20),
      examinerProvider: null,
      examinerAccountId: null,
    });
  }

  if (mapSeat) {
    const fallback = checklistIds(checklist.map(item => item.id), []);
    for (const file of files) {
      if (coverage.has(file)) continue;
      addCoverage(coverage, file, mapSeat, fallback);
      notes.push(`Arquivo fora das fatias, coberto pelo mapa: ${file}.`);
    }
  }

  const confirms: unknown[] = [];
  const achados: Achado[] = [];
  for (const finding of open) {
    if (achados.length >= 999) throw new Refusal('VERIFY_FINDING_LIMIT');
    const forbidden = finding.examinerProvider ?? mapProvider;
    const avoid = finding.examinerAccountId ?? mapAccountId;
    const content = await readRepoText(input.repoPath, finding.file);
    const reviewed = await reserveAndRun(
      input,
      capacity,
      intent.id,
      'reviewer',
      confirmationTask(finding, content.text, content.missing),
      'verify-confirm',
      avoid ? [avoid] : undefined,
      forbidden ?? undefined,
    );
    let confirm;
    try {
      confirm = ConfirmResult.parse(parseJson(reviewed.output));
    } catch {
      throw new Refusal('VERIFY_CONFIRMATION_INVALID');
    }
    confirms.push(confirm);
    const proof = [confirm.proof, confirm.reason].filter((part, index, all) => part && all.indexOf(part) === index).join('\n').slice(0, 2000);
    achados.push(Achado.parse({
      id: `ACH-${String(achados.length + 1).padStart(3, '0')}`,
      title: finding.title.slice(0, 200),
      severity: finding.severity,
      status: confirm.status,
      verifier: {model: reviewed.seat.model, provider: reviewed.seat.provider},
      reference: finding.reference.slice(0, 200) || finding.title.slice(0, 200),
      where: {file: finding.file, line: finding.line},
      scenario: finding.scenario.slice(0, 2000),
      proof,
      suggestion: finding.suggestion.slice(0, 2000),
      acceptance: REMEDIATION_ACCEPTANCE,
      sources: finding.sources.map(source => source.slice(0, 200)).filter(source => source.length > 0).slice(0, 20),
      secretPreview: previewOf(finding.snippet),
    }));
  }

  const rows = orderedCoverage(files, coverage);
  const note = (notes.length ? notes.join(' ') : 'Verificação somente leitura concluída.').slice(0, 500);
  const report = await writeSecurityReport({
    dataDirectory: input.dataDirectory,
    projectId: input.projectId,
    runId,
    createdAt,
    commit: input.commit,
    mapMarkdown,
    coverage: rows,
    achados,
    raw: {map, exams, rawFindings, confirmations: confirms},
    note,
  });
  await input.ledger.tx(async c => {
    await input.ledger.authorize(c, input.principal, input.authority.contextId);
    await input.ledger.fence(c, input.authority);
    for (const achado of achados) {
      await c.query(
        `INSERT INTO ac_verify_findings (run_id, achado_id, status, severity, file, line, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [runId, achado.id, achado.status, achado.severity, achado.where.file, achado.where.line, JSON.stringify(achado)],
      );
    }
    for (const row of rows) {
      await c.query(
        `INSERT INTO ac_verify_coverage (run_id, file, examiner_provider, examiner_model, profile_id, checklist)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [runId, row.file, row.examinerProvider, row.examinerModel, row.profileId, JSON.stringify(row.checklist)],
      );
    }
    const updated = await c.query(
      `UPDATE ac_verify_runs SET status='done', report_dir=$2, finished_at=clock_timestamp()
       WHERE id=$1 AND context_id=$3 AND status='running'`,
      [runId, report.directory, input.authority.contextId],
    );
    if (!updated.rowCount) throw new Refusal('VERIFY_RUN_CONFLICT');
    await c.query("UPDATE ac_intents SET state='done' WHERE id=$1 AND context_id=$2", [intent.id, input.authority.contextId]);
    await input.ledger.refreshPending(c, input.authority.contextId);
  });
  return {runId, directory: report.directory, achados, coverage: rows};
}

async function reserveAndRun(
  input: SecurityVerificationInput,
  capacity: Capacity,
  intentId: string,
  role: 'specialist' | 'reviewer',
  task: string,
  processId: string,
  avoidAccounts?: readonly string[],
  forbiddenProvider?: string,
): Promise<{seat: Seat; output: string}> {
  const grant = await capacity.reserve(input.principal, {
    attemptId: randomUUID(),
    intentId,
    contextId: input.authority.contextId,
    role,
    ...(avoidAccounts?.length ? {avoidAccounts: [...avoidAccounts].slice(0, 8)} : {}),
  }, input.authority);
  let thrown: unknown;
  try {
    const seat = await readSeat(input.ledger, grant);
    if (forbiddenProvider && seat.provider === forbiddenProvider) throw new Refusal('REVIEWER_PROVIDER_MUST_DIFFER');
    const call = VerifyWorkerCall.parse({
      role,
      provider: seat.provider,
      accountId: seat.accountId,
      profileId: seat.profileId,
      model: seat.model,
      grantId: seat.grantId,
      intentId,
      task: task.slice(0, 100_000),
      repo: input.repoPath,
      writePaths: [] as const,
    });
    const output = await input.worker.run(call);
    return {seat, output};
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    try {
      await capacity.transition(input.principal, grant.id, input.authority, 'released', {processId, state: 'not_started'});
    } catch (error) {
      if (!thrown) throw error;
    }
  }
}

async function readSeat(ledger: Ledger, grant: Grant): Promise<Seat> {
  const row = (await ledger.pool.query<{provider: string; model: string}>(
    'SELECT a.provider, p.model FROM ac_capacity_grants g JOIN ac_profiles p ON p.id=g.profile_id JOIN ac_accounts a ON a.id=g.account_id WHERE g.id=$1',
    [grant.id],
  )).rows[0];
  if (!row?.provider || !row.model || !grant.account_id || !grant.profile_id) throw new Refusal('GRANT_FORBIDDEN', 403);
  return {provider: String(row.provider), model: String(row.model), accountId: grant.account_id, profileId: grant.profile_id, grantId: grant.id};
}

function mapTask(files: readonly string[]): string {
  return [
    'Pedido de mapa.',
    'Responda um JSON MapResult com kind "mapa", routes (method, path, file, line) e surfaces.',
    'Arquivos:',
    ...(files.length ? files.map(file => `- ${file}`) : ['- nenhum']),
    'Não escreva no repositório.',
  ].join('\n');
}

function examTask(
  slice: {id: string; files: string[]; checklist: string[]},
  mapMarkdown: string,
  rawFindings: readonly RawFinding[],
): string {
  const related = rawFindings.filter(finding => slice.files.includes(finding.file));
  return [
    'Pedido de exame.',
    'Responda um JSON ExamResult com kind "exame", filesRead cobrindo cada arquivo, checklist e findings.',
    `Fatia: ${slice.id}`,
    'Arquivos:',
    ...slice.files.map(file => `- ${file}`),
    `Itens: ${slice.checklist.join(', ')}`,
    ...(related.length ? ['Achados de ferramenta:', ...related.map(finding => `- ${finding.file}:${finding.line ?? '-'} ${finding.rule} ${finding.snippet}`)] : []),
    'Mapa:',
    mapMarkdown.slice(0, FILE_TEXT_LIMIT),
    'Não escreva no repositório.',
  ].join('\n');
}

/** File, line, rule or title, and snippet only. The examiner conclusion stays out. */
function confirmationTask(finding: OpenFinding, text: string, missing: boolean): string {
  return [
    'Pedido de confirmação.',
    'Tente derrubar o ponto. Responda só um JSON ConfirmResult com kind "confirmacao", status (confirmado, provavel ou descartado), reason e proof.',
    `Arquivo: ${finding.file}`,
    `Linha: ${finding.line ?? 'não informada'}`,
    finding.rule ? `Regra: ${finding.rule}` : `Título: ${finding.title}`,
    `Trecho: ${finding.snippet}`,
    'Conteúdo do arquivo:',
    missing ? 'O arquivo não está no repositório.' : text.slice(0, FILE_TEXT_LIMIT),
  ].join('\n');
}

function minimalMap(files: readonly string[]): MapResult {
  return MapResult.parse({
    kind: 'mapa',
    routes: [],
    surfaces: files.map(file => file.slice(0, 200)).filter(file => file.length > 0).slice(0, 80),
  });
}

function mapToMarkdown(map: MapResult, files: readonly string[]): string {
  const routes = map.routes.map(route => `- ${route.method} ${route.path} em ${route.file}:${route.line}`);
  const surfaces = map.surfaces.map(item => `- ${item}`);
  const listed = files.map(file => `- ${file}`);
  return [
    '# Mapa',
    '',
    '## Rotas',
    routes.length ? routes.join('\n') : '- nenhuma',
    '',
    '## Superfícies',
    surfaces.length ? surfaces.join('\n') : '- nenhuma',
    '',
    '## Arquivos',
    listed.length ? listed.join('\n') : '- nenhum',
    '',
  ].join('\n');
}

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^\uFEFF/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]);
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    return null;
  }
}

function checklistIds(primary: readonly string[], fallback: readonly string[]): string[] {
  const chosen = (primary.length ? primary : fallback).map(id => id.slice(0, 80)).filter(id => id.length > 0);
  return (chosen.length ? chosen : ['SEM-ITEM']).slice(0, 80);
}

function addCoverage(coverage: Map<string, CoverageRow>, file: string, seat: Seat, checklist: string[]) {
  if (coverage.has(file)) return;
  coverage.set(file, CoverageRow.parse({
    file,
    examinerProvider: seat.provider,
    examinerModel: seat.model,
    profileId: seat.profileId,
    checklist,
  }));
}

function orderedCoverage(files: readonly string[], coverage: Map<string, CoverageRow>): CoverageRow[] {
  const ordered = [...files];
  for (const file of coverage.keys()) if (!ordered.includes(file)) ordered.push(file);
  return ordered.flatMap(file => {
    const row = coverage.get(file);
    return row ? [row] : [];
  });
}

function previewOf(snippet: string): string | null {
  const match = snippet.match(/[^\s\u2026]{4}\u2026(?: \(sha256:[a-f0-9]{64}\))?/);
  if (!match || match[0].length > 80) return null;
  return match[0];
}

async function readRepoText(repoPath: string, file: string): Promise<{text: string; missing: boolean}> {
  if (!file || file.includes('\0') || isAbsolute(file)) return {text: '', missing: true};
  const root = await realpath(repoPath);
  let target: string;
  try {
    target = await realpath(resolve(root, file));
  } catch {
    return {text: '', missing: true};
  }
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) return {text: '', missing: true};
  try {
    return {text: (await readFile(target, 'utf8')).slice(0, FILE_TEXT_LIMIT), missing: false};
  } catch {
    return {text: '', missing: true};
  }
}
