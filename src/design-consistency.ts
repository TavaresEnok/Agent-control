import {deltaE2000, parseCssColor, type Rgb} from './design-color.ts';
import {designRawFinding, type DesignRawFinding} from './design-types.ts';

/**
 * Consistência entre telas: valor que só uma rota usa e títulos fora de ordem.
 * A entrada é estrutural, como os blocos de amostras da imagem.
 */
export type ConsistencyBlock = {
  route: string;
  viewport?: number | string;
  theme?: string;
  state?: string;
  samples: readonly {
    selector?: string;
    color?: string;
    backgroundColor?: string;
    borderColor?: string;
    fontSize?: string;
    margin?: string;
    padding?: string;
    gap?: string;
    borderRadius?: string;
  }[];
};

export type ConsistencyCategory = 'cor' | 'tamanho' | 'raio' | 'espaco';

export type IsolatedRoute = {
  /** Chave da rota. O tema escuro fica em `rota#escuro`. */
  key: string;
  route: string;
  dark: boolean;
  values: {category: ConsistencyCategory; value: string; count: number}[];
};

export type HeadingIssue = {route: string; viewport: string; theme: string; state: string; h1?: number; h2?: number; h3?: number; text: string};

export type ConsistencyResult = {
  routes: string[];
  compared: ConsistencyCategory[];
  isolated: IsolatedRoute[];
  headings: HeadingIssue[];
  notes: string[];
};

export const CONSISTENCY_TOOL = 'consistencia';
export const CONSISTENCY_ISOLATED_RULE = 'DESIGN-CONSISTENCIA-VALOR-ISOLADO';
export const HEADING_SCALE_RULE = 'DESIGN-TITULOS-ESCALA';
const MIN_ROUTES = 2;
const MIN_USES = 2;
const COMMON_SHARE = 0.8;
const MIN_COMMON_VALUES = 3;
const COLOR_DELTA = 2;
const MAX_VALUES = 15;
const HEADING_SLACK = 0.5;
const CATEGORY_LABEL: Record<ConsistencyCategory, string> = {cor: 'cor', tamanho: 'tamanho', raio: 'raio', espaco: 'espaço'};
const DARK_SUFFIX = '#escuro';

