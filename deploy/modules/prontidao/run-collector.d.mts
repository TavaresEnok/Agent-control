import type {CoverageRow, FindingRow} from './audit-readiness.mjs';

export type BinRunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type CollectorOptions = {
  repoRoot?: string;
  tmpDir?: string;
  targetUrl?: string;
  hasExternalNetwork?: boolean;
  bins?: {gitleaks?: string; hadolint?: string; trivy?: string; testssl?: string};
  runBin?: (bin: string, args: string[], options?: {cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number}) => BinRunResult;
};

export function validateTargetUrl(raw: string): URL | null;
export function parseGitleaksJson(text: string, repoRoot: string, fallbackFile: string): FindingRow[];
export function parseHadolintJson(text: string, repoRoot: string, fallbackFile: string): FindingRow[];
export function parseTrivyConfigJson(text: string, repoRoot: string, fallbackFile: string): {findings: FindingRow[]; targets: string[]};
export function parseTestsslJson(text: string, repoRoot: string, anchorFile: string): FindingRow[];
export function runCollector(options?: CollectorOptions): {coverage: CoverageRow[]; findings: FindingRow[]};
