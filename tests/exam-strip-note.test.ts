// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {runDesignModule} from '../src/design-module.ts';
import {rememberExamStripNote, takeExamStripNote} from '../src/exam-strip-note.ts';
import {formatExamStripNote, stripExamHostileConfig} from '../src/verify-exam-isolation.ts';

test('o strip conta os symlinks removidos sem seguir o alvo', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ac-exam-strip-note-'));
  const repo = join(parent, 'repo');
  const outside = join(parent, 'outside.txt');
  try {
    await mkdir(join(repo, 'src'), {recursive: true});
    await mkdir(join(repo, 'docs'), {recursive: true});
    await writeFile(outside, 'bytes-outside\n');
    await writeFile(join(repo, 'GROK.md'), 'hostile\n');
    await writeFile(join(repo, 'README.md'), 'keep\n');
    await symlink(outside, join(repo, 'src', 'link.ts'));
    await symlink(outside, join(repo, 'docs', 'CLAUDE.md'));

    const result = await stripExamHostileConfig(repo);

    await assert.rejects(lstat(join(repo, 'src', 'link.ts')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    await assert.rejects(lstat(join(repo, 'docs', 'CLAUDE.md')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    await assert.rejects(lstat(join(repo, 'GROK.md')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    assert.equal(await readFile(outside, 'utf8'), 'bytes-outside\n');
    assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'keep\n');
    assert.equal(result.count, 2);
    assert.ok(result.paths.includes('src/link.ts'));
    assert.ok(result.paths.includes('docs/CLAUDE.md'));
    assert.equal(result.paths.some(path => path.startsWith('/') || path.includes('\\') || path.includes(parent)), false);
    const note = formatExamStripNote(result);
    assert.equal(typeof note, 'string');
    assert.match(note ?? '', /2/);
    assert.match(note ?? '', /src\/link\.ts/);

    const empty = await stripExamHostileConfig(repo);
    assert.equal(empty.count, 0);
    assert.equal(formatExamStripNote(empty), undefined);
    assert.equal(formatExamStripNote({count: 0, paths: []}), undefined);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('o worker lembra a nota e o relatório de design a guarda', async () => {
  const data = await mkdtemp(join(tmpdir(), 'ac-strip-note-design-'));
  const repo = await mkdtemp(join(tmpdir(), 'ac-strip-note-repo-'));
  const intentId = randomUUID();
  const sentence = 'Symlinks removidos da cópia do exame: 2. Onde: src/link.ts, docs/outro.';
  try {
    rememberExamStripNote('', sentence);
    assert.equal(takeExamStripNote(''), undefined);
    const result = await runDesignModule({
      activation: 'personal',
      projectId: randomUUID(),
      repo,
      targetUrl: 'http://127.0.0.1:4173',
      dataDirectory: data,
      intentId,
      runId: randomUUID(),
      createdAt: new Date('2026-11-18T12:00:00.000Z'),
      commit: 'abc123',
      files: [{path: 'index.html', text: '<!DOCTYPE html><html lang="pt"><body><p>Texto simples.</p></body></html>\n'}],
      worker: {
        async run(call) {
          assert.equal(call.intentId, intentId);
          rememberExamStripNote(call.intentId, sentence);
          return JSON.stringify({
            kind: 'exame',
            filesRead: ['index.html'],
            checklist: ['DESIGN-NIELSEN-H1-ESTADO'],
            findings: [],
          });
        },
      },
      reserve: async role => ({
        provider: role === 'reviewer' ? 'grok' : 'claude',
        model: 'modelo',
        accountId: randomUUID(),
        profileId: randomUUID(),
        grantId: randomUUID(),
      }),
      release: async () => {},
    });
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.match(readme, /Symlinks removidos da cópia do exame: 2/);
    assert.match(readme, /src\/link\.ts/);
    assert.equal(takeExamStripNote(intentId), undefined);
  } finally {
    await rm(data, {recursive: true, force: true});
    await rm(repo, {recursive: true, force: true});
  }
});