function pxOf(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(-?[\d.]+)px$/.exec(value.trim());
  const number = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function positivePx(value: string | undefined): number[] {
  if (!value || value === 'normal' || value === 'none') return [];
  return [...value.matchAll(/(-?[\d.]+)px/g)].map(match => Number(match[1])).filter(number => Number.isFinite(number) && number > 0);
}

function pxLabel(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

function hexOf(rgb: Rgb): string {
  const part = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

function isDark(theme: string | undefined): boolean {
  return theme === 'escuro' || theme === 'dark';
}

/** Cores a menos de ΔE2000 2 viram a mesma, pela primeira vista. */
class ColorClusters {
  private readonly heads: {hex: string; rgb: Rgb}[] = [];

  key(rgb: Rgb): string {
    const found = this.heads.find(head => deltaE2000(head.rgb, rgb) < COLOR_DELTA);
    if (found) return found.hex;
    const hex = hexOf(rgb);
    this.heads.push({hex, rgb});
    return hex;
  }
}

type Uses = Record<ConsistencyCategory, Map<string, number>>;

function emptyUses(): Uses {
  return {cor: new Map(), tamanho: new Map(), raio: new Map(), espaco: new Map()};
}

function add(map: Map<string, number>, value: string): void {
  map.set(value, (map.get(value) ?? 0) + 1);
}

function usesOf(samples: ConsistencyBlock['samples'], colors: ColorClusters, into: Uses): void {
  for (const sample of samples) {
    for (const value of [sample.color, sample.backgroundColor, sample.borderColor]) {
      if (value === undefined || /^currentcolor$/i.test(value.trim())) continue;
      const rgb = parseCssColor(value);
      if (rgb === null || (rgb.a ?? 1) < 0.999) continue;
      add(into.cor, colors.key(rgb));
    }
    const size = pxOf(sample.fontSize);
    if (size !== null && size > 0) add(into.tamanho, pxLabel(size));
    for (const radius of positivePx(sample.borderRadius)) add(into.raio, pxLabel(radius));
    for (const space of [...positivePx(sample.margin), ...positivePx(sample.padding), ...positivePx(sample.gap)]) add(into.espaco, pxLabel(space));
  }
}

function headingIssues(blocks: readonly ConsistencyBlock[]): HeadingIssue[] {
  const issues: HeadingIssue[] = [];
  const flagged = new Set<string>();
  for (const block of blocks) {
    if (flagged.has(block.route)) continue;
    const top: Partial<Record<'h1' | 'h2' | 'h3', number>> = {};
    for (const sample of block.samples) {
      const tag = sample.selector;
      if (tag !== 'h1' && tag !== 'h2' && tag !== 'h3') continue;
      const size = pxOf(sample.fontSize);
      if (size === null || size <= 0) continue;
      top[tag] = Math.max(top[tag] ?? 0, size);
    }
    const {h1, h2, h3} = top;
    let text = '';
    if (h1 !== undefined && h2 !== undefined && h2 > h1 + HEADING_SLACK) text = `h2 de ${pxLabel(h2)} maior que h1 de ${pxLabel(h1)}`;
    else if (h2 !== undefined && h3 !== undefined && h3 > h2 + HEADING_SLACK) text = `h3 de ${pxLabel(h3)} maior que h2 de ${pxLabel(h2)}`;
    if (text.length === 0) continue;
    flagged.add(block.route);
    issues.push({
      route: block.route,
      viewport: String(block.viewport ?? ''),
      theme: block.theme ?? '',
      state: block.state ?? '',
      ...(h1 === undefined ? {} : {h1}),
      ...(h2 === undefined ? {} : {h2}),
      ...(h3 === undefined ? {} : {h3}),
      text,
    });
  }
  return issues;
}

/**
 * Valor isolado: usado 2 vezes ou mais numa só rota, numa categoria que tem
 * pelo menos 3 valores presentes em 80% das rotas. Precisa de 2 rotas ou mais.
 */
export function analyzeConsistency(blocks: readonly ConsistencyBlock[]): ConsistencyResult {
  const valid = blocks.filter(block => typeof block.route === 'string' && block.route.length > 0 && Array.isArray(block.samples));
  const colors = new ColorClusters();
  const byKey = new Map<string, {route: string; dark: boolean; uses: Uses}>();
  for (const block of valid) {
    const dark = isDark(block.theme);
    const key = dark ? `${block.route}${DARK_SUFFIX}` : block.route;
    const entry = byKey.get(key) ?? {route: block.route, dark, uses: emptyUses()};
    usesOf(block.samples, colors, entry.uses);
    byKey.set(key, entry);
  }
  const headings = headingIssues(valid);
  const keys = [...byKey.keys()];
  const result: ConsistencyResult = {routes: keys, compared: [], isolated: [], headings, notes: []};
  // Claro com claro e escuro com escuro: a cor do tema escuro não vira isolada na rota clara.
  for (const dark of [false, true]) {
    const group = new Map([...byKey].filter(([, entry]) => entry.dark === dark));
    if (group.size === 0) continue;
    if (group.size < MIN_ROUTES) {
      if (!dark) result.notes.push('Valores isolados não comparados: há menos de 2 rotas.');
      continue;
    }
    isolatedIn(group, result);
  }
  return result;
}

function isolatedIn(group: ReadonlyMap<string, {route: string; dark: boolean; uses: Uses}>, result: ConsistencyResult): void {
  const keys = [...group.keys()];
  const isolatedByKey = new Map<string, IsolatedRoute['values']>();
  let compared = 0;
  for (const category of ['cor', 'tamanho', 'raio', 'espaco'] as const) {
    const presence = new Map<string, Set<string>>();
    for (const [key, entry] of group) {
      for (const value of entry.uses[category].keys()) {
        const set = presence.get(value) ?? new Set<string>();
        set.add(key);
        presence.set(value, set);
      }
    }
    const common = [...presence.values()].filter(set => set.size / keys.length >= COMMON_SHARE).length;
    if (common < MIN_COMMON_VALUES) continue;
    compared += 1;
    if (!result.compared.includes(category)) result.compared.push(category);
    for (const [value, set] of presence) {
      if (set.size !== 1 || isolatedTotal(result) + countValues(isolatedByKey) >= MAX_VALUES) continue;
      const key = [...set][0] ?? '';
      const count = group.get(key)?.uses[category].get(value) ?? 0;
      if (count < MIN_USES) continue;
      const list = isolatedByKey.get(key) ?? [];
      list.push({category, value, count});
      isolatedByKey.set(key, list);
    }
  }
  for (const key of keys) {
    const values = isolatedByKey.get(key);
    const entry = group.get(key);
    if (values === undefined || entry === undefined) continue;
    result.isolated.push({key, route: entry.route, dark: entry.dark, values});
  }
  if (compared === 0) {
    const theme = [...group.values()][0]?.dark === true ? ' no tema escuro' : '';
    result.notes.push(`Nenhuma categoria tem 3 valores comuns às rotas${theme}. Valores isolados não comparados.`);
  }
}

function countValues(map: ReadonlyMap<string, readonly unknown[]>): number {
  let total = 0;
  for (const list of map.values()) total += list.length;
  return total;
}

function isolatedTotal(result: ConsistencyResult): number {
  return result.isolated.reduce((sum, item) => sum + item.values.length, 0);
}

function valueList(values: IsolatedRoute['values']): string {
  return values.map(item => `${CATEGORY_LABEL[item.category]} ${item.value} (${item.count}x)`).join(', ');
}

/** O arquivo é a rota. No tema escuro, `rota escuro`, para a atribuição achar a tela pela rota. */
export function consistencyFindings(result: ConsistencyResult): DesignRawFinding[] {
  const findings: DesignRawFinding[] = [];
  for (const item of result.isolated) {
    findings.push(designRawFinding({
      tool: CONSISTENCY_TOOL,
      rule: CONSISTENCY_ISOLATED_RULE,
      file: item.dark ? `${item.route} escuro` : item.route,
      severity: 'baixa',
      snippet: `só esta rota${item.dark ? ' no tema escuro' : ''} usa ${valueList(item.values)}`,
    }));
  }
  for (const item of result.headings) {
    findings.push(designRawFinding({
      tool: CONSISTENCY_TOOL,
      rule: HEADING_SCALE_RULE,
      file: item.route,
      severity: 'baixa',
      snippet: `${item.text} (${[item.viewport, item.theme, item.state].filter(part => part.length > 0).join(' ')})`,
    }));
  }
  return findings;
}

function cell(text: string): string {
  return text.replace(/[|`<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Corpo da seção 'Consistência entre telas', sem o título. */
export function consistencyMarkdown(result: ConsistencyResult): string {
  const lines: string[] = [`Rotas comparadas: ${result.routes.length}.`];
  if (result.compared.length > 0) lines.push(`Categorias com valores comuns: ${result.compared.map(item => CATEGORY_LABEL[item]).join(', ')}.`);
  if (result.isolated.length === 0 && result.compared.length > 0) lines.push('Nenhum valor isolado.');
  for (const item of result.isolated) {
    lines.push(`- ${cell(item.route)}${item.dark ? ' (escuro)' : ''}: ${cell(valueList(item.values))}.`);
  }
  if (result.headings.length === 0) lines.push('Títulos em ordem: h1, h2 e h3 não se invertem.');
  for (const item of result.headings) lines.push(`- ${cell(item.route)}: ${cell(item.text)}.`);
  for (const note of result.notes) lines.push(`- ${cell(note)}`);
  return lines.join('\n');
}
