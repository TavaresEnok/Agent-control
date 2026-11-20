import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  backoffMs, compactConversation, historyBeforeCurrent, managerEconomyOf, managerRepositoryContext, managerUsage,
  parseReportedTokens, pollSchedule, tailForModel,
} from '../src/manager-discipline.ts';
import {PersonalManagerChat} from '../src/personal-manager-chat.ts';
import {personalRepositoryContext} from '../src/personal-runtime.ts';
import {estimateTokens} from '../src/repo-map.ts';
import {Ledger} from '../src/ledger.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

async function fixtureRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'ac-t6-repo-'));
  execFileSync('git', ['init', '-q', repo]);
  await writeFile(join(repo, 'README.md'), '# Projeto de teste\n' + 'Descrição longa do projeto. '.repeat(400));
  for (let dir = 0; dir < 12; dir += 1) {
    await mkdir(join(repo, 'src', `modulo${dir}`), {recursive: true});
    for (let file = 0; file < 12; file += 1) {
      const body = Array.from({length: 40}, (_, line) => `// linha ${line} do arquivo ${dir}-${file} com código de implementação detalhado`).join('\n');
      await writeFile(join(repo, 'src', `modulo${dir}`, `arquivo${file}.ts`),
        `import {util} from '../util.ts';\nexport function operacao${dir}_${file}(valor: number): number { return util(valor); }\nexport const CONSTANTE_${dir}_${file} = ${file};\n${body}\n`);
    }
  }
  await writeFile(join(repo, 'src', 'util.ts'), 'export function util(valor: number): number { return valor + 1; }\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixture']);
  return repo;
}

test('histórico: recentes inteiras, antigas encurtadas, decisão pendente mais longa, mensagem atual fora do bloco', () => {
  const long = 'detalhe '.repeat(200);
  const messages = Array.from({length: 14}, (_, index) => ({role: index % 2 ? 'manager' as const : 'owner' as const, text: `mensagem ${index} ${long}`}));
  messages[2] = {role: 'manager', text: 'Proposta pendente: aprovar a mudança no módulo de faturas? ' + long};
  const block = compactConversation(messages, {budgetChars: 20_000});
  const lines = block.split('\n');
  assert.equal(lines.length, 14);
  assert.ok(lines.at(-1)!.length > 1000, 'a última mensagem fica inteira');
  assert.ok(lines[0]!.length <= 'Titular: '.length + 160);
  assert.ok(lines[2]!.length > 300 && lines[2]!.includes('Proposta pendente'), 'decisão pendente preservada');
  const raw = messages.reduce((sum, message) => sum + message.text.length, 0);
  assert.ok(block.length < raw / 2, `${block.length} < ${raw}/2`);
  assert.equal(compactConversation(messages, {budgetChars: 20_000}), block, 'determinístico');
});

test('histórico: respeita o teto e descarta primeiro as mais antigas, nunca a mais recente', () => {
  const messages = Array.from({length: 30}, (_, index) => ({role: 'owner' as const, text: `m${index} ` + 'x'.repeat(500)}));
  const block = compactConversation(messages, {budgetChars: 3000});
  assert.ok(block.length <= 3100);
  assert.match(block, /mensagens mais antigas omitidas/);
  assert.ok(block.includes('m29 '));
  assert.ok(!block.includes('m0 '));
  assert.equal(compactConversation([]), '');
});

test('historyBeforeCurrent tira a própria mensagem por id e por texto', () => {
  const page = [
    {id: 'c|a', role: 'owner' as const, text: 'antes'},
    {id: 'c|b', role: 'manager' as const, text: 'resposta'},
    {id: 'c|panel-1', role: 'owner' as const, text: 'agora'},
  ];
  assert.deepEqual(historyBeforeCurrent(page, {localId: 'panel-1', text: 'agora'}).map(row => row.text), ['antes', 'resposta']);
  assert.deepEqual(historyBeforeCurrent([...page.slice(0, 2), {id: 'x', role: 'owner', text: 'agora'}], {localId: 'zzz', text: 'agora'}).map(row => row.text), ['antes', 'resposta']);
});

