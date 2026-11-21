/**
 * Protocolo B1: prova de "economia sem perda de qualidade" (docs/economia/PROTOCOLO.md).
 *
 * Compara duas variantes (base e candidata) nos MESMOS casos, com N repetições por caso, e dá um veredito:
 * - "entra no padrão": a economia é significativa (limite inferior do intervalo acima da economia mínima) e a
 *   qualidade não piora de forma significativa (McNemar exato) E fica dentro da margem aceita (limite superior da perda
 *   de qualidade <= margem, com pares suficientes);
 * - "não entra": a qualidade piora de forma significativa, o custo não cai, ou falta medida (não medido conta como reprovado);
 * - "inconclusivo": nada disso se decide com as amostras; o relatório diz quantos casos faltam (cálculo simples).
 *
 * Unidades: o custo é comparado por caso (média das repetições), com bootstrap determinístico que reamostra casos, e a
 * qualidade é comparada em pares (caso, repetição i da base, repetição i da candidata) com McNemar exato bilateral.
 * Não chama modelos: só lê resultados já medidos.
 *
 * Formato de entrada (JSON):
 * {
 *   "experimento": "texto",                     // nome
 *   "fonte": "texto",                           // de onde vieram os números (opcional)
 *   "variantes": {"base": "rótulo", "candidata": "rótulo"},
 *   "portoes": {                                // escritos ANTES de rodar; todos opcionais
 *     "alfa": 0.05,                             // nível dos testes e dos intervalos (bilateral)
 *     "margemQualidade": 0.10,                  // perda de acerto aceita, em fração (0,10 = 10 pontos percentuais)
 *     "economiaMinima": 0,                      // economia relativa mínima exigida (0,1 = 10% do custo da base)
 *     "repeticoesMinimas": 3,
 *     "pesos": {"entrada":1,"saida":1,"cacheLido":1,"cacheGravado":1},  // custo = soma ponderada dos tokens
 *     "mecanismo": "texto"                      // por que se espera economia
 *   },
 *   "bootstrap": {"semente": 20261121, "reamostras": 10000},             // opcional
 *   "casos": [
 *     {"id": "q1",
 *      "base":      [{"entrada": 100, "saida": 20, "cacheLido": 0, "cacheGravado": 0, "acerto": true}, ...],
 *      "candidata": [{"entrada": 40,  "saida": 20, "acerto": true}, ...]}
 *   ]
 * }
 * Cada repetição precisa de "entrada" (número >= 0) e "acerto" (true/false). "saida", "cacheLido" e "cacheGravado"
 * entram quando houver: campo ausente quer dizer que não se aplica (vale 0); null quer dizer que devia existir e não foi
 * medido. Não medido: acerto conta como erro; custo (inclusive "entrada" ausente) reprova a candidata. As repetições são
 * pareadas pela posição; base e candidata precisam do mesmo número por caso. Campos extras (como "nota") são ignorados.
 */

export type Run = {entrada?: number | null; saida?: number | null; cacheLido?: number | null; cacheGravado?: number | null; acerto?: boolean | null};
export type TrialCase = {id: string; base: Run[]; candidata: Run[]};
export type Weights = {entrada: number; saida: number; cacheLido: number; cacheGravado: number};
export type Gates = {alfa: number; margemQualidade: number; economiaMinima: number; repeticoesMinimas: number; pesos: Weights; mecanismo?: string};
export type TrialInput = {
  experimento?: string; fonte?: string; variantes?: {base?: string; candidata?: string};
  portoes?: Partial<Omit<Gates, 'pesos'>> & {pesos?: Partial<Weights>};
  bootstrap?: {semente?: number; reamostras?: number};
  casos: TrialCase[];
};
export type Verdict = 'entra no padrão' | 'não entra' | 'inconclusivo';

