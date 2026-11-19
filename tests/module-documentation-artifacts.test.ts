import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assembleDocumentationArtifacts} from '../src/module-documentation-artifacts.ts';

type Row = Parameters<typeof assembleDocumentationArtifacts>[0][number];
type Artifact = 'api.json' | 'dependencias.mmd';

function detail(fields: object): string {
  return JSON.stringify(fields, null, 1).replaceAll('\n', '');
}

function encode(artifact: Artifact, input: string | Buffer): Row[] {
  const bytes = typeof input === 'string' ? Buffer.from(input) : input;
  const tool = artifact === 'api.json' ? 'typedoc:artefato' : 'dependency-cruiser:artefato';
  const parts = Math.ceil(bytes.length / 880);
  return Array.from({length: parts}, (_, index) => {
    const data = bytes.subarray(index * 880, (index + 1) * 880).toString('hex').match(/.{1,16}/g)!.join(' ');
    return {tool, version: '1', status: 'ok', detail: detail({artifact, encoding: 'hex-utf8-v1', part: index + 1, parts, data})};
  });
}

function changeDetail(row: Row, fields: object): Row {
  return {...row, detail: detail({...JSON.parse(row.detail), ...fields})};
}

test('distingue ausência, omissão explícita e catálogo vazio', () => {
  const omitted: Row = {
    tool: 'dependency-cruiser:artefato', version: '1', status: 'skipped',
    detail: detail({artifact: 'dependencias.mmd', encoding: 'hex-utf8-v1', reason: 'size-limit'}),
  };
  assert.deepEqual(assembleDocumentationArtifacts([]), {
    'api.json': {status: 'absent'},
    'dependencias.mmd': {status: 'absent'},
  });
  assert.deepEqual(assembleDocumentationArtifacts([...encode('api.json', '[]'), omitted]), {
    'api.json': {status: 'present', content: '[]'},
    'dependencias.mmd': {status: 'omitted', reason: 'size-limit'},
  });
  const diagram = encode('dependencias.mmd', 'flowchart LR\nA-->B\n');
  for (const rows of [[omitted, omitted], [omitted, ...diagram], [changeDetail(omitted, {reason: 'outro'})]]) {
    assert.throws(() => assembleDocumentationArtifacts(rows), {code: 'VERIFY_REPORT_INVALID'});
  }
});

test('recusa partes ausentes, duplicadas, versões divergentes e metadados inválidos', () => {
  const [first, second] = encode('dependencias.mmd', 'flowchart LR\n%% ' + 'a'.repeat(1000));
  const cases = [
    [first],
    [second],
    [first, first],
    [first, {...second, version: '2'}],
    [first, {...second, status: 'failed' as const}],
    [first, {...second, detail: '{'}],
    [first, changeDetail(second, {part: 0})],
    [first, changeDetail(second, {part: 2.5})],
    [first, changeDetail(second, {parts: 3})],
    [first, changeDetail(second, {encoding: 'outro'})],
    [first, changeDetail(second, {artifact: '../dependencias.mmd'})],
    [first, changeDetail(second, {artifact: 'api.json'})],
    [first, changeDetail(second, {extra: 'campo'})],
    [first, {...second, tool: 'outra:artefato'}],
    [first, {...second, detail: second.detail.replace('"part": 2,', '"part": 2, "part": 2,')}],
    [first, changeDetail(second, {data: 'abcd '})],
    [first, changeDetail(second, {data: 'abcd\n'})],
    [first, changeDetail(second, {data: 'abcd  1234'})],
    [first, changeDetail(second, {data: 'abC0'})],
    [first, changeDetail(second, {data: 'abc'})],
    [changeDetail(first, {data: 'abcd'}), second],
    [first, changeDetail(second, {data: 'ab'.repeat(1024)})],
  ];
  for (const [index, rows] of cases.entries()) {
    assert.throws(() => assembleDocumentationArtifacts(rows), {code: 'VERIFY_REPORT_INVALID'}, 'caso ' + index);
  }
});

test('recusa artefatos acima do limite, UTF-8 inválido, controles e catálogo de API inválido', () => {
  for (const rows of [
    encode('dependencias.mmd', 'a'.repeat(512 * 1024 + 1)),
    encode('dependencias.mmd', Buffer.from([0x66, 0xc3, 0x28])),
    encode('dependencias.mmd', 'flowchart LR\n\u0000'),
    encode('api.json', '['),
    encode('api.json', '{}'),
  ]) {
    assert.throws(() => assembleDocumentationArtifacts(rows), {code: 'VERIFY_REPORT_INVALID'});
  }
});

test('aplica a proteção de conteúdo após remontagem, inclusive em JSON com escapes', () => {
  const diagram = 'flowchart LR\n%% '.padEnd(876, ' ') + 'password = "valor-sintetico"';
  const escapedSummary = '[{"summaryText":"pass\\u0077ord = valor-sintetico"}]';
  const escapedKey = '[{"pass\\u0077ord = valor-sintetico":"exemplo"}]';
  for (const rows of [
    encode('dependencias.mmd', diagram),
    encode('api.json', escapedSummary),
    encode('api.json', escapedKey),
  ]) {
    assert.throws(() => assembleDocumentationArtifacts(rows), {code: 'VERIFY_SECRET_IN_REPORT'});
  }
});