test('contexto do gerente: mapa compacto cabe no orçamento e é bem menor que o texto bruto', async () => {
  const repo = await fixtureRepo();
  const data = await mkdtemp(join(tmpdir(), 'ac-t6-data-'));
  try {
    const legacy = await personalRepositoryContext(repo);
    const compact = await managerRepositoryContext(repo, {enabled: true, contextTokens: 1200, measure: true, projectId: 'p1', dataDirectory: data}, async () => legacy);
    const again = await managerRepositoryContext(repo, {enabled: true, contextTokens: 1200, measure: true, projectId: 'p1', dataDirectory: data}, async () => legacy);
    assert.equal(again, compact, 'mapa em cache por commit dá o mesmo texto');
    assert.match(compact, /Mapa compacto do repositório/);
    assert.match(compact, /README \(início\)/);
    assert.ok(estimateTokens(compact) <= 1250, 'cabe no orçamento: ' + estimateTokens(compact));
    assert.ok(estimateTokens(compact) < estimateTokens(legacy), `${estimateTokens(compact)} < ${estimateTokens(legacy)}`);
    console.log(`T6 medido: contexto bruto ${legacy.length} caracteres (~${estimateTokens(legacy)} tokens); mapa compacto ${compact.length} caracteres (~${estimateTokens(compact)} tokens)`);
    const off = await managerRepositoryContext(repo, {enabled: false, contextTokens: 1200, measure: true}, async () => legacy);
    assert.equal(off, legacy, 'desligado mantém o texto bruto');
    const broken = await managerRepositoryContext('/caminho/que/nao/existe', {enabled: true, contextTokens: 1200, measure: true}, async () => 'bruto');
    assert.equal(broken, 'bruto', 'sem mapa volta ao texto bruto');
  } finally {
    await rm(repo, {recursive: true, force: true});
    await rm(data, {recursive: true, force: true});
  }
});

test('prompt: a mensagem atual vai inteira e por último; sem disciplina o prompt é o antigo', () => {
  const chat = new PersonalManagerChat({} as Ledger, {imageId: 'img', accountRoot: '/x'});
  const current = 'Corrija o relatório de faturas. ' + 'detalhe '.repeat(100);
  const history = Array.from({length: 20}, (_, index) => ({role: 'owner' as const, text: `antiga ${index} ` + 'y'.repeat(900)}));
  const withDiscipline = chat.buildPrompt(current, 'CTX', {compact: true, history});
  assert.ok(withDiscipline.endsWith('Mensagem:\n' + current));
  assert.match(withDiscipline, /Conversa recente/);
  const legacy = chat.buildPrompt(current, 'CTX', {history});
  assert.doesNotMatch(legacy, /Conversa recente/);
  assert.equal(legacy, chat.buildPrompt(current, 'CTX'));
  assert.ok(withDiscipline.length - legacy.length < 7000, 'histórico limitado');
});

test('uso: total informado pelo Codex, estimativa marcada nos outros', () => {
  assert.equal(parseReportedTokens('codex', '', 'tokens used\n12,345\n'), 12345);
  assert.equal(parseReportedTokens('claude', 'tokens used 9', ''), null);
  assert.deepEqual(managerUsage('codex', 'p', 'resposta', 'tokens used: 900'), {input: null, output: null, total: 900, estimated: false});
  assert.deepEqual(managerUsage('claude', 'a'.repeat(400), 'b'.repeat(40), ''), {input: 100, output: 10, total: null, estimated: true});
});

