import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {analyzeTrial, bootstrapInterval, formatTrialReport, mcnemarExact, normalQuantile, parseTrialInput, seededRandom, TrialInputError, type Run, type TrialCase} from '../src/economy-trial.ts';
import {runPersonalEconomia} from '../src/personal-economia-cli.ts';

/** Casos sintéticos: custo por caso e acerto por repetição gerados de forma determinística, sem modelo. */
function synth(opts: {cases: number; reps: number; baseCost: (i: number, r: number) => number; candCost: (i: number, r: number) => number; baseOk: (i: number, r: number) => boolean; candOk: (i: number, r: number) => boolean}): TrialCase[] {
  return Array.from({length: opts.cases}, (_, i) => ({
    id: 'c' + i,
    base: Array.from({length: opts.reps}, (_, r): Run => ({entrada: opts.baseCost(i, r), saida: 100, cacheLido: 50, cacheGravado: 10, acerto: opts.baseOk(i, r)})),
    candidata: Array.from({length: opts.reps}, (_, r): Run => ({entrada: opts.candCost(i, r), saida: 100, cacheLido: 50, cacheGravado: 10, acerto: opts.candOk(i, r)})),
  }));
}

test('McNemar exato contra valores conhecidos', () => {
  assert.equal(mcnemarExact(0, 6), 0.03125);
  assert.equal(mcnemarExact(6, 0), 0.03125);
  assert.equal(mcnemarExact(0, 0), 1);
  assert.equal(mcnemarExact(3, 3), 1);
  assert.equal(mcnemarExact(0, 5), 0.0625);
  assert.equal(mcnemarExact(3, 0), 0.25);
  // b=1, c=9: 2 * (1 + 10) / 1024
  assert.ok(Math.abs(mcnemarExact(1, 9) - 22 / 1024) < 1e-12);
  // n grande não estoura: b=40, c=60, valor de referência da binomial exata (scipy.stats.binomtest) 0,0569
  assert.ok(Math.abs(mcnemarExact(40, 60) - 0.05688793) < 1e-6);
  assert.throws(() => mcnemarExact(-1, 2), RangeError);
});

test('bootstrap determinístico: mesma semente, mesmo intervalo; semente diferente muda', () => {
  const xs = [5, 7, 9, 2, 11, 4, 8, 6, 10, 3];
  const stat = (idx: number[]) => idx.reduce((s, i) => s + xs[i], 0) / idx.length;
  const a = bootstrapInterval(xs.length, stat, 0.05, 42, 2000);
  const b = bootstrapInterval(xs.length, stat, 0.05, 42, 2000);
  const c = bootstrapInterval(xs.length, stat, 0.05, 43, 2000);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a[0] < 6.5 && 6.5 < a[1], 'o intervalo contém a média');
  const r1 = seededRandom(7), r2 = seededRandom(7);
  for (let i = 0; i < 5; i++) assert.equal(r1(), r2());
  // Unidades idênticas: o intervalo colapsa no valor.
  assert.deepEqual(bootstrapInterval(4, () => 3, 0.05, 1, 200), [3, 3]);
});

test('quantil da normal', () => {
  assert.ok(Math.abs(normalQuantile(0.975) - 1.959964) < 1e-5);
  assert.ok(Math.abs(normalQuantile(0.8) - 0.841621) < 1e-5);
});

test('economia real sem perda de qualidade: entra no padrão', () => {
  const casos = synth({cases: 12, reps: 3, baseCost: (i, r) => 10000 + i * 500 + r * 37, candCost: (i, r) => 6000 + i * 300 + ((i * 7 + r) % 5) * 40, baseOk: (i) => i !== 3, candOk: (i) => i !== 3});
  const r = analyzeTrial({experimento: 'sintético', casos});
  assert.equal(r.veredito, 'entra no padrão', formatTrialReport(r));
  assert.equal(r.qualidade.b, 0);
  assert.equal(r.qualidade.c, 0);
  assert.equal(r.qualidade.pValor, 1);
  assert.ok(r.custo.intervaloRelativo[0] > 0.3);
  assert.equal(r.pares, 36);
  // Os quatro contadores entram no custo com peso 1.
  assert.equal(r.base.custoTotal, r.base.tokens.entrada + r.base.tokens.saida + r.base.tokens.cacheLido + r.base.tokens.cacheGravado);
  assert.equal(r.casosNecessarios, null);
  // Mesma entrada, mesmo resultado (determinístico).
  assert.deepEqual(analyzeTrial({experimento: 'sintético', casos}), r);
});

