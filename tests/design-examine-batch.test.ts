import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {designBenchWorker} from '../src/design-bench.ts';
import {loadDesignChecklist} from '../src/design-checklist.ts';
import {examineDesignScreens, type DesignSeat} from '../src/design-examine.ts';
import {batchReceiptIntact, batchReceiptJudges, sha256Text} from '../src/exam-batch-proof.ts';
import type {DesignWorker} from '../src/design-types.ts';

const BATCH = {tokens: 40_000, files: 8};

function screens(count: number, captured = false) {
  return Array.from({length: count}, (_, index) => ({
    file: `src/Tela${index}.tsx`,
    route: `/t${index}`,
    code: `export function Tela${index}() {\n  return <button type="button">Salvar ${index}</button>;\n}\n`,
    captureNote: 'sem captura',
    ...(captured ? {captures: [{path: `/tmp/cap-${index}.png`, viewport: 375, theme: 'claro' as const, state: 'padrao', sha256: String(index).repeat(64).slice(0, 64)}]} : {}),
  }));
}

function kit() {
  const events: string[] = [];
  const reserve = async (role: 'specialist' | 'reviewer'): Promise<DesignSeat> => {
    events.push(`reserve:${role}`);
    return {provider: 'claude', model: role === 'reviewer' ? 'modelo-revisor' : 'modelo-especialista', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
  };
  const release = async (_seat: DesignSeat) => { events.push('release'); };
  return {events, reserve, release};
}

/** Answers a batch request item by item; `behavior` lets a test make the model fail the envelope or skip a screen. */
function batchWorker(tasks: string[], behavior: {plain?: boolean; skip?: string} = {}): DesignWorker {
  return {
    async run(call) {
      tasks.push(call.task);
      if (call.task.startsWith('Pedido de exame em lote.')) {
        if (behavior.plain) return JSON.stringify({kind: 'exame', filesRead: ['x'], checklist: ['x'], findings: []});
        const files = [...call.task.matchAll(/^- (src\/Tela\d+\.tsx)$/gm)].map(match => match[1]!).filter(file => file !== behavior.skip);
        const items = (call.task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
        return JSON.stringify({kind: 'exame-lote', results: files.map(file => ({file, kind: 'exame', filesRead: [file], checklist: items, findings: []}))});
      }
      return designBenchWorker().run(call);
    },
  };
}

const base = {repo: '/tmp/repo-design', checklist: loadDesignChecklist(), rawFindings: []};

test('telas sem captura dividem uma chamada e cada uma tem recibo com hash e julgamento', async () => {
  const k = kit();
  const tasks: string[] = [];
  const list = screens(8);
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: list, batch: BATCH, worker: batchWorker(tasks), reserve: k.reserve, release: k.release});
  assert.equal(tasks.length, 1);
  assert.match(tasks[0]!, /^Pedido de exame em lote\./);
  assert.deepEqual(result.coverage.map(row => row.file), list.map(item => item.file));
  assert.equal(k.events.filter(event => event === 'reserve:specialist').length, 1);
  assert.equal(result.batchReceipts.length, 1);
  const receipt = result.batchReceipts[0]!;
  assert.equal(batchReceiptIntact(receipt), true);
  for (const item of list) assert.equal(batchReceiptJudges(receipt, item.file, sha256Text(item.code)), true);
  assert.equal(batchReceiptJudges(receipt, list[0]!.file, sha256Text('outro conteúdo')), false);
  const forged = {...receipt, files: receipt.files.map((item, at) => (at === 0 ? {...item, sha256: sha256Text('x')} : item))};
  assert.equal(batchReceiptIntact(forged), false);
  assert.deepEqual(new Set(result.coverage.map(row => row.profileId)).size, 1);
});

test('medição: o lote usa uma chamada e menos entrada que oito chamadas', async () => {
  const measure = async (batch: typeof BATCH | false | undefined) => {
    const k = kit();
    const tasks: string[] = [];
    await examineDesignScreens({...base, intentId: randomUUID(), screens: screens(8), ...(batch === undefined ? {} : {batch}), worker: batchWorker(tasks), reserve: k.reserve, release: k.release});
    return {calls: tasks.length, chars: tasks.reduce((sum, task) => sum + task.length, 0)};
  };
  const single = await measure(undefined);
  const off = await measure(false);
  const batched = await measure(BATCH);
  assert.deepEqual(off, single);
  assert.equal(single.calls, 8);
  assert.equal(batched.calls, 1);
  assert.ok(batched.chars < single.chars, `${batched.chars} < ${single.chars}`);
  console.log(`design lote: ${single.calls} chamadas e ${single.chars} caracteres sem lote; ${batched.calls} chamada e ${batched.chars} com lote`);
});

test('envelope errado cai para chamadas individuais sem perder cobertura nem prova', async () => {
  const k = kit();
  const tasks: string[] = [];
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: screens(4), batch: BATCH, worker: batchWorker(tasks, {plain: true}), reserve: k.reserve, release: k.release});
  assert.equal(tasks.filter(task => task.startsWith('Pedido de exame em lote.')).length, 1);
  assert.equal(tasks.filter(task => task.startsWith('Pedido de exame.')).length, 4);
  assert.equal(result.coverage.length, 4);
  const batch = result.batchReceipts.find(receipt => receipt.callId === 'lote-1')!;
  assert.deepEqual(batch.files.map(item => item.judged), [false, false, false, false]);
  const singles = result.batchReceipts.filter(receipt => receipt.callId !== 'lote-1');
  assert.equal(singles.length, 4);
  for (const receipt of singles) { assert.equal(receipt.files.length, 1); assert.equal(receipt.files[0]!.judged, true); assert.equal(batchReceiptIntact(receipt), true); }
});