export type ArmSummary = {
  rotulo: string; execucoes: number;
  tokens: {entrada: number; saida: number; cacheLido: number; cacheGravado: number};
  custoTotal: number; custoMedioPorCaso: number;
  acertos: number; taxaAcerto: number;
};
export type TrialResult = {
  experimento: string; fonte?: string; portoes: Gates; semente: number; reamostras: number;
  casos: number; repeticoes: number; pares: number;
  naoMedido: string[];
  base: ArmSummary; candidata: ArmSummary;
  custo: {economiaMediaPorCaso: number; intervalo: [number, number]; economiaRelativa: number; intervaloRelativo: [number, number]};
  qualidade: {b: number; c: number; pValor: number; perdaObservada: number; limiteSuperiorPerda: number; paresMinimos: number};
  veredito: Verdict; motivos: string[];
  casosNecessarios: number | null; casosFaltando: number | null;
};

export class TrialInputError extends Error {}

const DEFAULT_GATES: Gates = {alfa: 0.05, margemQualidade: 0.10, economiaMinima: 0, repeticoesMinimas: 3, pesos: {entrada: 1, saida: 1, cacheLido: 1, cacheGravado: 1}};
export const DEFAULT_SEED = 20261121;
export const DEFAULT_RESAMPLES = 10000;

/** McNemar exato bilateral: b = pares em que só a base acertou, c = só a candidata. p = min(1, 2 * P(X <= min(b,c))), X ~ Bin(b+c, 1/2). */
export function mcnemarExact(b: number, c: number): number {
  if (!Number.isInteger(b) || !Number.isInteger(c) || b < 0 || c < 0) throw new RangeError('b e c precisam ser inteiros >= 0');
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  if (n <= 1000) {
    // P(X=0) = 2^-n é exato em ponto flutuante; os termos seguintes saem da razão (n-i+1)/i.
    let term = 2 ** -n;
    for (let i = 0; i <= k; i++) { if (i > 0) term = term * (n - i + 1) / i; tail += term; }
  } else {
    // n grande: 2^-n some no ponto flutuante; soma em escala logarítmica, log C(n,i) - n*log 2.
    let logC = 0;
    for (let i = 0; i <= k; i++) { if (i > 0) logC += Math.log(n - i + 1) - Math.log(i); tail += Math.exp(logC - n * Math.LN2); }
  }
  return Math.min(1, 2 * tail);
}

/** Gerador determinístico (mulberry32): mesma semente, mesma sequência. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Bootstrap percentil determinístico sobre unidades (casos). `stat` recebe os índices reamostrados.
 * Devolve o intervalo bilateral de nível 1 - alfa.
 */
export function bootstrapInterval(units: number, stat: (idx: number[]) => number, alfa: number, seed: number, resamples: number): [number, number] {
  if (units === 0) return [NaN, NaN];
  const rnd = seededRandom(seed);
  const values: number[] = [];
  const idx = new Array<number>(units);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < units; i++) idx[i] = Math.floor(rnd() * units);
    const v = stat(idx);
    if (Number.isFinite(v)) values.push(v);
  }
  values.sort((x, y) => x - y);
  return [quantile(values, alfa / 2), quantile(values, 1 - alfa / 2)];
}

/** Quantil da normal padrão (Acklam), para o cálculo simples de amostra. */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError('p fora de (0,1)');
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function gatesOf(input: TrialInput): Gates {
  const p = input.portoes ?? {};
  const g: Gates = {
    alfa: p.alfa ?? DEFAULT_GATES.alfa,
    margemQualidade: p.margemQualidade ?? DEFAULT_GATES.margemQualidade,
    economiaMinima: p.economiaMinima ?? DEFAULT_GATES.economiaMinima,
    repeticoesMinimas: p.repeticoesMinimas ?? DEFAULT_GATES.repeticoesMinimas,
    pesos: {...DEFAULT_GATES.pesos, ...(p.pesos ?? {})},
    ...(p.mecanismo ? {mecanismo: p.mecanismo} : {}),
  };
  if (!(g.alfa > 0 && g.alfa < 0.5)) throw new TrialInputError('portoes.alfa precisa estar entre 0 e 0,5');
  if (!(g.margemQualidade > 0 && g.margemQualidade < 1)) throw new TrialInputError('portoes.margemQualidade precisa estar entre 0 e 1 (exclusivo)');
  if (!(g.economiaMinima >= 0 && g.economiaMinima < 1)) throw new TrialInputError('portoes.economiaMinima precisa estar entre 0 e 1');
  if (!(Number.isInteger(g.repeticoesMinimas) && g.repeticoesMinimas >= 1)) throw new TrialInputError('portoes.repeticoesMinimas precisa ser inteiro >= 1');
  for (const [k, v] of Object.entries(g.pesos)) if (!isCount(v)) throw new TrialInputError('portoes.pesos.' + k + ' precisa ser número >= 0');
  return g;
}