test('economia com perda de qualidade significativa: não entra', () => {
  const casos = synth({cases: 10, reps: 3, baseCost: () => 10000, candCost: (i) => 4000 + i * 10, baseOk: () => true, candOk: (i, r) => !(r === 0 || (r === 1 && i < 4))});
  const r = analyzeTrial({casos});
  assert.equal(r.veredito, 'não entra', formatTrialReport(r));
  assert.equal(r.qualidade.b, 14);
  assert.equal(r.qualidade.c, 0);
  assert.ok(r.qualidade.pValor < 0.001);
  assert.match(r.motivos[0], /qualidade piorou/);
});

test('custo maior: não entra', () => {
  const casos = synth({cases: 10, reps: 3, baseCost: () => 5000, candCost: () => 5200, baseOk: () => true, candOk: () => true});
  const r = analyzeTrial({casos});
  assert.equal(r.veredito, 'não entra');
  assert.match(r.motivos[0], /custo não caiu/);
});

test('ruído: inconclusivo, com os casos que faltam', () => {
  // Economia média pequena perto de um ruído grande, poucos casos.
  const noise = [3000, -2500, 2000, -1800, 2600, -2200];
  const casos = synth({cases: 6, reps: 3, baseCost: () => 10000, candCost: (i) => 9800 + noise[i], baseOk: (i, r) => (i + r) % 4 !== 0, candOk: (i, r) => (i + r) % 4 !== 1});
  const r = analyzeTrial({casos});
  assert.equal(r.veredito, 'inconclusivo', formatTrialReport(r));
  assert.ok(r.custo.intervalo[0] < 0 && r.custo.intervalo[1] > 0, 'o intervalo cruza zero');
  assert.ok(r.casosNecessarios !== null && r.casosNecessarios > 6);
  assert.equal(r.casosFaltando, r.casosNecessarios! - 6);
  assert.match(formatTrialReport(r), /VEREDITO: inconclusivo[\s\S]*faltam \d+/);
});

test('poucas repetições ou poucos pares: inconclusivo mesmo com economia limpa', () => {
  const casos = synth({cases: 12, reps: 1, baseCost: (i) => 10000 + i, candCost: (i) => 5000 + i, baseOk: () => true, candOk: () => true});
  const r = analyzeTrial({casos});
  assert.equal(r.veredito, 'inconclusivo');
  assert.ok(r.motivos.some(m => /repetições por caso: 1/.test(m)));
  assert.ok(r.motivos.some(m => /pares de qualidade: 12/.test(m)));
  assert.equal(r.casosNecessarios, 10); // 30 pares (regra de três para 10%) / 3 repetições
});

test('não medido conta como reprovado; acerto não medido conta como erro', () => {
  const casos = synth({cases: 12, reps: 3, baseCost: () => 10000, candCost: () => 5000, baseOk: () => true, candOk: () => true});
  casos[2].candidata[1] = {entrada: null, acerto: true};
  const r = analyzeTrial({casos});
  assert.equal(r.veredito, 'não entra');
  assert.match(r.motivos[0], /não medido/);

  const casos2 = synth({cases: 12, reps: 3, baseCost: () => 10000, candCost: () => 5000, baseOk: () => true, candOk: () => true});
  delete casos2[0].candidata[0].acerto;
  casos2[1].candidata = casos2[1].candidata.slice(0, 2);
  const r2 = analyzeTrial({casos: casos2});
  assert.equal(r2.veredito, 'não entra');
  assert.equal(r2.qualidade.b, 1);
  assert.ok(r2.naoMedido.some(m => /acerto da candidata não medido/.test(m)));
  assert.ok(r2.naoMedido.some(m => /c1: base com 3 repetições e candidata com 2/.test(m)));

  // saida null é não medido; saida ausente não se aplica.
  const casos3 = synth({cases: 12, reps: 3, baseCost: () => 10000, candCost: () => 5000, baseOk: () => true, candOk: () => true});
  casos3[0].base[0].saida = null;
  assert.equal(analyzeTrial({casos: casos3}).veredito, 'não entra');
  for (const c of casos3) for (const run of [...c.base, ...c.candidata]) delete run.saida;
  assert.equal(analyzeTrial({casos: casos3}).veredito, 'entra no padrão');
});