test('tela omitida pelo modelo é examinada sozinha e as outras ficam no lote', async () => {
  const k = kit();
  const tasks: string[] = [];
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: screens(4), batch: BATCH, worker: batchWorker(tasks, {skip: 'src/Tela2.tsx'}), reserve: k.reserve, release: k.release});
  assert.equal(tasks.filter(task => task.startsWith('Pedido de exame.')).length, 1);
  assert.equal(result.coverage.length, 4);
  const batch = result.batchReceipts.find(receipt => receipt.callId === 'lote-1')!;
  assert.deepEqual(batch.files.map(item => [item.file, item.judged]), [['src/Tela0.tsx', true], ['src/Tela1.tsx', true], ['src/Tela2.tsx', false], ['src/Tela3.tsx', true]]);
  assert.ok(result.notes.some(note => /deixou 1 tela/.test(note)));
});

test('telas com captura continuam individuais, com batch ligado', async () => {
  const k = kit();
  const tasks: string[] = [];
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: screens(3, true), batch: BATCH, worker: batchWorker(tasks), reserve: k.reserve, release: k.release});
  assert.equal(tasks.filter(task => task.startsWith('Pedido de exame em lote.')).length, 0);
  assert.equal(tasks.filter(task => task.startsWith('Pedido de exame.')).length, 3);
  assert.equal(result.batchReceipts.length, 0);
  assert.equal(result.coverage.length, 3);
});

test('a crítica visual segue uma por tela, com examinador e revisor, mesmo em lote', async () => {
  const k = kit();
  const tasks: string[] = [];
  await examineDesignScreens({...base, intentId: randomUUID(), screens: screens(4), batch: BATCH, scoreVisual: true, worker: batchWorker(tasks), reserve: k.reserve, release: k.release});
  assert.equal(tasks.filter(task => task.startsWith('Pedido de crítica visual.')).length, 4);
  assert.equal(tasks.filter(task => task.startsWith('Pedido de crítica visual do revisor.')).length, 4);
  assert.equal(tasks.filter(task => task.startsWith('Pedido de exame em lote.')).length, 1);
});

test('reexame individual com saída inválida ou sem a tela em filesRead fica pendente no recibo', async () => {
  const solo = (mode: 'lixo' | 'sem-tela'): DesignWorker => ({
    async run(call) {
      if (call.task.startsWith('Pedido de exame em lote.')) return JSON.stringify({kind: 'exame', filesRead: ['x'], checklist: ['x'], findings: []});
      if (call.task.startsWith('Pedido de exame.')) {
        if (mode === 'lixo') return 'isto não é JSON';
        const items = (call.task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
        return JSON.stringify({kind: 'exame', filesRead: ['src/Outra.tsx'], checklist: items, findings: []});
      }
      return designBenchWorker().run(call);
    },
  });
  for (const mode of ['lixo', 'sem-tela'] as const) {
    const k = kit();
    const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: screens(2), batch: BATCH, worker: solo(mode), reserve: k.reserve, release: k.release});
    const singles = result.batchReceipts.filter(receipt => receipt.callId !== 'lote-1');
    assert.equal(singles.length, 2, mode);
    for (const receipt of singles) {
      assert.equal(receipt.files[0]!.judged, false, mode);
      assert.equal(batchReceiptIntact(receipt), true);
    }
  }
});

test('a base da prova passa pelo lote, que normaliza duas vezes', async () => {
  const k = kit();
  const tasks: string[] = [];
  const list = screens(2);
  const worker: DesignWorker = {
    async run(call) {
      tasks.push(call.task);
      if (call.task.startsWith('Pedido de exame em lote.')) {
        return JSON.stringify({kind: 'exame-lote', results: list.map(item => ({
          file: item.file,
          filesRead: [item.file],
          checklist: ['DESIGN-NIELSEN-H1-ESTADO'],
          findings: [{
            title: 'Sombra pesada', severity: 'media', file: item.file, line: 2, scenario: 'A sombra pesa.',
            suggestion: 'Use box-shadow: 0 1px 2px #0000001a.', cwe: null, reference: 'DESIGN-TOKENS-SOMBRA',
            snippet: 'sombra', basis: 'preferência',
          }],
        }))});
      }
      return designBenchWorker().run(call);
    },
  };
  const result = await examineDesignScreens({...base, intentId: randomUUID(), screens: list, batch: BATCH, worker, reserve: k.reserve, release: k.release});
  assert.equal(tasks.length, 1);
  assert.ok(tasks[0]!.includes('Cada finding tem basis:'));
  assert.deepEqual(result.findings.map(item => [item.basis, item.severity]), [['preferencia', 'informativa'], ['preferencia', 'informativa']]);
  assert.ok(result.confirmations.every(row => row.verifier === null && row.confirm.status === 'provavel'));
  assert.equal(k.events.includes('reserve:reviewer'), false);
});