test('decide registra o uso do gerente (estimado) e respeita a opção de medição', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ac-t6-docker-'));
  const docker = join(dir, 'docker');
  await writeFile(docker, '#!/bin/sh\necho \'{"kind":"answer","answer":"ok"}\'\n');
  await chmod(docker, 0o755);
  const inserts: unknown[][] = [];
  const ledger = {pool: {async query(sql: string, params: unknown[]) {
    if (sql.includes('FROM ac_profiles')) return {rows: [{account_id: 'acc', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium'}]};
    if (sql.includes('INSERT INTO ac_manager_chat_usage')) { inserts.push(params); return {rows: []}; }
    throw new Error('SQL inesperado: ' + sql);
  }}} as unknown as Ledger;
  try {
    const chat = new PersonalManagerChat(ledger, {imageId: 'img', accountRoot: '/x', docker});
    const decision = await chat.decide('olá', 'CTX', {measure: true, projectId: '11111111-1111-4111-8111-111111111111'});
    assert.deepEqual(decision, {kind: 'answer', answer: 'ok'});
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0]![8], true, 'estimado');
    assert.equal(inserts[0]![5], estimateTokens(chat.buildPrompt('olá', 'CTX')));
    await chat.decide('olá', 'CTX', {measure: false});
    assert.equal(inserts.length, 1, 'medição desligada não grava');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('recuo e prazo: mesmo prazo total, bem menos consultas', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(attempt => backoffMs(attempt, 2000, 10_000)), [2000, 3000, 4500, 6750, 10_000, 10_000, 10_000]);
  const fixed = pollSchedule({backoff: false, baseMs: 2000, maxMs: 10_000, deadlineMs: 958_000});
  const grown = pollSchedule({backoff: true, baseMs: 2000, maxMs: 10_000, deadlineMs: 958_000});
  const total = (poll: typeof fixed) => Array.from({length: poll.attempts - 1}, (_, index) => poll.waitMs(index)).reduce((sum, ms) => sum + ms, 0);
  assert.equal(fixed.attempts, 480);
  assert.equal(total(fixed), 958_000);
  assert.ok(total(grown) >= 958_000);
  assert.ok(total(grown) - 958_000 < 10_000);
  assert.ok(grown.attempts < 120, 'consultas com recuo: ' + grown.attempts);
  console.log(`T6 medido: consultas de exame em 958 s: ${fixed.attempts} (fixo) contra ${grown.attempts} (recuo)`);
});

test('log para o modelo: só o fim, com indicação do arquivo completo', () => {
  const log = Array.from({length: 500}, (_, index) => `linha ${index}`).join('\n');
  const tail = tailForModel(log, 'qa-logs.bin');
  assert.match(tail, /^\(últimas 40 linhas; saída completa em qa-logs\.bin\)/);
  assert.ok(tail.includes('linha 499') && !tail.includes('linha 459\n') && tail.includes('linha 460'));
  assert.equal(tailForModel('curto\n', 'x'), 'curto');
  const wide = tailForModel('a'.repeat(20_000), 'x', 40, 1000);
  assert.ok(wide.length < 1100 && wide.startsWith('('));
});

test('opções por projeto: padrão ligado e cada uma desliga a sua parte', () => {
  assert.deepEqual(managerEconomyOf(), {discipline: true, contextTokens: 2500, measurement: true});
  assert.deepEqual(managerEconomyOf({managerDiscipline: false, measurement: false, managerContextTokens: 900}), {discipline: false, contextTokens: 900, measurement: false});
});

test('banco real: a migração aceita o registro do gerente (estimado e informado)', async () => {
  const base = process.env.AC_TEST_DATABASE_URL;
  if (!base) throw Error('ISOLATED_DATABASE_REQUIRED');
  const isolated = await isolatedDatabase(base, 'managerusage');
  const db = new Ledger(isolated.url);
  const dir = await mkdtemp(join(tmpdir(), 'ac-t6-docker-'));
  const docker = join(dir, 'docker');
  await writeFile(docker, '#!/bin/sh\necho \'{"kind":"plan","answer":"resumo"}\'\necho "tokens used" >&2\necho "4,321" >&2\n');
  await chmod(docker, 0o755);
  try {
    await db.migrate();
    const account = randomUUID();
    const project = randomUUID();
    const profiles = {rows: [{account_id: account, provider: 'codex', model: 'gpt-6.2-sol', effort: 'high'}]};
    const wrapped = {pool: {query: (sql: string, params?: unknown[]) => sql.includes('FROM ac_profiles') ? Promise.resolve(profiles) : db.pool.query(sql, params)}} as unknown as Ledger;
    const chat = new PersonalManagerChat(wrapped, {imageId: 'img', accountRoot: '/x', docker});
    await chat.decide('mude a cor do botão', 'CTX', {measure: true, projectId: project});
    const rows = (await db.pool.query('SELECT provider,model,role,total_tokens,input_tokens,estimated,prompt_chars FROM ac_manager_chat_usage')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, 'manager');
    assert.equal(rows[0].estimated, false);
    assert.equal(Number(rows[0].total_tokens), 4321);
    assert.equal(rows[0].input_tokens, null);
  } finally {
    await db.close();
    await isolated.close();
    await rm(dir, {recursive: true, force: true});
  }
});
