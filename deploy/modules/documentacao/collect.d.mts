type Coverage = {
  tool: string;
  version: string;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
};

type Finding = {
  tool: string;
  rule: string;
  file: string;
  line: number;
  severity: 'alta' | 'media' | 'baixa' | 'informativa';
  message: string;
  evidence: string;
};

type Symbol = {
  name: string;
  qualifiedName: string;
  kind: number;
  file: string;
  line: number;
  hasDoc: boolean;
  summaryText: string;
  blockTags: {tag: string; name: string; text: string}[];
  parameters: {name: string; optional: boolean; hasDoc: boolean}[];
};

type Block = {file: string; startLine: number; code: string};
type ReadFile = (file: string) => string;
type MermaidParse = (code: string) => Promise<unknown>;
type DocumentReferences = ReadonlyMap<Block, {
  moduleEdges: {from: string; to: string; line: number; rawLine: string}[];
  unmeasured: number;
}>;
type CopyLimits = {maxFileBytes?: number; maxFiles?: number; maxCopyBytes?: number};
type ToolResult = {status: number | null; stdout?: string; stderr?: string; error?: Error; signal?: string | null};
type ToolOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  encoding: 'utf8';
  timeout: number;
  maxBuffer: number;
};

export function normalizeRepoPath(file: string, root?: string): string;
export function clampLine(value: number): number;
export function copyRepoSafely(source: string, destination: string, options?: CopyLimits): {
  copiedFiles: string[];
  skipped: string[];
};
export function sanitizeTsConfigInWork(workRepoDir: string, codeFiles?: string[]): string;
export function extractMermaidBlocks(files: string[], readFile?: ReadFile): Block[];
export function createDefaultMermaidParser(toolsRoot?: string): Promise<MermaidParse>;
export function parseTypedocReport(json: unknown, diagnostics: string, root: string, readFile?: ReadFile, toolsRoot?: string): {
  findings: Finding[];
  symbols: Symbol[];
};
export function crossCheckMarkdownAgainstTypedoc(files: string[], symbols: Symbol[], readFile?: ReadFile): Finding[];
export function parseDepcruiseReport(
  json: unknown, diagram: string, root: string, blocks?: Block[], readFile?: ReadFile, resolutionPartial?: boolean,
  documentReferences?: DocumentReferences,
): {
  findings: Finding[];
  checkedEdgesByFile: Map<string, number>;
  skippedEdgesByFile: Map<string, number>;
  unmeasuredByFile: Map<string, number>;
  stats: {checkedEdges: number; skippedEdges: number; unmeasured: number; edgeMismatches: number};
};
export function validateMermaidDocuments(
  files: string[], blocks: Block[], repositoryFiles: ReadonlySet<string>, parse: MermaidParse, generated?: string,
): Promise<{findings: Finding[]; documentReferences: DocumentReferences}>;
export function runCollector(options?: CopyLimits & {
  repoDir?: string;
  tmpBase?: string;
  toolsRoot?: string;
  execFn?: (bin: string, args: string[], options: ToolOptions) => ToolResult;
  mermaidParseFn?: MermaidParse;
}): Promise<{coverage: Coverage[]; findings: Finding[]}>;