test('pesos e economia mínima dos portões', () => {
  // Candidata troca entrada por cache lido: com peso 1 economiza, com cache tão caro quanto a entrada (peso 1) e entrada barata não.
  const casos: TrialCase[] = Array.from({length: 12}, (_, i) => ({id: 'p' + i,
    base: [0, 1, 2].map(r => ({entrada: 10000 + i * 10 + r, acerto: true})),
    candidata: [0, 1, 2].map(r => ({entrada: 2000 + r, cacheLido: 6000 + i * 10, acerto: true}))}));
  assert.equal(analyzeTrial({casos}).veredito, 'entra no padrão');
  assert.equal(analyzeTrial({casos, portoes: {pesos: {cacheLido: 2}}}).veredito, 'não entra');
  // Economia de ~20%: passa com mínimo de 10%, não passa (inconclusivo) com mínimo de 50%.
  assert.equal(analyzeTrial({casos, portoes: {economiaMinima: 0.1}}).veredito, 'entra no padrão');
  assert.equal(analyzeTrial({casos, portoes: {economiaMinima: 0.5}}).veredito, 'inconclusivo');
});

test('validação do formato', () => {
  assert.throws(() => parseTrialInput({casos: []}), TrialInputError);
  assert.throws(() => parseTrialInput({casos: [{id: 'a', base: [{entrada: 1, acerto: true}]}]}), TrialInputError);
  assert.throws(() => parseTrialInput({casos: [{id: 'a', base: [{}], candidata: [{}]}, {id: 'a', base: [{}], candidata: [{}]}]}), /repetido/);
  assert.throws(() => parseTrialInput({portoes: {margemQualidade: 0}, casos: [{id: 'a', base: [{}], candidata: [{}]}]}), /margemQualidade/);
  assert.throws(() => parseTrialInput({bootstrap: {reamostras: 10}, casos: [{id: 'a', base: [{}], candidata: [{}]}]}), /reamostras/);
});

test('CLI lê o arquivo e o exemplo T5 sai inconclusivo com os números do relatório', async () => {
  const t5 = resolve(import.meta.dirname, '..', 'docs/economia/exemplos/t5-grafo.json');
  const {result, output} = await runPersonalEconomia([t5]);
  assert.equal(result.veredito, 'inconclusivo');
  assert.equal(result.base.tokens.entrada, 151178);
  assert.equal(result.candidata.tokens.entrada, 9186);
  assert.equal(result.qualidade.b, 3);
  assert.equal(result.qualidade.c, 0);
  assert.equal(result.qualidade.pValor, 0.25);
  assert.match(output, /VEREDITO: inconclusivo/);

  const dir = await mkdtemp(join(tmpdir(), 'ac-economia-'));
  try {
    const file = join(dir, 'r.json');
    await writeFile(file, JSON.stringify({casos: synth({cases: 12, reps: 3, baseCost: () => 9000, candCost: () => 3000, baseOk: () => true, candOk: () => true})}));
    const json = await runPersonalEconomia([file, '--json']);
    assert.equal(JSON.parse(json.output).veredito, 'entra no padrão');
    await writeFile(file, '{');
    await assert.rejects(runPersonalEconomia([file]), TrialInputError);
    await assert.rejects(runPersonalEconomia([]), /uso:/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