/** Valida a forma do arquivo. Valores ausentes dentro das repetições não são erro: viram "não medido". */
export function parseTrialInput(raw: unknown): TrialInput {
  if (!raw || typeof raw !== 'object') throw new TrialInputError('o arquivo precisa ser um objeto JSON');
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.casos) || o.casos.length === 0) throw new TrialInputError('"casos" precisa ser uma lista não vazia');
  const ids = new Set<string>();
  for (const [i, c] of (o.casos as unknown[]).entries()) {
    if (!c || typeof c !== 'object') throw new TrialInputError('caso ' + i + ' não é objeto');
    const cc = c as Record<string, unknown>;
    if (typeof cc.id !== 'string' || cc.id === '') throw new TrialInputError('caso ' + i + ' sem "id"');
    if (ids.has(cc.id)) throw new TrialInputError('caso repetido: ' + cc.id);
    ids.add(cc.id);
    for (const arm of ['base', 'candidata'] as const) {
      if (!Array.isArray(cc[arm]) || (cc[arm] as unknown[]).length === 0) throw new TrialInputError('caso ' + cc.id + ': "' + arm + '" precisa ser lista não vazia de repetições');
      for (const r of cc[arm] as unknown[]) if (!r || typeof r !== 'object') throw new TrialInputError('caso ' + cc.id + ': repetição de "' + arm + '" não é objeto');
    }
  }
  const input = raw as TrialInput;
  gatesOf(input);
  const s = input.bootstrap?.semente, n = input.bootstrap?.reamostras;
  if (s !== undefined && !Number.isInteger(s)) throw new TrialInputError('bootstrap.semente precisa ser inteiro');
  if (n !== undefined && !(Number.isInteger(n) && n >= 100)) throw new TrialInputError('bootstrap.reamostras precisa ser inteiro >= 100');
  return input;
}

/** Custo ponderado de uma repetição. "entrada" é obrigatória; "saida" e os caches ausentes não se aplicam (0), mas null é não medido. */
function runCost(r: Run, w: Weights): number | null {
  if (!isCount(r.entrada)) return null;
  for (const k of ['saida', 'cacheLido', 'cacheGravado'] as const) if (r[k] !== undefined && !isCount(r[k])) return null;
  return w.entrada * r.entrada + w.saida * (r.saida ?? 0) + w.cacheLido * (r.cacheLido ?? 0) + w.cacheGravado * (r.cacheGravado ?? 0);
}

