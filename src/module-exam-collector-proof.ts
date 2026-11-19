import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {digest} from './contracts.ts';
import type {VerificationModule} from './ledger.ts';
import {functionAnchor, jsonMembers, singleScriptAnchor, singleScriptCallAnchor, sourceLine, sqlStatement, type SourceAnchor} from './module-exam-proof-source.ts';
import {isDirectIdentifier, isModuleExamScript} from './module-exam-syntax.ts';
import {hasKnownSecret, redactUnknownSecrets} from './verify-redact.ts';
import type {ModuleRawFinding, ModuleToolCoverage} from './verification-modules.ts';

export type ModuleExamCollectorContext = {
  module: VerificationModule;
  intentId: string;
  snapshot: string;
  commit: string;
  exitCode: number;
  coverage: readonly ModuleToolCoverage[];
  findings: readonly ModuleRawFinding[];
};

export const collectorQuestions = {
  'qa-mutant-survived': 'Qual comparação original recebeu a alteração registrada e quantos testes passaram com o mutante?',
  'qa-v8-unexecuted-function': 'Qual função exportada registrou contagem zero nas três passadas completas do V8?',
  'knip-unreached-export': 'Qual função exportada está no arquivo classificado como não alcançado pelo Knip neste exame?',
  'relative-import-cycle': 'Quais imports relativos dos arquivos do mesmo snapshot fecham o ciclo apontado pelo Dependency Cruiser?',
  'ast-grep-express-del': 'Qual chamada direta de app.del ou router.del corresponde ao padrão de migração medido?',
  'sql-drop-column': 'Qual tabela e coluna aparecem no comando DROP COLUMN sinalizado pelo Squawk?',
  'sql-historical-invariant': 'Qual SELECT retornou true antes da atualização e deixou de retornar true depois, no mesmo banco restaurado?',
  'sql-query-mean-exceeded': 'Qual SELECT tem média acima do limiar de latência nas amostras do banco descartável?',
  'sql-hypothetical-index-savings': 'Qual tabela e coluna da consulta correspondem ao índice hipotético que reduziu o custo estimado?',
  'tls-certificate-option-false': 'Qual propriedade de objeto declara false para a validação de certificado TLS?',
  'cpu-own-time-exceeded': 'Qual função teve tempo próprio amostral acima do limiar registrado?',
  'k6-route-p95-exceeded': 'Qual declaração liga a rota ao p95 acima do limiar registrado pelo k6?',
  'typedoc-undocumented-export': 'Qual função exportada carece de JSDoc adjacente e aparece no inventário TypeDoc?',
  'ort-declared-strong-copyleft': 'Qual entrada de dependência no lockfile declara a licença de copyleft forte processada pelo ORT?',
} as const;

export type CollectorCriterion = keyof typeof collectorQuestions;
export const collectorCriteria = Object.keys(collectorQuestions) as [CollectorCriterion, ...CollectorCriterion[]];

export const collectorReasonTemplates: Record<CollectorCriterion, string> = {
  'qa-mutant-survived': 'A comparação {expressao} recebeu {1}. A medição registrou {2} testes aprovados com o mutante.',
  'qa-v8-unexecuted-function': 'O V8 registrou zero execuções de {1} em cada uma das três passadas deste exame.',
  'knip-unreached-export': 'O arquivo declara a função exportada {1}. O Knip o classificou como não alcançado a partir das entradas analisadas neste exame.',
  'relative-import-cycle': 'Os imports {lista} fecham o ciclo que parte de {arquivo} no snapshot.',
  'ast-grep-express-del': 'A chamada direta {1}.{2} corresponde ao padrão de migração do coletor.',
  'sql-drop-column': 'A migração declara DROP COLUMN para {1}.{2} no comando localizado pelo Squawk.',
  'sql-historical-invariant': 'No mesmo banco restaurado {1}, o SELECT retornou true antes da atualização e deixou de retornar true após a atualização.',
  'sql-query-mean-exceeded': 'O SELECT localizado teve média de {3} ms em {2} amostras da consulta {1}. O limiar foi de {4} ms.',
  'sql-hypothetical-index-savings': 'O índice hipotético em {1} ({2}) reduziu o custo estimado de {3} para {4} nas condições do ensaio.',
  'tls-certificate-option-false': 'O objeto declara {1} com valor literal {2}.',
  'cpu-own-time-exceeded': '{1} teve {2} ms de tempo próprio ({3}/{4} amostras) em uma chamada isolada. O limiar foi de {5} ms.',
  'k6-route-p95-exceeded': 'A rota declarada {1} teve p95 de {3} ms em {5} requisições, acima do limiar de {4} ms.',
  'typedoc-undocumented-export': 'A declaração exportada {1} consta do inventário TypeDoc e está sem JSDoc adjacente.',
  'ort-declared-strong-copyleft': 'A dependência {1} declara {2} na entrada do lockfile processada pelo ORT.',
};

