import {constants} from 'node:fs';
import {lstat, open, readdir} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {normalizeToolOutput} from './verify-normalize.ts';
import {RawFinding} from './verify-types.ts';

const MAX_EXAM_FILE_BYTES = 50 * 1024 * 1024;

/** Names the exam entrypoint writes. Only these basenames are read. */
const EXAM_FILES = [
  {file: 'gitleaks.json', tool: 'gitleaks'},
  {file: 'osv.json', tool: 'osv-scanner'},
  {file: 'grype.json', tool: 'grype'},
  {file: 'opengrep.json', tool: 'opengrep'},
  {file: 'hadolint.json', tool: 'hadolint'},
  {file: 'trivy-config.json', tool: 'trivy'},
  {file: 'trivy-fs.json', tool: 'trivy'},
  {file: 'results_json.json', tool: 'checkov'},
  {file: 'checkov.json', tool: 'checkov'},
] as const;

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

export async function collectToolFindings(outputDirectory: string): Promise<{findings: RawFinding[]; rejected: number; files: string[]}> {
  const root = resolve(outputDirectory);
  const present = new Set(await readdir(root));
  const parts: {tool: string; format: 'json'; body: unknown}[] = [];
  const files: string[] = [];
  let rejected = 0;
  for (const spec of EXAM_FILES) {
    if (!present.has(spec.file)) continue;
    const path = examFilePath(root, spec.file);
    if (!path) {
      rejected += 1;
      continue;
    }
    const text = await readRegularExam(path);
    if (text === null) {
      rejected += 1;
      continue;
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      continue;
    }
    parts.push({tool: spec.tool, format: 'json', body});
    files.push(spec.file);
  }
  const normalized = normalizeToolOutput(parts);
  return {
    findings: normalized.findings.map(finding => RawFinding.parse(finding)),
    rejected: normalized.rejected + rejected,
    files,
  };
}
