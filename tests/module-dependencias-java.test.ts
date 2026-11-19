import assert from 'node:assert/strict';
import {execFile as execFileCb} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {runCollection, type ModuleCollectorOutput} from '../deploy/modules/dependencias/collect.mjs';

const execFile = promisify(execFileCb);
const runtime = process.env.AC_TEST_OPENREWRITE_HOME ?? fileURLToPath(new URL(
  '../deploy/modules/dependencias/openrewrite/runtime/', import.meta.url));
const realOpenRewrite = process.env.AC_TEST_OPENREWRITE_HOME || existsSync(join(runtime, 'jdk/bin/java'))
  ? {} : {skip: 'Instale o runtime Java com openrewrite/install.mjs e indique AC_TEST_OPENREWRITE_HOME.'};
const versions = {ncuVersion: 'fixture', astGrepVersion: 'fixture', jscodeshiftVersion: 'fixture'};
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const javaCoverage = (output: ModuleCollectorOutput) => output.coverage.filter(row => row.tool === 'openrewrite');
const javaFindings = (output: ModuleCollectorOutput) => output.findings.filter(row => row.tool === 'openrewrite');

async function fixture(t: {after(fn: () => Promise<void>): void}, files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'ac-dep-java-test-'));
  t.after(() => rm(root, {force: true, recursive: true}));
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, content);
  }
  return root;
}

test('OpenRewrite real localiza alterações determinísticas, reaplicáveis e compiláveis na fixture', realOpenRewrite, async t => {
  const file = 'app/src/main/java/exemplo/TextEncoding.java';
  const source = [
    'package exemplo;',
    'import java.nio.charset.Charset;',
    'import static java.nio.charset.Charset.forName;',
    'public class TextEncoding {',
    '    // Codificação da mensagem 😀',
    '    Charset encoding() { return Charset.forName("UTF-8"); }',
    '    Charset other() { return forName("UTF-8"); }',
    '    Charset qualified() { return java.nio.charset.Charset.forName(',
    '        "UTF-8"); }',
    '}',
    '',
  ].join('\r\n');
  const gradle = 'new File("build-was-run").text = "fixture"\n';
  const root = await fixture(t, {[file]: source, 'build.gradle': gradle, 'rewrite.yml': 'fixture: do not load\n'});
  const options = {...versions, repoRoot: root, openRewriteHome: runtime};
  const result = await runCollection(options);
  assert.deepEqual(javaCoverage(result).map(row => [row.version, row.status]), [['8.85.0', 'ok']]);
  const [finding] = javaFindings(result);
  assert.equal(javaFindings(result).length, 1);
  assert.equal(finding.rule, 'charset-standard-utf8');
  assert.equal(finding.file, file);
  assert.equal(finding.line, 6);

  const proof: {offsets: string; beforeSha256: string; afterSha256: string;
    edits: {start: number; before: string; after: string}[]} = JSON.parse(finding.evidence);
  assert.equal(proof.offsets, 'utf16');
  assert.equal(proof.beforeSha256, sha256(source));
  assert.deepEqual(proof.edits.map(edit => edit.before), [
    'Charset.forName("UTF-8")', 'forName("UTF-8")', 'java.nio.charset.Charset.forName(\r\n        "UTF-8")',
  ]);
  let changed = source;
  for (const edit of [...proof.edits].reverse()) {
    assert.equal(edit.after, 'java.nio.charset.StandardCharsets.UTF_8');
    assert.equal(changed.slice(edit.start, edit.start + edit.before.length), edit.before);
    changed = changed.slice(0, edit.start) + edit.after + changed.slice(edit.start + edit.before.length);
  }
  assert.equal(proof.afterSha256, sha256(changed));
  assert.deepEqual(javaFindings(await runCollection(options)), [finding]);
  assert.equal(await readFile(join(root, file), 'utf8'), source);
  assert.equal(await readFile(join(root, 'build.gradle'), 'utf8'), gradle);
  assert.deepEqual((await readdir(root)).sort(), ['app', 'build.gradle', 'rewrite.yml']);

  const patched = await fixture(t, {[file]: changed});
  await execFile(join(runtime, 'jdk/bin/javac'), ['-proc:none', '-d', patched, join(patched, file)]);
  const clean = await runCollection({...options, repoRoot: patched});
  assert.equal(javaCoverage(clean)[0].status, 'ok');
  assert.deepEqual(javaFindings(clean), []);
});

