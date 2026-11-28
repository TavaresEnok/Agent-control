import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

// AGENTS.md é a regra viva do repositório: uma seção por assunto, sem equipes empilhadas,
// e tudo o que ela cita precisa existir (comando, arquivo, pasta).
const root = join(import.meta.dirname, '..');
const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
const scripts = Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts as Record<string, string>);

test('AGENTS.md tem uma seção por assunto, sem equipes nem regras de rodada empilhadas', () => {
  const headings = text.split('\n').filter(line => line.startsWith('## ')).map(line => line.slice(3).trim());
  assert.equal(new Set(headings).size, headings.length, `seção repetida: ${headings.join(' | ')}`);
  assert.equal(headings.filter(heading => /papéis/i.test(heading)).length, 1);
  for (const heading of headings) assert.doesNotMatch(heading, /equipe|urgente|\d{1,2}\/\d{1,2}\/\d{4}/i, `seção de rodada: ${heading}`);
  assert.ok(text.split('\n').length <= 120, 'AGENTS.md cresceu demais: consolide em vez de empilhar');
});

test('AGENTS.md não manda esperar com pgrep nem cita projeto encerrado ou e-mail pessoal', () => {
  assert.doesNotMatch(text, /while\s+pgrep/);
  assert.doesNotMatch(text, /chatisp/i);
  const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  for (const email of emails) assert.match(email, /^noreply@/, `e-mail pessoal: ${email}`);
});

test('todo comando npm e todo caminho do repositório citados em AGENTS.md existem', () => {
  for (const [, name] of text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) assert.ok(scripts.includes(name), `script inexistente: ${name}`);
  for (const [, name] of text.matchAll(/`(personal:[a-z-]+)/g)) assert.ok(scripts.includes(name), `script inexistente: ${name}`);
  for (const [, path] of text.matchAll(/`((?:docs|src|scripts|tests|deploy)\/[^`\s*<]+)`/g)) {
    assert.ok(existsSync(join(root, path.replace(/\/$/, ''))), `caminho inexistente: ${path}`);
  }
  const docsLine = text.split('\n').find(line => line.includes('Subpastas de `docs/`')) ?? '';
  for (const [, name] of docsLine.matchAll(/`([a-z]+\/)`/g)) {
    if (name !== 'docs/') assert.ok(existsSync(join(root, 'docs', name!)), `pasta de docs inexistente: ${name}`);
  }
});

test('a documentação viva não aponta para arquivo que saiu do repositório', () => {
  const files = ['README.md', 'AGENTS.md', ...readdirSync(join(root, 'docs'), {recursive: true}).map(String).filter(name => name.endsWith('.md')).map(name => join('docs', name))];
  const dead: string[] = [];
  for (const file of files) {
    for (const [, target] of readFileSync(join(root, file), 'utf8').matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^(https?:|mailto:)/.test(target!)) continue;
      if (!existsSync(join(root, dirname(file), target!))) dead.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(dead, []);
});
