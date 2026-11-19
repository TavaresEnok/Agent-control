export const AUDIT_VERSION: string;

export type ReadinessSeverity = 'alta' | 'media' | 'baixa' | 'informativa';
export type ReadinessStatus = 'ok' | 'failed' | 'skipped';

export type CoverageRow = {
  tool: string;
  version: string;
  status: ReadinessStatus;
  detail: string;
};

export type FindingRow = {
  tool: string;
  rule: string;
  file: string;
  line: number;
  severity: ReadinessSeverity;
  message: string;
  evidence: string;
};

export type ComposeServiceInfo = {
  name: string;
  line: number;
  image: string;
  restart: string | null;
  hasDeployRestart: boolean;
  hasHealthcheck: boolean;
  hasMemLimit: boolean;
  hasPidsLimit: boolean;
  hasVolumes: boolean;
  logDriver: string | null;
  hasLogMaxSize: boolean;
  hasLogMaxFile: boolean;
  hasEnvFile: boolean;
  hasSecrets: boolean;
  environment: {key: string; value: string; line: number}[];
};

export function redactEvidence(text: string): string;
export function collectRepoFiles(repoRoot: string): {rel: string; content: string; lines: string[]}[];
export function parseComposeServices(content: string): ComposeServiceInfo[];
export function auditRepositoryReadiness(repoRoot: string): {
  filesAnalyzed: number;
  anchorFile: string;
  tlsAnchorFile: string;
  findings: FindingRow[];
  coverage: CoverageRow[];
};
