import {Refusal} from './contracts.ts';
import {hasKnownSecret} from './verify-redact.ts';

// Transport contract with deploy/modules/documentacao/collect.mjs.
const TOOLS_BY_ARTIFACT = {
  'api.json': 'typedoc:artefato',
  'dependencias.mmd': 'dependency-cruiser:artefato',
} as const;
const ENCODING = 'hex-utf8-v1';
const MAX_ARTIFACT_BYTES = 512 * 1024;
const PART_BYTES = 880;
const MAX_PARTS = Math.ceil(MAX_ARTIFACT_BYTES / PART_BYTES);
const MAX_DETAIL_CHARS = 2000;
const HEX_GROUPS = /^(?:[0-9a-f]{16} )*(?:[0-9a-f]{2}){1,8}$(?!\s)/u;
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

type ArtifactName = keyof typeof TOOLS_BY_ARTIFACT;
type Artifact =
  | {status: 'absent'}
  | {status: 'omitted'; reason: 'size-limit'}
  | {status: 'present'; content: string};
type CoverageRow = {
  tool: string;
  version: string;
  status: 'ok' | 'skipped' | 'failed';
  detail: string;
};

function invalidArtifact(): never {
  throw new Refusal('VERIFY_REPORT_INVALID', 400);
}

function envelope(fields: Record<string, unknown>): string {
  return JSON.stringify(fields, null, 1).replaceAll('\n', '');
}

function parseDetail(detail: string): Record<string, unknown> {
  if (detail.length > MAX_DETAIL_CHARS) invalidArtifact();
  let value: unknown;
  try {
    value = JSON.parse(detail);
  } catch {
    invalidArtifact();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidArtifact();
  return value as Record<string, unknown>;
}

function guardContent(content: string): void {
  if (hasKnownSecret(content)) throw new Refusal('VERIFY_SECRET_IN_REPORT', 400);
}

function guardApiCatalog(content: string): void {
  let catalog: unknown;
  try {
    catalog = JSON.parse(content);
  } catch {
    invalidArtifact();
  }
  if (!Array.isArray(catalog)) invalidArtifact();

  // Check JSON strings and keys as well as the original text. JSON escapes can
  // otherwise hide values that the report's text guard would recognize.
  const pending: unknown[] = [catalog];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      guardContent(value);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        guardContent(key);
        pending.push(child);
      }
    }
  }
}

function assembleArtifact(name: ArtifactName, rows: readonly CoverageRow[]): Artifact {
  if (rows.length === 0) return {status: 'absent'};
  if (rows.length > MAX_PARTS) invalidArtifact();
  const chunks = new Map<number, Buffer>();
  const version = rows[0]!.version;
  let byteLength = 0;

  for (const row of rows) {
    const {artifact, encoding, reason, part, parts, data} = parseDetail(row.detail);
    if (artifact !== name || encoding !== ENCODING || row.version !== version) invalidArtifact();
    if (row.status === 'skipped') {
      if (rows.length !== 1 || reason !== 'size-limit'
        || row.detail !== envelope({artifact, encoding, reason})) invalidArtifact();
      return {status: 'omitted', reason};
    }
    if (row.status !== 'ok' || parts !== rows.length || typeof part !== 'number'
      || !Number.isInteger(part) || part < 1 || part > parts || chunks.has(part)
      || typeof data !== 'string' || !HEX_GROUPS.test(data)
      || row.detail !== envelope({artifact, encoding, part, parts, data})) invalidArtifact();

    const bytes = Buffer.from(data.replaceAll(' ', ''), 'hex');
    if (bytes.length > PART_BYTES || (part < parts && bytes.length !== PART_BYTES)) invalidArtifact();
    byteLength += bytes.length;
    if (byteLength > MAX_ARTIFACT_BYTES) invalidArtifact();
    chunks.set(part, bytes);
  }

  const ordered = Array.from({length: rows.length}, (_, index) => chunks.get(index + 1)!);
  let content: string;
  try {
    content = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true})
      .decode(Buffer.concat(ordered, byteLength));
  } catch {
    invalidArtifact();
  }
  if (FORBIDDEN_CONTROL.test(content)) invalidArtifact();
  guardContent(content);
  if (name === 'api.json') guardApiCatalog(content);
  return {status: 'present', content};
}

/**
 * Reads the documentation collector's already validated coverage. Call before
 * persisting coverage or planning files, and pass present contents through the
 * common report's content guard and private writer using the returned names.
 */
export function assembleDocumentationArtifacts(
  coverage: readonly CoverageRow[],
): Readonly<Record<ArtifactName, Artifact>> {
  const api: CoverageRow[] = [];
  const dependencies: CoverageRow[] = [];
  for (const row of coverage) {
    if (row.tool === TOOLS_BY_ARTIFACT['api.json']) api.push(row);
    else if (row.tool === TOOLS_BY_ARTIFACT['dependencias.mmd']) dependencies.push(row);
    else if (row.tool.endsWith(':artefato')) invalidArtifact();
  }
  return {
    'api.json': assembleArtifact('api.json', api),
    'dependencias.mmd': assembleArtifact('dependencias.mmd', dependencies),
  };
}