type ExamCase = {criterion: CollectorCriterion; anchor: SourceAnchor; facts: string[];
  rows: readonly ModuleToolCoverage[]; firstContextLine?: number; lastContextLine?: number;
  related?: {file: string; line: number; code: string; sourceDigest: string}[]};
type CaseInput = {raw: ModuleRawFinding; context: ModuleExamCollectorContext; source: string;
  wasExamined: (file: string, source: string) => boolean;
  relatedSources?: ReadonlyMap<string, string | null>};
type CaseBuilder = (input: CaseInput) => ExamCase | null | undefined;

const identifier = '[A-Za-z_$][\\w$]*';
const sameFindingFields = ['tool', 'rule', 'file', 'line', 'evidence', 'message', 'severity'] as const;
const safeText = (text: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f…]/u.test(text) && !hasKnownSecret(text);
const number = '(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?';
const numeric = (value: string) => new RegExp('^' + number + '$').test(value) && Number.isFinite(Number(value));

function scopedRow(input: CaseInput, tool: string, scope: (row: ModuleToolCoverage) => boolean) {
  const matches = input.context.coverage.filter(row => row.tool === tool && scope(row));
  return matches.length === 1 && matches[0]!.status === 'ok' ? matches[0] : undefined;
}

function qaMutant(input: CaseInput): ExamCase | undefined {
  const {raw, source} = input;
  const prefix = `${raw.file}:${raw.line} EqualityOperator → `;
  if (!raw.evidence.startsWith(prefix)) return;
  const rest = /^(.+): node:test aprovou após o patch com os mesmos resultados da referência \(([1-9]\d*) testes aprovados\)$/.exec(raw.evidence.slice(prefix.length));
  if (!rest) return;
  const replacement = rest[1]!;
  const passed = rest[2]!;
  const pieces = new RegExp(`^(${identifier})\\s*(===|!==|==|!=|>=|<=|>|<)\\s*(0|[1-9]\\d*)$`).exec(replacement);
  if (!pieces || !Number.isSafeInteger(Number(passed))) return;
  const [, lhs, operator, rhs] = pieces;
  const originalOperators: Record<string, string> = {'===': '!==', '!==': '===', '==': '!=', '!=': '==', '>': '>=', '>=': '>', '<': '<=', '<=': '<'};
  const expected = originalOperators[operator!]!;
  const patch = prefix + replacement;
  const rowCandidates = input.context.coverage.filter(row => /^qa-mutante:[1-9]\d*$/.test(row.tool)
    && (row.detail.includes(` | ${patch} |`) || row.detail.startsWith(`${patch}:`)));
  if (rowCandidates.length !== 1) return;
  const row = rowCandidates[0]!;
  if (row.status !== 'ok' || row.detail !== `sobrevivente | ${patch} | ${raw.evidence.slice(patch.length + 2)}`) return;
  const anchor = singleScriptAnchor(source, raw.line, (tokens, start) => {
    const actual = start + expected.length + 1;
    const operatorTokens = tokens.slice(start + 1, actual);
    if (operatorTokens.map(token => token.text).join('') !== expected
      || !operatorTokens.every((token, index) => index === 0 || token.start === operatorTokens[index - 1]!.end)) return null;
    return tokens[start - 1]?.text === '(' && tokens[start]?.text === lhs
      && tokens[actual]?.text === rhs && tokens[actual + 1]?.text === ')' ? actual : null;
  });
  if (!anchor) return;
  return {criterion: 'qa-mutant-survived', anchor, facts: [replacement, passed], rows: [row]};
}