function summarize(rotulo: string, cases: TrialCase[], arm: 'base' | 'candidata', w: Weights): ArmSummary {
  const tokens = {entrada: 0, saida: 0, cacheLido: 0, cacheGravado: 0};
  let custo = 0, acertos = 0, execucoes = 0;
  for (const c of cases) for (const r of c[arm]) {
    execucoes++;
    for (const k of Object.keys(tokens) as (keyof typeof tokens)[]) if (isCount(r[k])) tokens[k] += r[k] as number;
    custo += runCost(r, w) ?? 0;
    if (r.acerto === true) acertos++;
  }
  return {rotulo, execucoes, tokens, custoTotal: custo, custoMedioPorCaso: custo / cases.length, acertos, taxaAcerto: execucoes ? acertos / execucoes : 0};
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

export function analyzeTrial(rawInput: unknown): TrialResult {
  const input = parseTrialInput(rawInput);
  const g = gatesOf(input);
  const seed = input.bootstrap?.semente ?? DEFAULT_SEED;
  const resamples = input.bootstrap?.reamostras ?? DEFAULT_RESAMPLES;
  const cases = input.casos;
  const naoMedido: string[] = [];
  let costMissing = false;
  const reps: number[] = [];

  // Por caso: custo médio de cada braço, acerto médio de cada braço, e os pares de qualidade.
  const baseCost: number[] = [], candCost: number[] = [], qualLoss: number[] = [];
  let b = 0, c = 0, pairs = 0;
  for (const cs of cases) {
    if (cs.base.length !== cs.candidata.length) { costMissing = true; naoMedido.push(cs.id + ': base com ' + cs.base.length + ' repetições e candidata com ' + cs.candidata.length); }
    const n = Math.min(cs.base.length, cs.candidata.length);
    reps.push(n);
    const bc: number[] = [], cc: number[] = [];
    let lossSum = 0;
    for (let i = 0; i < n; i++) {
      const rb = cs.base[i], rc = cs.candidata[i];
      const kb = runCost(rb, g.pesos), kc = runCost(rc, g.pesos);
      if (kb === null) { costMissing = true; naoMedido.push(cs.id + ' #' + (i + 1) + ': custo da base não medido'); }
      else bc.push(kb);
      if (kc === null) { costMissing = true; naoMedido.push(cs.id + ' #' + (i + 1) + ': custo da candidata não medido'); }
      else cc.push(kc);
      if (typeof rb.acerto !== 'boolean') naoMedido.push(cs.id + ' #' + (i + 1) + ': acerto da base não medido (conta como erro)');
      if (typeof rc.acerto !== 'boolean') naoMedido.push(cs.id + ' #' + (i + 1) + ': acerto da candidata não medido (conta como erro)');
      const ab = rb.acerto === true, ac = rc.acerto === true;
      if (ab && !ac) b++;
      if (!ab && ac) c++;
      lossSum += (ab ? 1 : 0) - (ac ? 1 : 0);
      pairs++;
    }
    baseCost.push(bc.length ? mean(bc) : 0);
    candCost.push(cc.length ? mean(cc) : 0);
    qualLoss.push(n ? lossSum / n : 0);
  }
  const K = cases.length;
  const R = Math.min(...reps);
  const diffs = baseCost.map((x, i) => x - candCost[i]);
  const meanDiff = mean(diffs);
  const sumBase = baseCost.reduce((s, x) => s + x, 0);
  const relative = sumBase > 0 ? diffs.reduce((s, x) => s + x, 0) / sumBase : NaN;
  const ci = bootstrapInterval(K, idx => mean(idx.map(i => diffs[i])), g.alfa, seed, resamples);
  const ciRel = bootstrapInterval(K, idx => { const sb = idx.reduce((s, i) => s + baseCost[i], 0); return sb > 0 ? idx.reduce((s, i) => s + diffs[i], 0) / sb : NaN; }, g.alfa, seed, resamples);
  // Perda de qualidade por caso (acerto da base - acerto da candidata); o limite superior vem do mesmo bootstrap por casos.
  const lossObserved = pairs ? (b - c) / pairs : 0;
  const lossUpper = bootstrapInterval(K, idx => mean(idx.map(i => qualLoss[i])), g.alfa, seed + 1, resamples)[1];
  const p = mcnemarExact(b, c);
  // Regra de três: sem nenhuma perda observada, o limite superior de 95% da taxa de perda é ~3/n. Abaixo disso a margem não se prova.
  const minPairs = Math.ceil(3 / g.margemQualidade);

  const motivos: string[] = [];
  let veredito: Verdict;
  const qualityWorse = p < g.alfa && b > c;
  const costUp = !(meanDiff > 0);
  const savingSignificant = ciRel[0] > g.economiaMinima && ci[0] > 0;
  const nonInferior = lossUpper <= g.margemQualidade && pairs >= minPairs;
  const enoughReps = R >= g.repeticoesMinimas;

  if (costMissing) { veredito = 'não entra'; motivos.push('há custo não medido ou repetições sem par; não medido conta como reprovado'); }
  else if (qualityWorse) { veredito = 'não entra'; motivos.push('a qualidade piorou de forma significativa (McNemar p=' + fmtP(p) + ' < ' + g.alfa + ', b=' + b + ' > c=' + c + ')'); }
  else if (costUp) { veredito = 'não entra'; motivos.push('o custo não caiu (economia média por caso ' + fmtNum(meanDiff) + ')'); }
  else if (enoughReps && savingSignificant && nonInferior) {
    veredito = 'entra no padrão';
    motivos.push('economia significativa: intervalo relativo ' + fmtPct(ciRel[0]) + ' a ' + fmtPct(ciRel[1]) + ' acima de ' + fmtPct(g.economiaMinima));
    motivos.push('qualidade sem piora significativa (McNemar p=' + fmtP(p) + ') e dentro da margem (perda até ' + fmtPct(lossUpper) + ' <= ' + fmtPct(g.margemQualidade) + ')');
  } else {
    veredito = 'inconclusivo';
    if (!enoughReps) motivos.push('repetições por caso: ' + R + ', o mínimo do portão é ' + g.repeticoesMinimas);
    if (!savingSignificant) motivos.push('a economia não é significativa: intervalo relativo ' + fmtPct(ciRel[0]) + ' a ' + fmtPct(ciRel[1]) + ' (mínimo exigido acima de ' + fmtPct(g.economiaMinima) + ')');
    if (!(lossUpper <= g.margemQualidade)) motivos.push('a perda de qualidade pode passar da margem: limite superior ' + fmtPct(lossUpper) + ' > ' + fmtPct(g.margemQualidade) + ' (piora não significativa, p=' + fmtP(p) + ')');
    if (pairs < minPairs) motivos.push('pares de qualidade: ' + pairs + '; para provar a margem de ' + fmtPct(g.margemQualidade) + ' são precisos ao menos ' + minPairs + ' (regra de três)');
  }

  // Cálculo simples de casos para poder de 80%, com as repetições do portão (ou as atuais, se maiores).
  let needed: number | null = null;
  if (veredito === 'inconclusivo') {
    const z = normalQuantile(1 - g.alfa / 2) + normalQuantile(0.8);
    const repsPlan = Math.max(R, g.repeticoesMinimas);
    const sd = K > 1 ? Math.sqrt(diffs.reduce((s, x) => s + (x - meanDiff) ** 2, 0) / (K - 1)) : NaN;
    const target = meanDiff - g.economiaMinima * (sumBase / K);
    const costCases = target > 0 && Number.isFinite(sd) ? Math.ceil((z * sd / target) ** 2) : null;
    const pd = pairs ? (b + c) / pairs : 0;
    const gap = g.margemQualidade - Math.max(lossObserved, 0);
    let qualPairs: number | null;
    if (gap <= 0) qualPairs = null; // com a perda observada, a margem não se prova com nenhuma amostra
    else qualPairs = Math.max(minPairs, Math.ceil(z * z * Math.max(pd - lossObserved ** 2, 0) / (gap * gap)));
    if (costCases !== null && qualPairs !== null) needed = Math.max(costCases, Math.ceil(qualPairs / repsPlan), 2);
    if (costCases === null) motivos.push('não há como estimar os casos necessários para a economia com estes dados');
    if (qualPairs === null) motivos.push('com a perda observada (' + fmtPct(lossObserved) + ') a margem de ' + fmtPct(g.margemQualidade) + ' não se prova com mais casos; só uma candidata melhor');
  }

  return {
    experimento: input.experimento ?? '(sem nome)', ...(input.fonte ? {fonte: input.fonte} : {}),
    portoes: g, semente: seed, reamostras: resamples, casos: K, repeticoes: R, pares: pairs, naoMedido,
    base: summarize(input.variantes?.base ?? 'base', cases, 'base', g.pesos),
    candidata: summarize(input.variantes?.candidata ?? 'candidata', cases, 'candidata', g.pesos),
    custo: {economiaMediaPorCaso: meanDiff, intervalo: ci, economiaRelativa: relative, intervaloRelativo: ciRel},
    qualidade: {b, c, pValor: p, perdaObservada: lossObserved, limiteSuperiorPerda: lossUpper, paresMinimos: minPairs},
    veredito, motivos,
    casosNecessarios: needed, casosFaltando: needed === null ? null : Math.max(0, needed - K),
  };
}

function fmtNum(x: number): string { return Number.isFinite(x) ? (Math.round(x * 10) / 10).toLocaleString('pt-BR') : 'indefinido'; }
function fmtPct(x: number): string { return Number.isFinite(x) ? (Math.round(x * 1000) / 10).toLocaleString('pt-BR') + '%' : 'indefinido'; }
function fmtP(x: number): string { return x < 0.0001 ? x.toExponential(2) : (Math.round(x * 100000) / 100000).toLocaleString('pt-BR'); }

export function formatTrialReport(r: TrialResult): string {
  const nivel = Math.round((1 - r.portoes.alfa) * 100);
  const arm = (name: string, a: ArmSummary) =>
    `  ${name} (${a.rotulo}): ${a.execucoes} execuções; tokens entrada ${fmtNum(a.tokens.entrada)}, saída ${fmtNum(a.tokens.saida)}, cache lido ${fmtNum(a.tokens.cacheLido)}, cache gravado ${fmtNum(a.tokens.cacheGravado)}; custo ponderado ${fmtNum(a.custoTotal)} (${fmtNum(a.custoMedioPorCaso)} por caso); acerto ${a.acertos}/${a.execucoes} (${fmtPct(a.taxaAcerto)})`;
  const lines = [
    'Experimento: ' + r.experimento,
    ...(r.fonte ? ['Fonte: ' + r.fonte] : []),
    `Portões: alfa ${r.portoes.alfa}, margem de qualidade ${fmtPct(r.portoes.margemQualidade)}, economia mínima ${fmtPct(r.portoes.economiaMinima)}, repetições mínimas ${r.portoes.repeticoesMinimas}, pesos entrada ${r.portoes.pesos.entrada} / saída ${r.portoes.pesos.saida} / cache lido ${r.portoes.pesos.cacheLido} / cache gravado ${r.portoes.pesos.cacheGravado}`,
    ...(r.portoes.mecanismo ? ['Mecanismo esperado: ' + r.portoes.mecanismo] : []),
    `Amostra: ${r.casos} casos, ${r.repeticoes} repetições por caso (mínimo), ${r.pares} pares; bootstrap por casos com semente ${r.semente} e ${r.reamostras} reamostras`,
    'Variantes:', arm('base', r.base), arm('candidata', r.candidata),
    `Custo: economia média por caso ${fmtNum(r.custo.economiaMediaPorCaso)} (IC ${nivel}% ${fmtNum(r.custo.intervalo[0])} a ${fmtNum(r.custo.intervalo[1])}); relativa ${fmtPct(r.custo.economiaRelativa)} (IC ${nivel}% ${fmtPct(r.custo.intervaloRelativo[0])} a ${fmtPct(r.custo.intervaloRelativo[1])})`,
    `Qualidade: só a base acertou b=${r.qualidade.b}, só a candidata c=${r.qualidade.c}; McNemar exato bilateral p=${fmtP(r.qualidade.pValor)}; perda observada ${fmtPct(r.qualidade.perdaObservada)}, limite superior ${fmtPct(r.qualidade.limiteSuperiorPerda)}; pares mínimos para a margem ${r.qualidade.paresMinimos}`,
    ...(r.naoMedido.length ? ['Não medido (' + r.naoMedido.length + '):', ...r.naoMedido.slice(0, 20).map(m => '  - ' + m), ...(r.naoMedido.length > 20 ? ['  - ... mais ' + (r.naoMedido.length - 20)] : [])] : []),
    'VEREDITO: ' + r.veredito,
    ...r.motivos.map(m => '  - ' + m),
    ...(r.casosNecessarios !== null ? [`Casos para poder de 80% (cálculo simples, com ${Math.max(r.repeticoes, r.portoes.repeticoesMinimas)} repetições): ${r.casosNecessarios}; faltam ${r.casosFaltando}`] : []),
  ];
  return lines.join('\n');
}
