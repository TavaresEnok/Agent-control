import {readFile, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {normalizeToolOutput} from './verify-normalize.ts';
import {RawFinding} from './verify-types.ts';

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

export async function collectToolFindings(outputDirectory: string): Promise<{findings: RawFinding[]; rejected: number; files: string[]}> {
  const root = resolve(outputDirectory);
  const present = new Set(await readdir(root));
  const parts: {tool: string; format: 'json'; body: unknown}[] = [];
  const files: string[] = [];
  for (const spec of EXAM_FILES) {
    if (!present.has(spec.file)) continue;
    const text = await readFile(join(root, spec.file), 'utf8');
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
    rejected: normalized.rejected,
    files,
  };
}
