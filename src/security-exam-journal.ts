/**
 * Durable journal of the security exam. Each examiner call and each confirmation is written as soon as it returns, so a run
 * that stops (usage limit, stale login, disk guard) does not lose the work already paid for. The next run of the same project
 * at the same commit reuses a file's judgment only when the file still has the same content hash, and a confirmation only
 * when the finding and the file are the same. Nothing here calls a model.
 */
import {appendFile, chmod, lstat, mkdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {digest, Id} from './contracts.ts';
import {ConfirmResult, ExamFinding, VerifySeverity} from './verify-types.ts';

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const Commit = z.string().regex(/^[a-f0-9]{40}$/);

export const JournalSeat = z.object({
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(100),
  accountId: Id,
  profileId: Id,
  grantId: Id,
}).strict();
export type JournalSeat = z.infer<typeof JournalSeat>;

export const JournalExam = z.object({
  kind: z.literal('exame'),
  schemaVersion: z.literal(1),
  commit: Commit,
  intentId: z.string().min(1).max(240),
  /** The native job that produced the answer, when known. Used to import each job only once. */
  jobId: z.string().min(1).max(240).nullable(),
  sliceId: z.string().min(1).max(200),
  /** Checklist ids the slice asked for. */
  checklist: z.array(z.string().min(1).max(80)).max(80),
  /** Checklist ids the examiner declared. */
  declared: z.array(z.string().min(1).max(80)).max(80),
  files: z.array(z.object({file: z.string().min(1).max(400), sha256: Hex64.nullable(), judged: z.boolean()}).strict()).min(1).max(80),
  findings: z.array(ExamFinding).max(40),
  seat: JournalSeat,
  sessionId: z.string().min(1).max(240).nullable(),
}).strict();
export type JournalExam = z.infer<typeof JournalExam>;

export const JournalConfirm = z.object({
  kind: z.literal('confirmacao'),
  schemaVersion: z.literal(1),
  commit: Commit,
  key: Hex64,
  confirm: ConfirmResult,
  verifier: JournalSeat,
  examinerAccountId: z.string().min(1).max(240).nullable(),
}).strict();
export type JournalConfirm = z.infer<typeof JournalConfirm>;

const Entry = z.discriminatedUnion('kind', [JournalExam, JournalConfirm]);

export type SecurityExamJournal = {
  path: string;
  commit: string;
  exams: JournalExam[];
  confirms: Map<string, JournalConfirm>;
  jobIds: Set<string>;
};

/** One file per project and commit, beside the progress files. */
export function securityJournalPath(dataDirectory: string, projectId: string, commit: string): string {
  return join(dataDirectory, 'verificacoes', projectId, 'diario', `seguranca-${Commit.parse(commit)}.jsonl`);
}

/** Reads the journal. A broken or foreign line is skipped, never trusted: the worst case is one more model call. */
export async function loadSecurityJournal(path: string, commit: string): Promise<SecurityExamJournal> {
  const journal: SecurityExamJournal = {path, commit: Commit.parse(commit), exams: [], confirms: new Map(), jobIds: new Set()};
  let text: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid?.()) return journal;
    text = await readFile(path, 'utf8');
  } catch {
    return journal;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = Entry.safeParse(JSON.parse(line)); } catch { continue; }
    if (!parsed.success || parsed.data.commit !== journal.commit) continue;
    remember(journal, parsed.data);
  }
  return journal;
}

function remember(journal: SecurityExamJournal, entry: JournalExam | JournalConfirm) {
  if (entry.kind === 'exame') {
    journal.exams.push(entry);
    if (entry.jobId) journal.jobIds.add(entry.jobId);
  } else journal.confirms.set(entry.key, entry);
}

/** Appends one entry (private file, created on first use). A write failure never stops the exam. */
export async function appendSecurityJournal(journal: SecurityExamJournal, entry: JournalExam | JournalConfirm): Promise<boolean> {
  const checked = Entry.safeParse(entry);
  if (!checked.success || checked.data.commit !== journal.commit) return false;
  const parsed = checked.data;
  try {
    await mkdir(join(journal.path, '..'), {recursive: true, mode: 0o700});
    await appendFile(journal.path, JSON.stringify(parsed) + '\n', {encoding: 'utf8', mode: 0o600});
    await chmod(journal.path, 0o600);
  } catch {
    return false;
  }
  remember(journal, parsed);
  return true;
}

/**
 * The latest journaled judgment of `file` with this content hash that covers every requested checklist id.
 * A missing hash (file unreadable) never matches.
 */
export function journaledJudgment(journal: SecurityExamJournal, file: string, sha256: string | null, checklist: readonly string[]): JournalExam | undefined {
  if (!sha256) return undefined;
  for (let index = journal.exams.length - 1; index >= 0; index -= 1) {
    const entry = journal.exams[index]!;
    if (!checklist.every(id => entry.checklist.includes(id))) continue;
    if (entry.files.some(item => item.file === file && item.judged && item.sha256 === sha256)) return entry;
  }
  return undefined;
}

/** Identity of a finding for the confirmation: where it is, what it says, and the content of its file. */
export function confirmationKey(finding: {file: string; line: number | null; title: string; snippet: string; severity: VerifySeverity; rule: string | null}, fileSha256: string | null): string {
  return digest({file: finding.file, line: finding.line, title: finding.title, snippet: finding.snippet, severity: finding.severity, rule: finding.rule, sha256: fileSha256});
}

/** Parses the examiner task the runtime writes: slice id, files and checklist ids. Undefined when the shape differs. */
export function parseExamTask(task: string): {sliceId: string; files: string[]; checklist: string[]} | undefined {
  if (!task.startsWith('Pedido de exame.\n')) return undefined;
  const lines = task.split('\n');
  const slice = lines.find(line => line.startsWith('Fatia: '));
  const start = lines.indexOf('Arquivos:');
  if (!slice || start < 0) return undefined;
  const files: string[] = [];
  let index = start + 1;
  for (; index < lines.length && lines[index]!.startsWith('- '); index += 1) files.push(lines[index]!.slice(2));
  const items = lines[index]?.startsWith('Itens: ') ? lines[index]!.slice('Itens: '.length) : undefined;
  if (!files.length || items === undefined || (files.length === 1 && files[0] === 'nenhum')) return undefined;
  const checklist = items.split(',').map(item => item.trim()).filter(Boolean);
  return {sliceId: slice.slice('Fatia: '.length), files, checklist};
}

/** A completed examiner job of an earlier run, matched by the caller to its signed receipt, project and commit. */
export type ImportedExamJob = {
  jobId: string;
  intentId: string;
  task: string;
  output: string;
  seat: JournalSeat;
  sessionId: string | null;
};
