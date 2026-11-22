export type CoverageStatus = 'ok' | 'failed' | 'skipped';
export type FindingSeverity = 'alta' | 'media' | 'baixa' | 'informativa';

export interface CoverageRow {
  tool: string;
  version: string;
  status: CoverageStatus;
  detail: string;
  files?: string[];
}

export interface FindingItem {
  tool: string;
  rule: string;
  file: string;
  line: number;
  severity: FindingSeverity;
  message: string;
  evidence: string;
}

export interface CollectorOutput {
  coverage: CoverageRow[];
  findings: FindingItem[];
}

export function reduceArchitectureNoise(findings: FindingItem[]): {findings: FindingItem[]; omittedDuplicatePairs: number};
export function boundCollectorOutput(output: CollectorOutput, limits?: {maxCoverage?: number; maxFindings?: number}): CollectorOutput;
export function normalizeRepoPath(filePath: string, repoRoot?: string): string;
export function clampLine(value: unknown): number;
export function copyRepoSafely(
  sourceRoot: string,
  destRoot: string,
  opts?: {maxFiles?: number; maxFileBytes?: number},
): {
  copiedFiles: string[];
  skipped: {file: string; reason: string}[];
  stoppedAt?: string;
  failure?: {file: string; code: string};
};
export function buildKnipConfig(
  workRepoDir: string,
  repoFiles: string[],
): Record<string, unknown> & {entry: string[]; project: string[]; ignore: string[]};
export function findImportLine(fileText: string, moduleSpecifier: string): number;
export function parseKnipReport(
  rawJson: unknown,
  repoRoot: string,
  candidateFiles?: Set<string>,
  includesFile?: (file: string) => boolean,
  wasOmitted?: (file: string) => boolean,
): {
  findings: FindingItem[];
  perFileCoverage: {tool: string; role: string; issues: number; file: string}[];
  stats: {totalFiles: number; entries: number; unusedFiles: number; unusedExports: number; unusedDeps: number};
};
export function parseJscpdReport(
  rawJson: unknown,
  repoRoot: string,
  scannedBaseDir: string | null,
  includesFile?: (file: string) => boolean,
): {
  findings: FindingItem[];
  duplicatedFiles: Set<string>;
  stats: {clones: number; sources: number; lines: number; duplicatedLines: number; percentage: number};
};
export function parseJscpdComplexityReport(
  rawJson: unknown,
  repoRoot: string,
  scannedBaseDir: string | null,
  coveredAstFiles?: Set<string>,
  includesFile?: (file: string) => boolean,
): {
  findings: FindingItem[];
  fileMetrics: {file: string; complexity: number; lines: number; tokens: number; format: string}[];
  totalFiles: number;
};
export function parseDepcruiseReport(
  rawJson: unknown,
  repoRoot: string,
  readSourceFile?: (relFile: string) => string,
  includesFile?: (file: string) => boolean,
): {
  findings: FindingItem[];
  perFileCoverage: {
    file: string;
    deps: number;
    dependents: number;
    instability: string;
    cycle: boolean;
    layerViolation: boolean;
    partial: boolean;
  }[];
  stats: {totalModules: number; totalDependencies: number; cycles: number; layerViolations: number; orphans: number; omittedEdges: number; partial: boolean};
};
export function analyzeAstComplexity(
  workRepoDir: string,
  jsTsFiles: string[],
  thresholds?: Record<string, number>,
  options?: {ts?: unknown; requireAstApi?: boolean},
): {
  findings: FindingItem[];
  perFile: {
    file: string;
    loc: number;
    functions: number;
    fileCyclomatic: number;
    maxFnCyclomatic: number;
    maxNesting: number;
  }[];
  stats: {
    analyzedFiles: number;
    maxFileCyclomatic: number;
    maxFunctionCyclomatic: number;
    maxNesting: number;
    complexFunctions: number;
    largeFiles: number;
  };
};
export function runCollector(options?: {
  repoDir?: string;
  toolsRoot?: string;
  spawnSync?: (...args: unknown[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  };
}): CollectorOutput;
