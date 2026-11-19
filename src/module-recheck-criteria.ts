import {canonical} from './contracts.ts';
import type {VerificationModule} from './ledger.ts';
import {functionAnchor, jsonMembers, singleScriptCallAnchor, sourceLine, sqlStatement} from './module-exam-proof-source.ts';
import {isModuleExamScript} from './module-exam-syntax.ts';
import type {ModuleRawFinding, ModuleToolCoverage} from './verification-modules.ts';

type Target = {line: number; code: string};
type Observation = {target: Target; value: string; record: ModuleToolCoverage};
type Comparison = {object: string; desired: string; before: Observation; after: Observation};
type CaseInput = {
  finding: ModuleRawFinding; before: string; after: string;
  original: ModuleToolCoverage[]; corrected: ModuleToolCoverage[];
  correctedFindings: readonly {tool: string | null}[];
};
type Criterion = {
  tool: string; rules: string[]; id: string;
  compare(input: CaseInput): Comparison | undefined;
};

function byPrefix(rows: ModuleToolCoverage[], tool: string, prefix: string) {
  const matches = rows.filter(row => row.tool === tool && row.detail.startsWith(prefix));
  return matches.length === 1 && matches[0]!.status === 'ok' ? matches[0] : undefined;
}

function measured(row: ModuleToolCoverage, target: Target, value: string): Observation {
  return {target, value, record: row};
}

function boundedInteger(text: string) {
  return /^(?:0|[1-9]\d*)$/.test(text) && Number.isSafeInteger(Number(text));
}

function knip({finding, before, after, original, corrected}: CaseInput) {
  const {file, line} = finding;
  const declaration = functionAnchor(before, line, true);
  if (line !== 1 || !declaration || before !== after || finding.evidence !== `knip files: ${file}`) return;
  const prefix = `arquivo=${file}; papel=`;
  const originalRow = byPrefix(original, 'knip:file', prefix);
  const correctedRow = byPrefix(corrected, 'knip:file', prefix);
  if (!originalRow || !correctedRow || !/^nao_alcancado; problemas=[1-9]\d*$/.test(originalRow.detail.slice(prefix.length))
    || !/^modulo; problemas=\d+$/.test(correctedRow.detail.slice(prefix.length))) return;
  const target = {line, code: sourceLine(before, line)};
  return {object: declaration.name, desired: 'modulo',
    before: measured(originalRow, target, 'nao_alcancado'), after: measured(correctedRow, target, 'modulo')};
}

// Require the old statement and its replacement at the same position and
// preserve all surrounding source. A different statement cannot be a fix.
function changedLine(before: string, after: string, line: number) {
  const lines = before.split('\n');
  const current = after.split('\n');
  if (lines.length !== current.length || lines.some((part, index) => index !== line - 1 && part !== current[index])) return;
  const original = lines[line - 1];
  const corrected = current[line - 1];
  if (original === undefined || corrected === undefined || /^\s*/.exec(original)![0] !== /^\s*/.exec(corrected)![0]) return;
  return {line, oldCode: original.trim(), newCode: corrected.trim()};
}

