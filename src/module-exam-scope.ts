import type {VerificationModule} from './ledger.ts';

// Path and content rules that route each file to the functional modules 2 to 9.
// A file outside a module's rule is not sent to that module's examiner; the caller
// keeps it in the coverage as not judged, with the rule id as the reason.
const VENDOR = /(?:^|\/)(?:vendor|node_modules|third_party)\//u;
const GEN = /(?:\.pb\.go|\.sql\.go|_gen\.go)$|(?:^|\/)dbgen\//u;
const CODE = /\.(?:go|ts|tsx|js|jsx|mjs|cjs|py|rb|java|kt|rs|php|cs)$/iu;
const TEST = /(?:_test\.go|\.(?:test|spec)\.[^/]+|_test\.py)$|(?:^|\/)(?:__tests__|tests?|e2e|acceptance|testdata)\//u;
// A docs/ folder makes only its non-code files documentation: internal/docs/handler.go is still code.
const DOC = /\.(?:md|mdx|rst|adoc)$/iu;
const DOCS_DIR = /(?:^|\/)docs\//u;
const MANIFEST = /^(?:go\.(?:mod|sum)|package[^/]*\.json|npm-shrinkwrap\.json|[^/]*\.lock|[^/]*\.lockb|[^/]*-lock\.(?:json|ya?ml)|gradle\.lockfile|requirements[^/]*|pyproject\.toml|Pipfile|Gemfile|Cargo\.toml|pom\.xml|[^/]*\.gradle(?:\.kts)?|composer\.json)$/u;
const DOCKERFILE = /^(?:Dockerfile[^/]*|[^/]*\.dockerfile)$/iu;
const WORKFLOW = /(?:^|\/)\.github\/workflows\//u;
const SQL = /\.sql$/iu;
const DB_PATH = /(?:^|\/)(?:migrations?|queries|schema)\/|(?:^|\/)sqlc\.(?:ya?ml|json)$/iu;
const DB_CODE = /database\/sql|pgx|\bsqlx\b|\bgorm\b|dbgen\.|\.(?:Query|QueryRow|Exec|QueryContext|ExecContext|SendBatch|CopyFrom|BeginTx|Begin)\(|FOR UPDATE/u;
const READY_PATH = /^(?:(?:docker-)?compose[^/]*\.ya?ml|Caddyfile[^/]*|[^/]*\.conf|[^/]*\.(?:service|timer)|\.dockerignore|[^/]*\.(?:sh|ps1))$/iu;
const READY_DIR = /(?:^|\/)deploy\/|(?:^|\/)cmd\/[^/]+\/[^/]+\.go$/u;
const READY_CODE = /os\.Getenv|LookupEnv|process\.env|import\.meta\.env|ListenAndServe|http\.Server\{|signal\.Notify|healthz|readyz|Shutdown\(|SetMaxOpenConns|MaxConns|ReadHeaderTimeout|WriteTimeout/u;
const PERF_CODE = /\bfor |\brange |useEffect|useMemo|setInterval|time\.Sleep|go func|sync\.(?:RW)?Mutex|sync\.WaitGroup|\.Query|\.Exec\(|http\.(?:Get|Post)|\.Do\(|fetch\(|io\.ReadAll|regexp\.(?:Must)?Compile/u;
const PERF_SQL = /(?:^|\/)queries\/.*\.sql$/iu;
const DOC_TEXT = /\.(?:md|mdx|rst|adoc)$|(?:^|\/)docs\/.*\.(?:txt|ya?ml|json)$/iu;
const DOC_EXTRA = /^(?:README[^/]*|openapi[^/]*\.(?:json|ya?ml))$/iu;
const DOC_MEASUREMENTS = /(?:^|\/)docs\/medicoes\//u;
const LICENSE = /^(?:LICEN[CS]E|COPYING|NOTICE)[^/]*$/iu;
const PERSONAL_DATA = /cpf|cnpj|e-?mail|telefone|phone|whatsapp|endere[cç]o|address|nascimento|lgpd|consent|privac|reten[cç][aã]o|retention|anonimiz|pseudonym|redact|pessoa|titular|remote_addr|user_agent|geoloc/iu;

type Facts = {file: string; base: string; code: string; test: boolean; doc: boolean; runtime: boolean; manifest: boolean};
const rules: Record<VerificationModule, {id: string; covers: (facts: Facts) => boolean}> = {
  qa: {id: 'qa-codigo', covers: f => CODE.test(f.file) && !GEN.test(f.file) && !f.doc},
  arquitetura: {id: 'arquitetura-execucao', covers: f => f.runtime},
  dependencias: {id: 'dependencias-manifestos', covers: f => f.manifest || DOCKERFILE.test(f.base) || WORKFLOW.test(f.file)},
  banco: {id: 'banco-dados', covers: f => SQL.test(f.file) || DB_PATH.test(f.file) || (f.runtime && DB_CODE.test(f.code))},
  prontidao: {id: 'prontidao-configuracao', covers: f => !f.test && !f.doc && (DOCKERFILE.test(f.base) || READY_PATH.test(f.base)
    || WORKFLOW.test(f.file) || READY_DIR.test(f.file) || (f.runtime && READY_CODE.test(f.code)))},
  desempenho: {id: 'desempenho-custo', covers: f => PERF_SQL.test(f.file) || (f.runtime && PERF_CODE.test(f.code))},
  documentacao: {id: 'documentacao-textos', covers: f => !DOC_MEASUREMENTS.test(f.file) && (DOC_TEXT.test(f.file) || DOC_EXTRA.test(f.base))},
  // A license file is a compliance source even when written in Markdown.
  conformidade: {id: 'conformidade-licencas-dados', covers: f => LICENSE.test(f.base) || (!f.test && !f.doc
    && (f.manifest || ((SQL.test(f.file) || f.runtime) && PERSONAL_DATA.test(f.code))))},
};

/** Returns null when `file` belongs to `module`, or the id of the rule that left it out.
 * A module without a rule (outside 2 to 9) takes every file. */
export function moduleExamScope(module: VerificationModule, file: string, code: string | null): string | null {
  const rule = rules[module] as (typeof rules)[VerificationModule] | undefined;
  if (!rule) return null;
  if (VENDOR.test(file)) return 'vendor';
  const base = file.slice(file.lastIndexOf('/') + 1);
  const test = TEST.test(file);
  const doc = DOC.test(file) || (DOCS_DIR.test(file) && !CODE.test(file));
  const facts = {file, base, code: code ?? '', test, doc, manifest: MANIFEST.test(base),
    runtime: CODE.test(file) && !test && !GEN.test(file) && !doc};
  return rule.covers(facts) ? null : rule.id;
}