function qaFunction(input: CaseInput): ExamCase | undefined {
  const {raw, source} = input;
  if (raw.evidence !== 'contagem V8 da função nas passadas 1, 2 e 3: 0, 0, 0') return;
  const found = functionAnchor(source, raw.line, true);
  if (!found || raw.message !== `Função exportada '${found.name}' sem execução medida pelo V8`) return;
  // Paths that need special encoding or abbreviating are outside this subset.
  if (/[%|~\s]/u.test(raw.file) || `qa-arquivo:${raw.file}`.length > 120) return;
  const row = scopedRow(input, `qa-arquivo:${raw.file}`, () => true);
  const count = '(0|[1-9]\\d*)';
  const header = 'V8 em três passadas: ramos';
  // The shared redactor matches the fixed label "passadas: ramos".
  // Only the known fixed spelling or its exact masked form is accepted.
  const prefix = row?.detail.startsWith(header) ? header : redactUnknownSecrets(header);
  const pass = `${count}/${count}, funções ${count}/${count}`;
  const parts = row?.detail.startsWith(prefix + ' ') &&
    new RegExp(`^${pass}; ramos ${pass}; ramos ${pass}$`).exec(row.detail.slice(prefix.length + 1));
  if (!row || !parts) return;
  const totals = parts.slice(1).map(Number);
  for (let index = 0; index < totals.length; index += 4) {
    const [branches, allBranches, functions, allFunctions] = totals.slice(index, index + 4) as [number, number, number, number];
    if (![branches, allBranches, functions, allFunctions].every(Number.isSafeInteger)
      || branches > allBranches || functions >= allFunctions
      || (index > 0 && (allBranches !== totals[1] || allFunctions !== totals[3]))) return;
  }
  const passes = [0, 4, 8].map(index => `ramos ${totals[index]}/${totals[index + 1]}, funções ${totals[index + 2]}/${totals[index + 3]}`);
  const publicRow = {...row, detail: 'V8 nas três passadas — ' + passes.join('; ')};
  return {criterion: 'qa-v8-unexecuted-function', anchor: found.anchor, facts: [found.name, '0', '0', '0'], rows: [publicRow]};
}

function knipFile(input: CaseInput): ExamCase | undefined {
  const {raw, source} = input;
  if (raw.line !== 1 || raw.evidence !== `knip files: ${raw.file}`) return;
  const prefix = `arquivo=${raw.file}; papel=`;
  const row = scopedRow(input, 'knip:file', row => row.detail.startsWith(prefix));
  const found = functionAnchor(source, raw.line, true);
  if (!row || !found || !/^nao_alcancado; problemas=[1-9]\d*$/.test(row.detail.slice(prefix.length))) return;
  return {criterion: 'knip-unreached-export', anchor: found.anchor, facts: [found.name, 'nao_alcancado'], rows: [row]};
}