function express({finding, before, after, original, corrected}: CaseInput) {
  const change = changedLine(before, after, finding.line);
  const call = change && /^(app|router)\.del\((['"])(\/[\w/-]*)\2(?:, [A-Za-z_$][\w$]*)?\);?$/.exec(change.oldCode);
  if (!change || !call || change.newCode !== change.oldCode.replace('.del(', '.delete(')
    || finding.evidence !== `Revisão necessária: ${change.oldCode.replace(/;$/, '')}`) return;
  const hasCall = (code: string, method: string, expected: string) =>
    singleScriptCallAnchor(code, change.line, (tokens, start) =>
      tokens[start]!.text === call[1] && tokens[start + 1]?.text === '.' && tokens[start + 2]?.text === method
        ? start + 3 : null)?.expression === expected.replace(/;$/, '');
  if (!hasCall(before, 'del', change.oldCode) || !hasCall(after, 'delete', change.newCode)) return;
  const prefix = `arquivo=${finding.file}; achados=`;
  const originalRow = byPrefix(original, 'ast-grep', `arquivo=${finding.file}; `);
  const correctedRow = byPrefix(corrected, 'ast-grep', `arquivo=${finding.file}; `);
  if (!originalRow || !correctedRow || originalRow.detail !== prefix + '1' || correctedRow.detail !== prefix + '0') return;
  return {object: `${call[1]} ${call[3]}`, desired: 'delete',
    before: measured(originalRow, {line: change.line, code: change.oldCode}, 'del'),
    after: measured(correctedRow, {line: change.line, code: change.newCode}, 'delete')};
}

function squawk({finding, before, after, original, corrected, correctedFindings}: CaseInput) {
  if (!finding.file.endsWith('.sql')) return;
  const change = changedLine(before, after, finding.line);
  const drop = change && /^ALTER TABLE ([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?) DROP COLUMN ([A-Za-z_][\w]*);$/i.exec(change.oldCode);
  const rename = change && /^ALTER TABLE ([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?) RENAME COLUMN ([A-Za-z_][\w]*) TO ([A-Za-z_][\w]*);$/i.exec(change.newCode);
  const diagnostic = /^Regra ban-drop-column; coluna ([1-9]\d*); migração analisada em modo transacional\.$/.exec(finding.evidence);
  if (!change || !drop || !rename || !diagnostic || drop[1] !== rename[1] || drop[2] !== rename[2]
    || rename[2]!.toLowerCase() === rename[3]!.toLowerCase()) return;
  if (sqlStatement(before, change.line)?.anchor()?.expression !== change.oldCode
    || sqlStatement(after, change.line)?.anchor()?.expression !== change.newCode) return;
  const indentation = /^\s*/.exec(before.split('\n')[finding.line - 1]!)![0].length;
  const column = Number(diagnostic[1]);
  if (column !== indentation + 1 && column !== indentation + change.oldCode.search(/\bDROP\b/i) + 1) return;
  const prefix = `squawk:file:${finding.file}: `;
  const originalRow = byPrefix(original, 'squawk', prefix);
  const correctedRow = byPrefix(corrected, 'squawk', prefix);
  const correctedCount = correctedFindings.filter(row => row.tool === 'squawk').length;
  if (!originalRow || !correctedRow || !/^[1-9]\d* alertas$/.test(originalRow.detail.slice(prefix.length))
    || correctedRow.detail !== `${prefix}${correctedCount} alertas`) return;
  return {object: `${drop[1]}.${drop[2]}`, desired: 'rename',
    before: measured(originalRow, {line: change.line, code: change.oldCode}, 'drop'),
    after: measured(correctedRow, {line: change.line, code: change.newCode}, 'rename')};
}

function tlsOption({finding, before, after, original, corrected}: CaseInput) {
  const change = changedLine(before, after, finding.line);
  const binding = change && /^(?:export )?const ([A-Za-z_$][\w$]*) = \{ rejectUnauthorized: false \};?$/.exec(change.oldCode)?.[1];
  if (!change || !binding || before.trim() !== change.oldCode
    || change.newCode !== change.oldCode.replace(': false', ': true')
    || finding.evidence !== 'Diretiva de validação de certificado TLS desabilitada.') return;
  const prefix = `${finding.file}: `;
  const originalRow = byPrefix(original, 'prontidao:arquivo', prefix);
  const correctedRow = byPrefix(corrected, 'prontidao:arquivo', prefix);
  const details = (row: ModuleToolCoverage) =>
    /^verificações \[([\w, -]+)\], (\d+) achado\(s\)\.$/.exec(row.detail.slice(prefix.length));
  if (!originalRow || !correctedRow) return;
  const a = details(originalRow);
  const b = details(correctedRow);
  if (!a || !b || !a[1]!.split(', ').includes('tls-verify') || a[1] !== b[1]
    || ![a[2]!, b[2]!].every(boundedInteger) || Number(a[2]) !== Number(b[2]) + 1) return;
  return {object: `${binding}.rejectUnauthorized`, desired: 'true',
    before: measured(originalRow, {line: change.line, code: change.oldCode}, 'false'),
    after: measured(correctedRow, {line: change.line, code: change.newCode}, 'true')};
}

function cpu({finding, before, after, original, corrected}: CaseInput) {
  const declaration = /^\s*(?<signature>(?:export )?function (?<name>[A-Za-z_$][\w$]*)\(\)) \{/u;
  const oldLines = before.split('\n');
  const originalDeclaration = declaration.exec(oldLines[finding.line - 1] ?? '');
  if (!originalDeclaration) return;
  const {name, signature} = originalDeclaration.groups!;
  const target = (source: string) => {
    const lines = source.split('\n');
    const candidates = lines.flatMap((code, index) => {
      const match = declaration.exec(code);
      return match?.groups?.name === name ? [{line: index + 1, code: code.trim(), header: match[0]}] : [];
    });
    if (candidates.length !== 1) return;
    const selected = candidates[0]!;
    const prefix = [...lines.slice(0, selected.line - 1), selected.header].join('\n');
    if (functionAnchor(prefix, selected.line, false)?.anchor.expression === signature) return selected;
  };
  const previous = target(before);
  const current = target(after);
  if (!name || !signature || previous?.line !== finding.line || !current) return;
  const prefix = `arquivo=${finding.file}:`;
  const measure = (rows: ModuleToolCoverage[], line: number) => {
    const tool = 'node-cpu-prof:arquivo';
    const matching = rows.filter(row => row.tool === tool && (
      row.detail.startsWith(prefix) && row.detail.includes(`; função=${name}; `)
      || row.detail.startsWith(`${finding.file} (${name}):`)));
    const row = matching.length === 1 ? matching[0]! : undefined;
    const header = `${prefix}${line}; função=${name}; `;
    const detail = row?.status === 'ok' && row.detail.startsWith(header)
      && /^tempo próprio amostral=(\d+\.\d)ms; amostras próprias=(\d+)\/(\d+); limiar=(\d+(?:\.\d+)?)ms; recorte: uma chamada isolada sem argumentos$/
        .exec(row.detail.slice(header.length));
    if (!row || !detail || !detail.slice(2, 4).every(boundedInteger)) return;
    const [time, hits, samples, limit] = detail.slice(1).map(Number) as [number, number, number, number];
    if (!Number.isFinite(time) || hits < 1 || samples < hits || limit < 1 || limit > 500) return;
    return {row, time, limit};
  };
  const a = measure(original, finding.line);
  const b = measure(corrected, current.line);
  if (!a || !b || a.limit !== b.limit || a.time <= a.limit || b.time >= b.limit
    || a.row.detail !== finding.evidence + '; recorte: uma chamada isolada sem argumentos') return;
  return {object: name, desired: 'abaixo-do-limiar',
    before: measured(a.row, {line: previous.line, code: previous.code}, 'acima-do-limiar'),
    after: measured(b.row, {line: current.line, code: current.code}, 'abaixo-do-limiar')};
}

function typedoc({finding, before, after, original, corrected}: CaseInput) {
  const {file, line} = finding;
  const fn = functionAnchor(before, line, true);
  if (!fn || finding.message !== `Símbolo público exportado "${fn.name}" em ${file} não possui documentação JSDoc/TSDoc.`
    || before.slice(0, fn.offset).trimEnd().endsWith('*/')) return;
  const evidence = /^TypeDoc reflection kind=\d+ name=(.+)$/.exec(finding.evidence);
  if (evidence?.[1] !== `${fn.name} (${file}:${line}) sem summary/blockTags`) return;
  const start = before.lastIndexOf('\n', fn.offset - 1) + 1;
  const comment = /^\/\*\* (?<body>[^*/\r\n][^*\r\n]{0,499}) \*\/\r?\n/.exec(after.slice(start));
  if (!comment || !/[\p{L}\p{N}]/u.test(comment.groups!.body!) || after.slice(0, start) + after.slice(start + comment[0].length) !== before) return;
  const prefix = `arquivo=${file}; simbolos=1; documentados=`;
  const originalRow = byPrefix(original, 'typedoc:file', `arquivo=${file}; `);
  const correctedRow = byPrefix(corrected, 'typedoc:file', `arquivo=${file}; `);
  if (!originalRow || !correctedRow || originalRow.detail !== `${prefix}0; exports=${fn.name}`
    || correctedRow.detail !== `${prefix}1; exports=${fn.name}`) return;
  return {object: fn.name, desired: 'documentado',
    before: measured(originalRow, {line, code: sourceLine(before, line)}, 'sem-documentacao'),
    after: measured(correctedRow, {line, code: comment[0].trim()}, 'documentado')};
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function ort({finding, before, after, original, corrected}: CaseInput) {
  if (!/(^|\/)(?:package-lock|npm-shrinkwrap)\.json$/.test(finding.file)) return;
  const a = jsonMembers(before);
  const b = jsonMembers(after);
  const oldPackages = record(record(a?.value)?.packages);
  const newPackages = record(record(b?.value)?.packages);
  const entries = a?.members.filter(member => member.path.length === 2 && member.path[0] === 'packages'
    && member.line === finding.line && /^node_modules\/(?:@[\w.-]+\/)?[\w.-]+$/.test(member.path[1]!));
  if (!entries || entries.length !== 1 || !oldPackages || !newPackages) return;
  const name = entries[0]!.path[1]!;
  const previous = record(oldPackages[name]);
  const current = record(newPackages[name]);
  if (!previous || !current || typeof previous.version !== 'string' || previous.link === true || current.link === true) return;
  const {license: oldLicense, ...oldIdentity} = previous;
  const {license: newLicense, ...newIdentity} = current;
  if (typeof oldLicense !== 'string' || typeof newLicense !== 'string'
    || !/^(?:(?:AGPL-3\.0|GPL-[123]\.0)-(?:only|or-later)|SSPL-1\.0)$/.test(oldLicense)
    || !/^(?:MIT|ISC|Apache-2\.0|BSD-[23]-Clause)$/.test(newLicense) || canonical(oldIdentity) !== canonical(newIdentity)
    || finding.evidence !== `ORT processou a declaração em packages como ${oldLicense}.`) return;
  const prefix = `${finding.file} | `;
  const originalRow = byPrefix(original, 'ort:file', prefix);
  const correctedRow = byPrefix(corrected, 'ort:file', prefix);
  if (!originalRow || !correctedRow || originalRow.detail !== correctedRow.detail) return;
  const reported = /^([1-9]\d*)\/\1 declarações SPDX processadas no ORT\.$/.exec(originalRow.detail.slice(prefix.length));
  const count = Object.entries(oldPackages).filter(([name, pkg]) => name !== '' && typeof record(pkg)?.license === 'string').length;
  if (!reported || Number(reported[1]) !== count) return;
  const currentMember = b?.members.find(member => member.path.length === 3 && member.path.join('/') === `packages/${name}/license`);
  const currentAnchor = currentMember && b?.anchor(currentMember);
  if (!currentMember || !currentAnchor) return;
  return {object: name, desired: newLicense,
    before: measured(originalRow, {line: finding.line, code: `license ${oldLicense}`}, oldLicense),
    after: measured(correctedRow, {line: currentMember.line, code: currentAnchor.expression}, newLicense)};
}

const criteria: Partial<Record<VerificationModule, Criterion>> = {
  arquitetura: {tool: 'knip', rules: ['KNIP-UNUSED-FILE'], id: 'knip-reachable-module', compare: knip},
  dependencias: {tool: 'ast-grep', rules: ['ASTGREP-EXPRESS5-APP-DEL'], id: 'express-delete-same-route', compare: express},
  banco: {tool: 'squawk', rules: ['SQUAWK-BAN-DROP-COLUMN'], id: 'sql-rename-same-column', compare: squawk},
  prontidao: {tool: 'prontidao-audit', rules: ['PRONTIDAO-TLS-VERIFICACAO-DESABILITADA', '[removido: alta entropia]'],
    id: 'tls-certificate-check-enabled', compare: tlsOption},
  desempenho: {tool: 'node-cpu-prof', rules: ['CPU-PROF-HOTSPOT'], id: 'cpu-same-function-below-limit', compare: cpu},
  documentacao: {tool: 'typedoc', rules: ['DOC-TYPEDOC-SIMBOLO-SEM-DOC'], id: 'typedoc-same-export-documented', compare: typedoc},
  conformidade: {tool: 'ort', rules: ['ORT_STRONG_COPYLEFT_DECLARED'], id: 'ort-same-package-permissive-declaration', compare: ort},
};

export function moduleMeasurementCriterion(module: VerificationModule, {tool, rule, file}: {tool: string; rule: string; file: string}) {
  const criterion = criteria[module];
  if (['arquitetura', 'dependencias', 'prontidao', 'desempenho', 'documentacao'].includes(module) && !isModuleExamScript(file)) return;
  return criterion?.tool === tool && criterion.rules.includes(rule) ? criterion : undefined;
}
