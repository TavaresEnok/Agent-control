import type {RegistryRequestOptions} from './fetch-registry.mjs';

export type ModuleCoverageStatus = 'ok' | 'failed' | 'skipped';
export type ModuleFindingSeverity = 'alta' | 'media' | 'baixa' | 'informativa';

export interface ModuleCoverageRow {
  tool: string;
  version: string;
  status: ModuleCoverageStatus;
  detail: string;
}

export interface ModuleFinding {
  tool: string;
  rule: string;
  file: string;
  line: number;
  severity: ModuleFindingSeverity;
  message: string;
  evidence: string;
}

export interface ModuleCollectorOutput {
  coverage: ModuleCoverageRow[];
  findings: ModuleFinding[];
}

export interface DiscoveredManifest {
  rel: string;
  fullPath: string;
}

export interface DiscoveredSourceFile {
  rel: string;
  fullPath: string;
  ext: string;
}

export interface DiscoveredRepoFiles {
  manifests: DiscoveredManifest[];
  lockfiles: Map<string, string>;
  sourceFiles: DiscoveredSourceFile[];
  javaFiles: DiscoveredManifest[];
  sbomFiles: DiscoveredManifest[];
  hasJavaProject: boolean;
  skippedJavaSources: number;
  skippedSymlinks: number;
  skippedOversized: number;
  skippedManifestLimit: number;
  skippedSourceLimit: number;
  skippedSourceBytes: number;
  readErrors: number;
}

export interface RegistrySnapshot {
  path: string;
  versions: Record<string, unknown>;
  error?: string;
}

export function toRepoRelPath(rawPath: string, fallback?: string): string;
export function readSafeRegularFile(filePath: string, maxBytes?: number): Promise<string | null>;
export function discoverRepoFiles(repoRoot: string): Promise<DiscoveredRepoFiles>;
export function findLineInPackageJson(rawText: string, pkgName: string, preferredSection?: string): number;
export function isUnpinnedSpecifier(spec: string): boolean;
export function classifySemverRisk(
  currentSpec: string,
  targetSpec: string
): {diff: string; severity: ModuleFindingSeverity; rule: string; riskLabel: string};
export function satisfiesRange(versionStr: string, rangeSpec: string): boolean;
export function parseAstGrepJson(rawStdout: string, srcRootDir: string): ModuleFinding[];
export function verifyToolsAgainstLock(toolsRoot?: string): Promise<Record<string, string>>;
export function resolveRegistrySnapshot(customPath?: string, defaultPaths?: string[]): Promise<RegistrySnapshot | null>;
export function analyzeLockfileAndSbom(input: {
  manifests: DiscoveredManifest[];
  lockfiles: Map<string, string>;
  sbomFiles: DiscoveredManifest[];
  registry: RegistrySnapshot | null;
  ncuDetectedPackages: Set<string>;
  mountedSbomPaths?: string[];
}): Promise<ModuleCollectorOutput>;
export function validateModuleOutput(doc: unknown): ModuleCollectorOutput;
export function runCollection(options?: {
  repoRoot?: string;
  onlineMode?: boolean;
  registryGet?: RegistryRequestOptions['get'];
  registryPath?: string;
  ncuBin?: string;
  astGrepBin?: string;
  jscodeshiftBin?: string;
  ncuVersion?: string;
  astGrepVersion?: string;
  jscodeshiftVersion?: string;
  sgConfigPath?: string;
  transformPath?: string;
  openRewriteHome?: string;
}): Promise<ModuleCollectorOutput>;

export function runAstGrepCheck(input: {sourceFiles: DiscoveredSourceFile[]; isoSrcDir: string; astGrepBin: string; astGrepVersion: string; sgConfigPath: string}): Promise<ModuleCollectorOutput>;
export function runJscodeshiftCheck(input: {
  sourceFiles: DiscoveredSourceFile[];
  isoSrcDir: string;
  isoCodemodDir: string;
  workRoot: string;
  jscodeshiftBin: string;
  jscodeshiftVersion: string;
  transformPath: string;
  fileTimeoutMs?: number;
  totalTimeoutMs?: number;
}): Promise<ModuleCollectorOutput>;