test('OpenRewrite usa atribuição do JDK e preserva chamadas homônimas no controle limpo', realOpenRewrite, async t => {
  const root = await fixture(t, {'Control.java': `
import java.nio.charset.StandardCharsets;
class Control {
    static String forName(String value) { return value; }
    String local() { return forName("UTF-8"); }
    String modern() { return StandardCharsets.UTF_8.name(); }
    String other() { return java.nio.charset.Charset.forName("UTF-16").name(); }
}
`});
  const output = await runCollection({...versions, repoRoot: root, openRewriteHome: runtime});
  assert.deepEqual(javaCoverage(output).map(row => [row.version, row.status]), [['8.85.0', 'ok']]);
  assert.deepEqual(javaFindings(output), []);
});

test('OpenRewrite distingue candidato sem atribuição, posição de instrução e erro de parser', realOpenRewrite, async t => {
  const root = await fixture(t, {
    'External.java': 'class External { Object encoding() { return ProjectCharsets.forName("UTF-8"); } }\n',
    'Statement.java': 'class Statement { void encoding() { java.nio.charset.Charset.forName("UTF-8"); } }\n',
    'Wildcard.java': `import java.nio.charset.*;
class Wildcard { Object encoding() { return Charset.forName("UTF-8"); } }
`,
    'Inherited.java': `import static java.nio.charset.Charset.forName;
class Inherited extends Base { Object encoding() { return forName("UTF-8"); } }
`,
    'Base.java': 'class Base { static Object forName(String value) { return value; } }\n',
    'Charset.java': 'class Charset { static Object forName(String value) { return value; } }\n',
    'Malformed.java': 'class Malformed { void sample( {\n',
    'Valid.java': 'class Valid { Object encoding() { return java.nio.charset.Charset.forName("UTF-8"); } }\n',
  });
  const result = await runCollection({...versions, repoRoot: root, openRewriteHome: runtime});
  const coverage = javaCoverage(result);
  assert.equal(coverage[0].version, '8.85.0');
  assert.equal(coverage[0].status, 'failed');
  for (const file of ['External.java', 'Statement.java', 'Wildcard.java', 'Inherited.java']) {
    assert.ok(coverage.some(row => row.status === 'skipped' && row.detail.includes(`arquivo=${file}; candidatos_sem_prova=1`)));
  }
  assert.ok(coverage.some(row => row.status === 'failed' && row.detail.includes('arquivo=Malformed.java; erro=parse_java')));
  assert.deepEqual(javaFindings(result).map(finding => [finding.file, finding.line]), [['Valid.java', 1]]);
});

test('OpenRewrite registra falta de prova com manifesto e somente fontes inelegíveis', async t => {
  const root = await fixture(t, {'pom.xml': '<project/>\n', 'Large.java': ''});
  await truncate(join(root, 'Large.java'), 512 * 1024 + 1);
  await symlink('Large.java', join(root, 'Linked.java'));
  const result = await runCollection({...versions, repoRoot: root, openRewriteHome: join(root, 'ausente')});
  const [coverage] = javaCoverage(result);
  assert.equal(coverage.status, 'skipped');
  assert.match(coverage.detail, /sem fontes elegíveis.*fontes_ignoradas=2.*prova_parcial=true/);
  assert.deepEqual(javaFindings(result), []);
});

test('OpenRewrite registra falha de inicialização da ferramenta em fonte elegível', async t => {
  const root = await fixture(t, {'Smoke.java': 'class Smoke {}\n'});
  const result = await runCollection({...versions, repoRoot: root, openRewriteHome: join(root, 'ausente')});
  const [coverage] = javaCoverage(result);
  assert.equal(coverage.status, 'failed');
  assert.match(coverage.detail, /OpenRewrite.*ENOENT.*prova_parcial=true/);
  assert.deepEqual(javaFindings(result), []);
});
