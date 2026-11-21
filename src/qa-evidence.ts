/**
 * A QA container that exits 0 has not necessarily tested anything. This only downgrades a "passed":
 * it never turns a failure into a pass. Every rule reads text the controller already holds (the logs)
 * or Git facts about the artifact (deleted test files, focus markers), never output the agent chose to print as a verdict.
 */
export type QaEvidenceIssue = {code: 'QA_ZERO_TESTS' | 'QA_ALL_SKIPPED' | 'QA_FAILURE_TEXT' | 'QA_FOCUSED_TESTS' | 'QA_TEST_FILES_DELETED'; detail: string};

/** Docker non-TTY logs: 8-byte headers, stdout and stderr frames. Invalid framing yields the raw text. */
export function demuxDockerLogs(logs: Buffer): string {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= logs.length) {
    if (![1, 2].includes(logs[offset]!)) return logs.toString('utf8');
    const length = logs.readUInt32BE(offset + 4);
    if (offset + 8 + length > logs.length) return logs.toString('utf8');
    parts.push(logs.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return Buffer.concat(parts).toString('utf8');
}

const last = (text: string, pattern: RegExp): number | null => {
  const found = [...text.matchAll(pattern)].at(-1);
  return found ? Number(found[1]) : null;
};

/** Summaries of node:test (TAP and spec), Jest/Vitest, Mocha, pytest and Go. Unknown runners say nothing. */
export function qaLogIssues(text: string): QaEvidenceIssue[] {
  const issues: QaEvidenceIssue[] = [];
  // node:test, TAP (`# pass 3`) or spec (`ℹ pass 3`).
  const nodePass = last(text, /^(?:#|ℹ) pass (\d+)\s*$/gm), nodeTests = last(text, /^(?:#|ℹ) tests (\d+)\s*$/gm);
  const nodeFail = last(text, /^(?:#|ℹ) fail (\d+)\s*$/gm), nodeSkipped = (last(text, /^(?:#|ℹ) skipped (\d+)\s*$/gm) ?? 0) + (last(text, /^(?:#|ℹ) todo (\d+)\s*$/gm) ?? 0);
  if (nodeTests !== null && nodePass !== null) {
    if (nodeFail) issues.push({code: 'QA_FAILURE_TEXT', detail: `node:test relata ${nodeFail} falha(s)`});
    else if (nodeTests === 0) issues.push({code: 'QA_ZERO_TESTS', detail: 'node:test não rodou nenhum teste'});
    else if (nodePass === 0 && nodeSkipped > 0) issues.push({code: 'QA_ALL_SKIPPED', detail: `node:test pulou todos os ${nodeSkipped} testes`});
  }
  // Jest and Vitest.
  if (/^\s*Tests?:\s+(?:.*\b)?(\d+) failed\b/m.test(text) || /^\s*Tests?\s+\d+ failed\b/m.test(text)) issues.push({code: 'QA_FAILURE_TEXT', detail: 'Jest/Vitest relata testes falhos'});
  if (/\bNo tests found\b|\bNo test files found\b|\bNo test suite found\b/.test(text)) issues.push({code: 'QA_ZERO_TESTS', detail: 'Jest/Vitest não achou testes'});
  // Mocha.
  const mochaFailing = last(text, /^\s*(\d+) failing\b/gm), mochaPassing = last(text, /^\s*(\d+) passing\b/gm);
  if (mochaFailing) issues.push({code: 'QA_FAILURE_TEXT', detail: `Mocha relata ${mochaFailing} falha(s)`});
  else if (mochaPassing === 0 && mochaFailing === null && /^\s*0 passing\b/m.test(text)) issues.push({code: 'QA_ZERO_TESTS', detail: 'Mocha não rodou nenhum teste'});
  // pytest.
  const pytestLine = [...text.matchAll(/^=+ (.*\bin [\d.]+s.*) =+\s*$/gm)].at(-1)?.[1];
  if (pytestLine) {
    const count = (word: string) => Number(new RegExp(`(\\d+) ${word}\\b`).exec(pytestLine)?.[1] ?? 0);
    if (count('failed') || count('errors?') || count('error')) issues.push({code: 'QA_FAILURE_TEXT', detail: 'pytest relata falhas ou erros'});
    else if (count('passed') === 0 && count('skipped') > 0) issues.push({code: 'QA_ALL_SKIPPED', detail: 'pytest pulou todos os testes'});
    else if (/\bno tests ran\b/.test(pytestLine)) issues.push({code: 'QA_ZERO_TESTS', detail: 'pytest não rodou nenhum teste'});
  } else if (/^collected 0 items\b/m.test(text)) issues.push({code: 'QA_ZERO_TESTS', detail: 'pytest não coletou nenhum teste'});
  // Go: a failing package prints FAIL at column 0.
  if (/^(?:--- FAIL:|FAIL\s+\S+\s+[\d.]+s)/m.test(text)) issues.push({code: 'QA_FAILURE_TEXT', detail: 'go test relata falhas'});
  const seen = new Set<string>();
  return issues.filter(issue => !seen.has(issue.code) && Boolean(seen.add(issue.code)));
}

/** Facts from the Git helper about the artifact against its base. */
export type QaGitFacts = {deletedTests: readonly string[]; focused: readonly {path: string; line: number}[]};

export function qaGitIssues(facts: QaGitFacts): QaEvidenceIssue[] {
  const issues: QaEvidenceIssue[] = [];
  if (facts.focused.length) issues.push({code: 'QA_FOCUSED_TESTS', detail: `testes focados (.only, fit, fdescribe) fazem o executor ignorar os outros: ${facts.focused.slice(0, 5).map(item => `${item.path}:${item.line}`).join(', ')}`});
  if (facts.deletedTests.length) issues.push({code: 'QA_TEST_FILES_DELETED', detail: `arquivos de teste apagados nesta mudança: ${facts.deletedTests.slice(0, 5).join(', ')}${facts.deletedTests.length > 5 ? ` e mais ${facts.deletedTests.length - 5}` : ''}`});
  return issues;
}

/** The line appended to the QA log when a pass is downgraded, so the correction sees why. */
export function qaEvidenceLogLine(issues: readonly QaEvidenceIssue[]): string {
  return 'AGENT_CONTROL_QA_EVIDENCE: o QA saiu com código 0, mas não serve de prova: ' + issues.map(issue => `${issue.code} (${issue.detail})`).join('; ') + '.';
}