function staticImport(source: string, line: number) {
  return singleScriptAnchor(source, line, (tokens, start) => {
    if (tokens[start]?.text !== 'import' || tokens[start - 1]?.line === line) return null;
    const end = tokens.findIndex((token, index) => index > start && token.line === line && token.kind === 'literal'
      && (index === start + 1 || tokens[index - 1]?.text === 'from'));
    if (end < 0 || !/^(['"])\.\.?\/[\w./-]+\1$/u.test(tokens[end]!.text)
      || tokens[end + 1]?.line === line && tokens[end + 1]?.text !== ';') return null;
    return end;
  });
}

function importCycle(input: CaseInput): ExamCase | undefined {
  const {raw, source, relatedSources} = input;
  if (!relatedSources || relatedSources.get(raw.file) !== source || !raw.evidence.startsWith('ciclo: ')) return;
  const chain = raw.evidence.slice('ciclo: '.length).split(' -> ');
  const ring = chain.slice(0, -1);
  if (ring.length < 2 || ring.length > 5 || chain[0] !== raw.file || chain.at(-1) !== raw.file
    || new Set(ring).size !== ring.length || ring.some(file => !/^[\w.-]+(?:\/[\w.-]+)*$/.test(file)
      || file.split('/').some(segment => segment === '..' || segment === '.') || !isModuleExamScript(file))) return;
  const rows: ModuleToolCoverage[] = [];
  const related: NonNullable<ExamCase['related']> = [];
  const specifiers: string[] = [];
  let firstAnchor: SourceAnchor | undefined;
  for (const [index, file] of ring.entries()) {
    const next = chain[index + 1]!;
    const code = index === 0 ? source : relatedSources.get(file);
    const prefix = `arquivo=${file}; `;
    const row = scopedRow(input, 'dependency-cruiser:file', row => row.detail.startsWith(prefix));
    if (!code || code.length > 16000 || !safeText(code) || (index > 0 && !input.wasExamined(file, code)) || !row
      || !/^deps=[1-9]\d*; dependentes=[1-9]\d*; instabilidade=(?:n\/a|[01]\.\d\d); ciclo=sim; violacao_camada=(?:sim|nao)$/
        .test(row.detail.slice(prefix.length))) return;
    const candidates = code.split('\n').slice(0, 40).flatMap((_, position) => {
      const line = position + 1;
      if (index === 0 && line !== raw.line) return [];
      const anchor = staticImport(code, line);
      const specifier = anchor && /['"](\.\.?\/[\w./-]+)['"]$/u.exec(anchor.expression)?.[1];
      if (!anchor || !specifier) return [];
      const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
      const replacement: Record<string, string[]> = {'.js': ['.ts', '.tsx', '.jsx'], '.mjs': ['.mts'], '.cjs': ['.cts']};
      const extension = posix.extname(resolved);
      const variants = [resolved, ...(replacement[extension] ?? []).map(suffix => resolved.slice(0, -extension.length) + suffix)];
      const present = variants.filter(path => relatedSources.has(path));
      return present.length === 1 && present[0] === next ? [{anchor, specifier, line}] : [];
    });
    if (candidates.length !== 1) return;
    const edge = candidates[0]!;
    rows.push(row);
    specifiers.push(edge.specifier);
    if (index === 0) firstAnchor = edge.anchor;
    else related.push({file, line: edge.line, code: edge.anchor.expression, sourceDigest: digest(code)});
  }
  if (!firstAnchor) return;
  return {criterion: 'relative-import-cycle', anchor: firstAnchor, facts: specifiers, rows, related};
}

function expressDel(input: CaseInput): ExamCase | undefined {
  const {raw, source} = input;
  const prefix = `arquivo=${raw.file}; `;
  const row = scopedRow(input, 'ast-grep', row => row.detail.startsWith(prefix));
  if (!row || !/^achados=[1-9]\d*$/.test(row.detail.slice(prefix.length))) return;
  const found = singleScriptCallAnchor(source, raw.line, (tokens, start) => {
    if (!isDirectIdentifier(tokens, start) || !['app', 'router'].includes(tokens[start]!.text)
      || tokens[start + 1]?.text !== '.' || tokens[start + 2]?.text !== 'del') return null;
    return start + 3;
  });
  if (!found || raw.evidence !== `Revisão necessária: ${found.expression}`) return;
  const {anchor} = found;
  return {criterion: 'ast-grep-express-del', anchor, facts: [anchor.expression.split('.')[0]!, 'del'], rows: [row],
    lastContextLine: found.lastLine};
}

function dropColumn(input: CaseInput): ExamCase | undefined {
  const {raw, source} = input;
  if (!raw.file.endsWith('.sql')) return;
  const prefix = `squawk:file:${raw.file}: `;
  const row = scopedRow(input, 'squawk', row => row.detail.startsWith(prefix));
  if (!row?.files?.includes(raw.file) || !/^[1-9]\d* alertas$/.test(row.detail.slice(prefix.length))) return;
  const diagnostic = /^Regra ban-drop-column; coluna ([1-9]\d*); migração analisada em modo transacional\.$/.exec(raw.evidence);
  const statement = sqlStatement(source, raw.line);
  if (!diagnostic || !statement) return;
  const pattern = /^ALTER TABLE ([A-Z_][\w]*(?: \. [A-Z_][\w]*)?) DROP COLUMN ([A-Z_][\w]*)(?: (?:CASCADE|RESTRICT))? ;$/i;
  const names = pattern.exec(statement.tokens.join(' '));
  const anchor = statement.anchor();
  if (!names || !anchor || /[\r\n]/u.test(anchor.expression)
    || !/;$/u.test(anchor.expression)) return;
  const sourceIndent = /^\s*/u.exec(source.split('\n')[raw.line - 1]!)![0].length;
  // Squawk can locate either the statement or the DROP token on the same line.
  const diagnosticColumn = Number(diagnostic[1]);
  if (diagnosticColumn !== sourceIndent + anchor.column
    && diagnosticColumn !== sourceIndent + anchor.column + anchor.expression.search(/\bDROP\b/iu)) return;
  const table = names[1]!.replaceAll(' ', '');
  const column = names[2]!;
  return {criterion: 'sql-drop-column', anchor, facts: [table, column], rows: [row]};
}

function historicalInvariant(input: CaseInput): ExamCase | undefined {
  const {raw, source} = input;
  if (!raw.file.endsWith('.sql') || raw.evidence !== 'O SELECT de verificação não retornou true (após atualização).') return;
  const result = /^O invariante dos dados antigos falhou em ([a-z][a-z_0-9]*)\.$/.exec(raw.message);
  if (!result) return;
  const database = result[1]!;
  const prefix = `pg_restore:${database}:${raw.file}: `;
  const before = 'antes da atualização';
  const after = 'após atualização';
  const baseline = scopedRow(input, 'pg_restore', row => row.detail.startsWith(prefix + before + ','));
  const updated = scopedRow(input, 'pg_restore', row => row.detail.startsWith(prefix + after + ','));
  const statement = sqlStatement(source, raw.line);
  const anchor = statement?.anchor(true);
  if (!baseline || baseline.detail !== prefix + before + ', invariante preservado'
    || !updated || updated.detail !== prefix + after + ', invariante falhou' || baseline.version !== updated.version || !statement
    || statement.count !== 1 || statement.tokens[0]?.toUpperCase() !== 'SELECT' || statement.tokens.length < 3
    || !anchor || !/^SELECT\s+\S/iu.test(anchor.expression)) return;
  return {criterion: 'sql-historical-invariant', anchor, facts: [database, before, 'preservado', after, 'falhou'],
    rows: [baseline, updated], lastContextLine: statement.lastLine};
}

function sqlMean(input: CaseInput): ExamCase | undefined {
  const {raw, source} = input;
  if (!raw.file.endsWith('.sql') || raw.message !== 'A consulta atingiu a média de 100 ms na carga ensaiada.') return;
  const result = /^queryid=(-?[1-9]\d*); amostras=3; média=(\d+\.\d{3}) ms; blocos hit\/read=(\d+)\/(\d+)$/.exec(raw.evidence);
  const prefix = `pg_stat_statements:query:${raw.file}: linha ${raw.line}; `;
  const row = scopedRow(input, 'pg_stat_statements', row => row.detail.startsWith(prefix));
  const statement = sqlStatement(source, raw.line);
  const anchor = statement?.anchor(true);
  // The collector hashes the exact SQL bytes it passes to PostgreSQL in this
  // measurement. The server queryid is an opaque identifier from that run.
  const sourceSha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  if (!row?.files?.includes(raw.file) || row.detail !== `${prefix}${raw.evidence} | SQL medido (sha256:${sourceSha256})` || !result || !anchor
    || !/^SELECT\s+\S/iu.test(anchor.expression) || statement?.count !== 1
    || !numeric(result[2]!) || Number(result[2]) <= 100) return;
  return {criterion: 'sql-query-mean-exceeded', anchor, facts: [result[1]!, '3', result[2]!, '100'], rows: [row],
    lastContextLine: statement.lastLine};
}

function hypotheticalIndex(input: CaseInput): ExamCase | undefined {
  const {raw, source} = input;
  if (!raw.file.endsWith('.sql')) return;
  const prefix = `dexter:query:${raw.file}: linha ${raw.line}; `;
  const row = scopedRow(input, 'dexter', row => row.detail.startsWith(prefix));
  const result = /^redução estimada de (\d+\.\d{2}) para (\d+\.\d{2}) unidades de custo; candidatos: ([A-Za-z_][\w]*\.[A-Za-z_][\w]*) \/ ([A-Za-z_][\w]*)$/
    .exec(raw.evidence);
  const statement = sqlStatement(source, raw.line);
  const anchor = statement?.anchor();
  // For a single table and a single equality predicate, the proposed index's
  // table and column can both be resolved from the actual measured SELECT.
  const query = statement && /^SELECT [A-Za-z_][\w]* FROM ([A-Za-z_][\w]* \. [A-Za-z_][\w]*) WHERE ([A-Za-z_][\w]*) = \d+ ;$/i
    .exec(statement.tokens.join(' '));
  if (!row?.files?.includes(raw.file) || row.detail !== prefix + 'planos hipotéticos comparados'
    || !result || !query || !anchor || statement?.count !== 1) return;
  const before = result[1]!;
  const after = result[2]!;
  const table = result[3]!;
  const column = result[4]!;
  if (query[1]!.replaceAll(' ', '') !== table || query[2] !== column || !numeric(before) || !numeric(after)
    || Number(before) < 100 || Number(after) >= Number(before) / 2) return;
  return {criterion: 'sql-hypothetical-index-savings', anchor, facts: [table, column, before, after], rows: [row]};
}

function tlsOption(input: CaseInput): ExamCase | undefined {
  const {raw, source} = input;
  const prefix = `${raw.file}: `;
  const row = scopedRow(input, 'prontidao:arquivo', row => row.detail.startsWith(prefix));
  if (!row || raw.evidence !== 'Diretiva de validação de certificado TLS desabilitada.'
    || !/^verificações \[[\w, -]*\btls-verify\b[\w, -]*\], [1-9]\d* achado\(s\)\.$/.test(row.detail.slice(prefix.length))) return;
  const anchor = singleScriptAnchor(source, raw.line, (tokens, start) => {
    const preceding = tokens[start - 1]?.text;
    const follows = tokens[start + 3]?.text;
    if (tokens[start]?.text !== 'rejectUnauthorized' || tokens[start + 1]?.text !== ':'
      || tokens[start + 2]?.text !== 'false' || ![',', '}'].includes(follows ?? '')
      || !['{', ','].includes(preceding ?? '')) return null;
    // Accept only a simple object with literal members. Duplicates, spread,
    // computed members and later overrides need a wider proof.
    const before = tokens.slice(0, start).map(token => token.text);
    const open = before.lastIndexOf('{');
    const close = tokens.findIndex((token, index) => index > start && token.text === '}');
    if (open < 1 || close < 0 || !['return', '=', '(', '['].includes(before[open - 1]!)) return null;
    const properties = tokens.slice(open + 1, close);
    const names = new Set<string>();
    for (let i = 0; i < properties.length; i += 4) {
      const key = properties[i];
      const value = properties[i + 2];
      if (key?.kind !== 'word' || names.has(key.text) || properties[i + 1]?.text !== ':' || !value
        || !(value.kind === 'literal' || value.kind === 'number' || /^(?:true|false|null)$/.test(value.text))
        || (i + 3 < properties.length && properties[i + 3]?.text !== ',')) return null;
      names.add(key.text);
    }
    return start + 2;
  }, true);
  if (!anchor) return;
  return {criterion: 'tls-certificate-option-false', anchor, facts: ['rejectUnauthorized', 'false'], rows: [row]};
}

function cpuProfile(input: CaseInput): ExamCase | undefined {
  const {raw, source} = input;
  if (!isModuleExamScript(raw.file)) return;
  const found = functionAnchor(source, raw.line, false);
  if (!found) return;
  const location = `arquivo=${raw.file}:${raw.line}; `;
  const prefix = `${location}função=${found.name}; `;
  const row = scopedRow(input, 'node-cpu-prof:arquivo', row => row.detail.startsWith(prefix)
    || row.detail.startsWith(`${raw.file} (${found.name}):`));
  const evidence = raw.evidence.startsWith(prefix) && new RegExp(
    `^tempo próprio amostral=(${number})ms; amostras próprias=([1-9]\\d*)/([1-9]\\d*); limiar=(${number})ms$`,
  ).exec(raw.evidence.slice(prefix.length));
  if (!row?.files?.includes(raw.file) || row.detail !== raw.evidence + '; recorte: uma chamada isolada sem argumentos'
    || !evidence) return;
  const [, own, samples, total, limit] = evidence as unknown as [string, string, string, string, string];
  if (!numeric(own) || !numeric(limit) || Number(own) <= Number(limit) || Number(limit) <= 0
    || ![samples, total].every(value => Number.isSafeInteger(Number(value))) || Number(samples) > Number(total)) return;
  return {criterion: 'cpu-own-time-exceeded', anchor: found.anchor, facts: [found.name, own, samples, total, limit], rows: [row]};
}

function k6Latency(input: CaseInput): ExamCase | undefined {
  const {raw, source} = input;
  if (!raw.file.endsWith('.json')) return;
  const origin = `declaração da rota em ${raw.file}:${raw.line}; arquivo associado=`;
  if (!raw.evidence.startsWith(origin)) return;
  const metric = /^([^;]+); métrica da resposta HTTP; rota=(\/[\w/.~-]*) p95=(\d+\.\d)ms avg=(?:n\/a|\d+\.\d)ms max=(?:n\/a|\d+\.\d)ms exit=(?:0|99)$/.exec(raw.evidence.slice(origin.length));
  if (!metric) return;
  const [, associated, route, p95] = metric as unknown as [string, string, string, string];
  const scope = `arquivo=${associated}; rota=${route}; `;
  const row = scopedRow(input, `k6:rota:${route}`, () => true);
  const summary = scopedRow(input, 'k6', () => true);
  const thresholds = summary && new RegExp(`^[1-9]\\d* rota\\(s\\) testada\\(s\\) com limites \\(p95<(${number})ms, falhas<${number}%\\); [1-9]\\d* achado\\(s\\)$`).exec(summary.detail);
  if (!row?.files?.includes(associated) || !row.detail.startsWith(scope) || !thresholds || !summary
    || row.version !== summary.version) return;
  const measured = /^requisições=([1-9]\d*); p95=(\d+\.\d)ms; falhas=(\d+\.\d+)%$/.exec(row.detail.slice(scope.length));
  const limit = thresholds[1]!;
  if (!measured || measured[1] !== '3' || measured[2] !== p95 || Number(measured[3]) > 100
    || !numeric(limit) || !numeric(p95) || Number(limit) <= 0 || Number(p95) <= Number(limit)) return;
  const json = jsonMembers(source);
  const routes = record(json?.value)?.routes;
  if (!json || !Array.isArray(routes)) return;
  const selected = routes.map((entry, index) => ({entry: record(entry), index})).filter(({entry}) => entry?.path === route);
  if (selected.length !== 1 || selected[0]!.entry?.file !== associated) return;
  const base = `routes/${selected[0]!.index}/`;
  const key = json.members.find(member => member.path.length === 3 && member.path.join('/') === base + 'path' && member.line === raw.line);
  const associatedKey = json.members.find(member => member.path.length === 3 && member.path.join('/') === base + 'file');
  const anchor = key && json.anchor(key);
  if (!anchor || !associatedKey) return;
  return {criterion: 'k6-route-p95-exceeded', anchor, facts: [route, associated, p95, limit, measured[1]!], rows: [row, summary],
    firstContextLine: Math.min(associatedKey.line, raw.line), lastContextLine: Math.max(associatedKey.line, raw.line)};
}

function undocumentedFunction(input: CaseInput): ExamCase | undefined {
  const {raw, source} = input;
  const prefix = `arquivo=${raw.file}; `;
  const row = scopedRow(input, 'typedoc:file', row => row.detail.startsWith(prefix));
  const found = functionAnchor(source, raw.line, true);
  if (!row || !found || source.slice(0, found.offset).trimEnd().endsWith('*/')) return;
  const details = /^simbolos=([1-9]\d*); documentados=(\d+); exports=([^;]+)$/.exec(row.detail.slice(prefix.length));
  if (!details || Number(details[2]) >= Number(details[1]) || details[3]!.split(',').filter(name => name === found.name).length !== 1
    || raw.message !== `Símbolo público exportado "${found.name}" em ${raw.file} não possui documentação JSDoc/TSDoc.`) return;
  return {criterion: 'typedoc-undocumented-export', anchor: found.anchor, facts: [found.name, 'sem JSDoc'], rows: [row],
    firstContextLine: Math.max(1, raw.line - 4)};
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function ortLicense(input: CaseInput): ExamCase | undefined {
  const {raw, source} = input;
  if (!/(^|\/)(?:package-lock|npm-shrinkwrap)\.json$/.test(raw.file)) return;
  const reported = /^ORT processou a declaração em packages como ((?:AGPL-3\.0|GPL-[123]\.0)-(?:only|or-later)|SSPL-1\.0)\.$/.exec(raw.evidence);
  const prefix = `${raw.file} | `;
  const row = scopedRow(input, 'ort:file', row => row.detail.startsWith(prefix));
  const counts = row && /^([1-9]\d*)\/([1-9]\d*) declarações SPDX processadas no ORT\.$/.exec(row.detail.slice(prefix.length));
  const json = jsonMembers(source);
  const packages = record(record(json?.value)?.packages);
  if (!reported || !row || !counts || counts[1] !== counts[2] || !packages || !json) return;
  const expression = reported[1]!;
  const candidates = json.members.filter(({path, line}) => path.length === 2 && path[0] === 'packages'
    && /^(?:node_modules\/(?:@[-\w.]+\/)?[-\w.]+\/)*node_modules\/(?:@[-\w.]+\/)?[-\w.]+$/u.test(path[1]!)
    && line === raw.line && record(packages[path[1]!])?.license === expression
    && record(packages[path[1]!])?.link !== true);
  if (candidates.length !== 1) return;
  const member = candidates[0]!;
  const anchor = json.anchor(member, true);
  const license = json.members.find(candidate => candidate.path.length === 3 && candidate.path[0] === 'packages'
    && candidate.path[1] === member.path[1] && candidate.path[2] === 'license');
  if (!anchor || !license || license.line > raw.line + 10 || !json.anchor(license)) return;
  return {criterion: 'ort-declared-strong-copyleft', anchor, facts: [member.path[1]!, expression], rows: [row],
    lastContextLine: license.line};
}

const rules: Record<VerificationModule, Record<string, CaseBuilder>> = {
  qa: {'stryker-mutator:QA-STRYKER-MUTANTE-SOBREVIVENTE': qaMutant, 'node-test-v8:QA-COBERTURA-FUNCAO-SEM-TESTE': qaFunction},
  arquitetura: {'knip:KNIP-UNUSED-FILE': knipFile, 'dependency-cruiser:DEPCRUISE-NO-CIRCULAR': importCycle},
  dependencias: {'ast-grep:ASTGREP-EXPRESS5-APP-DEL': expressDel},
  banco: {'squawk:SQUAWK-BAN-DROP-COLUMN': dropColumn, 'pg_restore:BANCO-INVARIANTE-HISTORICO': historicalInvariant,
    'pg_stat_statements:BANCO-CONSULTA-LENTA': sqlMean, 'dexter:BANCO-INDICE-CANDIDATO': hypotheticalIndex},
  prontidao: {
    'prontidao-audit:PRONTIDAO-TLS-VERIFICACAO-DESABILITADA': tlsOption,
    // Report sanitization can elide this rule ID. The builder still requires
    // its exact fixed evidence, tls-verify file coverage and literal property.
    'prontidao-audit:[removido: alta entropia]': tlsOption,
  },
  desempenho: {'node-cpu-prof:CPU-PROF-HOTSPOT': cpuProfile, 'k6:K6-THRESHOLD-LATENCY-P95': k6Latency},
  documentacao: {'typedoc:DOC-TYPEDOC-SIMBOLO-SEM-DOC': undocumentedFunction},
  conformidade: {'ort:ORT_STRONG_COPYLEFT_DECLARED': ortLicense},
};

/** Only compile-time, public tool/rule pairs may bypass entropy heuristics. */
export function isPublicModuleRule(module: VerificationModule | undefined, tool: unknown, rule: unknown): boolean {
  if (!module || typeof tool !== 'string' || typeof rule !== 'string' || tool.includes(':') || rule.includes(':')) return false;
  return Object.hasOwn(rules[module], tool + ':' + rule)
    || (module === 'qa' && tool === 'fast-check' && rule === 'QA-FASTCHECK-PROPRIEDADE-VIOLADA');
}


export function buildCollectorReviewCase(input: CaseInput & {
  module: VerificationModule; commit?: string; intentId: string; snapshot: string;
}) {
  const {raw, context, source} = input;
  const ruleKey = `${raw.tool}:${raw.rule}`;
  const rule = rules[input.module][ruleKey];
  if (!rule || context.module !== input.module || context.commit !== input.commit || !/^[0-9a-f]{40}$/.test(context.commit)
    || context.intentId !== input.intentId || !input.intentId || !input.snapshot || input.snapshot !== context.snapshot
    || context.exitCode !== 0 || !safeText(source) || !safeText(raw.evidence) || !safeText(raw.message)
    || context.coverage.some(row => row.tool === 'coletor' && row.status === 'failed')) return null;
  const originals = context.findings.filter(row => raw.file === row.file && raw.line === row.line && raw.rule === row.rule && raw.tool === row.tool);
  if (originals.length !== 1 || !sameFindingFields.every(key => originals[0]![key] === raw[key])) return null;
  const tools = context.coverage.filter(row => row.tool === raw.tool);
  if (!tools.some(row => row.status === 'ok') || tools.some(row => row.status === 'failed')) return null;
  if (['qa', 'arquitetura', 'dependencias', 'prontidao', 'documentacao'].includes(input.module)
    && !isModuleExamScript(raw.file)) return null;
  if (raw.file.length > 400 || !safeText(raw.file) || !sourceLine(source, raw.line) || !input.wasExamined(raw.file, source)) return null;
  const built = rule(input);
  if (!built || built.facts.some(fact => fact.length > 400 || !safeText(fact))
    || !built.rows.every(row => tools.some(tool => tool.status === 'ok' && tool.version === row.version)
      && [row.tool, row.version, row.detail, ...(row.files ?? [])].every(safeText))) return null;
  const {rows, firstContextLine, lastContextLine, related, ...validated} = built;
  const firstLine = firstContextLine ?? raw.line;
  const lastLine = lastContextLine ?? raw.line;
  const excerpt = source.split('\n').slice(firstLine - 1, lastLine).join('\n');
  if (excerpt.length > 4000) return null;
  const {criterion, anchor, facts} = validated;
  const reason = collectorReasonTemplates[criterion].replace(/\{(\d+|expressao|lista|arquivo)\}/gu, (_, field: string) => {
    if (field === 'expressao') return anchor.expression;
    if (field === 'lista') return facts.join(', ');
    if (field === 'arquivo') return raw.file;
    return facts[Number(field) - 1]!;
  });
  return {...validated, reason, material: {
    intentId: input.intentId, commit: context.commit, sourceDigest: digest(source), findingDigest: digest(raw),
    sourceContext: {firstLine, excerpt}, ...(related ? {relatedSources: related} : {}),
    records: rows.map(({tool, version, detail}) => ({tool, version, detail})),
  }};
}
export type CollectorReviewCase = NonNullable<ReturnType<typeof buildCollectorReviewCase>>;
