import {Refusal} from './contracts.ts';
import {deltaE2000, parseCssColor, type Rgb} from './design-color.ts';
import {colorsIn, cssDeclarations} from './design-inventory.ts';
import {DESIGN_TOKENS_MAX_BYTES} from './design-project-config.ts';
import {designRawFinding, type DesignRawFinding} from './design-types.ts';

/**
 * Compara os estilos medidos com os tokens que o próprio projeto declara.
 * Tudo aqui é puro: o host lê o arquivo e passa o texto.
 */
export type BrandCategory = 'cor' | 'tamanho' | 'raio' | 'espaco' | 'familia';

export type DeclaredTokens = {
  source: string;
  colors: {name: string; rgb: Rgb}[];
  sizes: number[];
  radii: number[];
  spaces: number[];
  /** Dimensão sem nome de categoria. Vale para tamanho, raio e espaço que o arquivo não separa. */
  dimensions: number[];
  families: string[];
  notes: string[];
};

/** Bloco de amostras como a imagem entrega. Tipado pela forma, sem depender da imagem. */
export type BrandSampleBlock = {
  route: string;
  viewport?: number | string;
  theme?: string;
  state?: string;
  samples: readonly {
    color?: string;
    backgroundColor?: string;
    borderColor?: string;
    fontFamily?: string;
    fontSize?: string;
    margin?: string;
    padding?: string;
    gap?: string;
    borderRadius?: string;
  }[];
};

export type BrandRouteOff = {route: string; category: BrandCategory; values: string[]};

export type BrandComparison = {
  source: string;
  categories: BrandCategory[];
  routes: string[];
  off: BrandRouteOff[];
  notes: string[];
};

export const BRAND_RULE = 'DESIGN-TOKENS-FORA-DO-DECLARADO';
export const BRAND_TOOL = 'tokens-projeto';
const COLOR_DELTA = 3;
const STEP_PX = 0.5;
const REM_PX = 16;
const MAX_SNIPPET_VALUES = 5;
const MAX_TOKENS = 2000;
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace',
  'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont', 'inherit', 'initial',
]);
const CATEGORY_LABEL: Record<BrandCategory, string> = {
  cor: 'cores',
  tamanho: 'tamanhos de texto',
  raio: 'raios',
  espaco: 'espaçamentos',
  familia: 'famílias',
};
const ALIAS = /^\{([^{}]+)\}$/;
const CSS_ALIAS = /^var\(\s*(--[\w-]+)\s*\)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyTokens(source: string, notes: string[] = []): DeclaredTokens {
  return {source, colors: [], sizes: [], radii: [], spaces: [], dimensions: [], families: [], notes};
}

/** px ou rem (16px). Outro valor fica de fora. */
function dimensionPx(value: unknown): number | null {
  if (isRecord(value) && typeof value.value === 'number' && (value.unit === 'px' || value.unit === 'rem')) {
    return value.unit === 'rem' ? value.value * REM_PX : value.value;
  }
  if (typeof value !== 'string') return null;
  const match = /^(-?\d*\.?\d+)(px|rem)$/i.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  return match[2]?.toLowerCase() === 'rem' ? number * REM_PX : number;
}

/** Cor única: hex, rgb(), hsl() ou nome, ou o objeto sRGB do DTCG. */
function declaredColor(value: unknown): Rgb | null {
  if (isRecord(value)) {
    if (typeof value.hex === 'string') return declaredColor(value.hex);
    const components = value.components;
    if (value.colorSpace === 'srgb' && Array.isArray(components) && components.length === 3 && components.every(item => typeof item === 'number')) {
      const [r, g, b] = components as number[];
      return {r: (r ?? 0) * 255, g: (g ?? 0) * 255, b: (b ?? 0) * 255, a: typeof value.alpha === 'number' ? value.alpha : 1};
    }
    return null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/[\s,]/.test(trimmed) && !/^(?:rgba?|hsla?)\(/i.test(trimmed)) return null;
  const found = colorsIn(trimmed);
  return found.length === 1 ? (found[0] ?? null) : null;
}

function familyList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return items
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim().replace(/^["']|["']$/g, '').toLowerCase())
    .filter(item => item.length > 0 && item.length <= 80);
}

function dimensionCategory(name: string): 'tamanho' | 'raio' | 'espaco' | null {
  const lower = name.toLowerCase();
  if (/radius|radii|raio|rounded|corner/.test(lower)) return 'raio';
  if (/space|spacing|gap|espa[cç]o|margin|padding|inset/.test(lower)) return 'espaco';
  if (/font|text|type|tipo|tamanho|size|heading|body/.test(lower)) return 'tamanho';
  return null;
}

function pushDimension(tokens: DeclaredTokens, name: string, px: number): void {
  const category = dimensionCategory(name);
  if (category === 'raio') tokens.radii.push(px);
  else if (category === 'espaco') tokens.spaces.push(px);
  else if (category === 'tamanho') tokens.sizes.push(px);
  else tokens.dimensions.push(px);
}

type RawToken = {name: string; type: string | undefined; value: unknown};

/** Percorre o DTCG. O $type do grupo vale para os filhos. */
function walkDtcg(node: unknown, path: string[], inherited: string | undefined, out: Map<string, RawToken>): void {
  if (!isRecord(node) || out.size >= MAX_TOKENS) return;
  const type = typeof node.$type === 'string' ? node.$type : inherited;
  if (Object.hasOwn(node, '$value')) {
    out.set(path.join('.'), {name: path.join('.'), type, value: node.$value});
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('$')) continue;
    walkDtcg(child, [...path, key], type, out);
  }
}

/**
 * Um nível de alias. Alias para alias não é seguido; se volta ao começo, é ciclo e fica recusado.
 */
function resolveAlias(
  raw: RawToken,
  lookup: (key: string) => RawToken | undefined,
  aliasOf: (value: unknown) => string | null,
  notes: string[],
): RawToken | null {
  const target = aliasOf(raw.value);
  if (target === null) return raw;
  const first = lookup(target);
  if (first === undefined) {
    notes.push(`Alias ${raw.name} aponta para ${target}, que não existe.`);
    return null;
  }
  const second = aliasOf(first.value);
  if (second === null) return {name: raw.name, type: raw.type ?? first.type, value: first.value};
  const seen = new Set([raw.name, first.name]);
  let cursor: string | null = second;
  for (let step = 0; cursor !== null && step < 50; step += 1) {
    if (seen.has(cursor)) {
      notes.push(`Ciclo de alias recusado em ${raw.name}.`);
      return null;
    }
    seen.add(cursor);
    const next = lookup(cursor);
    cursor = next === undefined ? null : aliasOf(next.value);
  }
  notes.push(`Alias ${raw.name} tem mais de um nível e não foi seguido.`);
  return null;
}

function ingest(tokens: DeclaredTokens, token: RawToken): void {
  const type = token.type?.toLowerCase();
  const name = token.name;
  if (type === 'color' || (type === undefined && declaredColor(token.value) !== null)) {
    const rgb = declaredColor(token.value);
    if (rgb !== null) tokens.colors.push({name, rgb});
    return;
  }
  if (type === 'dimension' || (type === undefined && dimensionPx(token.value) !== null)) {
    const px = dimensionPx(token.value);
    if (px !== null && px >= 0) pushDimension(tokens, name, px);
    return;
  }
  if (type === 'fontfamily' || (type === undefined && /font-?family|familia|família/i.test(name))) {
    tokens.families.push(...familyList(token.value));
  }
}

function parseDtcg(source: string, text: string): DeclaredTokens {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return emptyTokens(source, [`O arquivo de tokens ${source} não é JSON válido. A comparação não rodou.`]);
  }
  if (!isRecord(parsed)) return emptyTokens(source, [`O arquivo de tokens ${source} não tem grupos DTCG. A comparação não rodou.`]);
  const raw = new Map<string, RawToken>();
  walkDtcg(parsed, [], undefined, raw);
  const tokens = emptyTokens(source);
  const aliasOf = (value: unknown) => (typeof value === 'string' ? ALIAS.exec(value.trim())?.[1] ?? null : null);
  for (const token of raw.values()) {
    const resolved = resolveAlias(token, key => raw.get(key), aliasOf, tokens.notes);
    if (resolved !== null) ingest(tokens, resolved);
  }
  return tokens;
}

/** --font-sans e --font-family-body são família; --font-size e --font-weight não. */
function isCssFamilyToken(name: string, value: unknown): boolean {
  if (!/font|famil/i.test(name) || /size|weight|leading|line|tracking|spacing|letter/i.test(name)) return false;
  if (typeof value !== 'string' || dimensionPx(value) !== null || /^-?[\d.]+$/.test(value.trim())) return false;
  return true;
}

function parseCssTokens(source: string, text: string): DeclaredTokens {
  const raw = new Map<string, RawToken>();
  for (const decl of cssDeclarations(text)) {
    if (!decl.prop.startsWith('--') || raw.size >= MAX_TOKENS) continue;
    raw.set(decl.prop, {name: decl.prop, type: undefined, value: decl.value.replace(/!important/gi, '').trim()});
  }
  const tokens = emptyTokens(source);
  const aliasOf = (value: unknown) => (typeof value === 'string' ? CSS_ALIAS.exec(value.trim())?.[1] ?? null : null);
  for (const token of raw.values()) {
    const resolved = resolveAlias(token, key => raw.get(key), aliasOf, tokens.notes);
    if (resolved === null) continue;
    if (isCssFamilyToken(token.name, resolved.value)) {
      tokens.families.push(...familyList(resolved.value));
      continue;
    }
    ingest(tokens, {...resolved, name: token.name});
  }
  return tokens;
}

/** Lê DTCG (.json) ou propriedades CSS (.css). Arquivo grande demais é recusado. */
export function parseDeclaredTokens(path: string, text: string): DeclaredTokens {
  if (Buffer.byteLength(text, 'utf8') > DESIGN_TOKENS_MAX_BYTES) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
  const tokens = /\.css$/i.test(path) ? parseCssTokens(path, text) : parseDtcg(path, text);
  tokens.families = [...new Set(tokens.families)].filter(item => !GENERIC_FAMILIES.has(item));
  return tokens;
}

export function declaredCategories(tokens: DeclaredTokens): BrandCategory[] {
  const out: BrandCategory[] = [];
  if (tokens.colors.length > 0) out.push('cor');
  if (tokens.sizes.length > 0 || tokens.dimensions.length > 0) out.push('tamanho');
  if (tokens.radii.length > 0 || tokens.dimensions.length > 0) out.push('raio');
  if (tokens.spaces.length > 0 || tokens.dimensions.length > 0) out.push('espaco');
  if (tokens.families.length > 0) out.push('familia');
  return out;
}

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

function hexOf(rgb: Rgb): string {
  const part = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function offSteps(values: readonly number[], steps: readonly number[]): number[] {
  const off = values.filter(value => !steps.some(step => Math.abs(step - value) <= STEP_PX));
  return [...new Set(off.map(round))].sort((a, b) => a - b);
}

/** Por rota: cor a mais de ΔE2000 3, passo a mais de 0,5px e família não declarada. */
export function compareWithDeclared(blocks: readonly BrandSampleBlock[], declared: DeclaredTokens): BrandComparison {
  const categories = declaredCategories(declared);
  const byRoute = new Map<string, BrandSampleBlock['samples'][number][]>();
  for (const block of blocks) {
    if (typeof block.route !== 'string' || block.route.length === 0) continue;
    const list = byRoute.get(block.route) ?? [];
    list.push(...block.samples);
    byRoute.set(block.route, list);
  }
  const off: BrandRouteOff[] = [];
  const sizeSteps = declared.sizes.length > 0 ? declared.sizes : declared.dimensions;
  const radiusSteps = declared.radii.length > 0 ? declared.radii : declared.dimensions;
  const spaceSteps = declared.spaces.length > 0 ? declared.spaces : declared.dimensions;
  const families = new Set(declared.families);
  for (const [route, samples] of byRoute) {
    const colors = new Map<string, Rgb>();
    const sizes: number[] = [];
    const radii: number[] = [];
    const spaces: number[] = [];
    const usedFamilies = new Set<string>();
    for (const sample of samples) {
      for (const value of [sample.color, sample.backgroundColor, sample.borderColor]) {
        if (value === undefined || /^currentcolor$/i.test(value.trim())) continue;
        const rgb = parseCssColor(value);
        if (rgb === null || (rgb.a ?? 1) < 0.999) continue;
        colors.set(hexOf(rgb), rgb);
      }
      const size = pxOf(sample.fontSize);
      if (size !== null && size > 0) sizes.push(size);
      radii.push(...positivePx(sample.borderRadius));
      spaces.push(...positivePx(sample.margin), ...positivePx(sample.padding), ...positivePx(sample.gap));
      const first = familyList(sample.fontFamily)[0];
      if (first !== undefined && !GENERIC_FAMILIES.has(first)) usedFamilies.add(first);
    }
    if (categories.includes('cor')) {
      const values = [...colors].filter(([, rgb]) => !declared.colors.some(token => deltaE2000(token.rgb, rgb) <= COLOR_DELTA)).map(([hex]) => hex).sort();
      if (values.length > 0) off.push({route, category: 'cor', values});
    }
    const dims: [BrandCategory, number[], number[]][] = [['tamanho', sizes, sizeSteps], ['raio', radii, radiusSteps], ['espaco', spaces, spaceSteps]];
    for (const [category, values, steps] of dims) {
      if (!categories.includes(category)) continue;
      const outside = offSteps(values, steps);
      if (outside.length > 0) off.push({route, category, values: outside.map(value => `${value}px`)});
    }
    if (categories.includes('familia')) {
      const values = [...usedFamilies].filter(item => !families.has(item)).sort();
      if (values.length > 0) off.push({route, category: 'familia', values});
    }
  }
  return {source: declared.source, categories, routes: [...byRoute.keys()], off, notes: [...declared.notes]};
}

/** Um achado por rota e categoria. Sem medida: só entra no relatório se o examinador confirmar. */
export function brandFindings(off: readonly BrandRouteOff[], source: string): DesignRawFinding[] {
  return off.map(item => {
    const shown = item.values.slice(0, MAX_SNIPPET_VALUES).join(', ');
    const more = item.values.length > MAX_SNIPPET_VALUES ? ` e mais ${item.values.length - MAX_SNIPPET_VALUES}` : '';
    return designRawFinding({
      tool: BRAND_TOOL,
      rule: BRAND_RULE,
      file: item.route,
      severity: 'media',
      snippet: `${CATEGORY_LABEL[item.category]} fora de ${source}: ${shown}${more}`,
    });
  });
}

function cell(text: string): string {
  return text.replace(/[|`<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Corpo da seção 'Tokens do projeto', sem o título. */
export function brandMarkdown(result: BrandComparison): string {
  const lines: string[] = [`Fonte: \`${cell(result.source)}\`.`];
  if (result.categories.length === 0) {
    lines.push('O arquivo não declara cor, dimensão nem família. Nada foi comparado.');
  } else {
    lines.push(`Comparado: ${result.categories.map(item => CATEGORY_LABEL[item]).join(', ')}. O que o arquivo não declara não foi julgado.`);
    if (result.off.length === 0) lines.push('Todas as rotas usam só valores declarados.');
    for (const item of result.off) {
      const shown = item.values.slice(0, MAX_SNIPPET_VALUES).map(cell).join(', ');
      const more = item.values.length > MAX_SNIPPET_VALUES ? ` e mais ${item.values.length - MAX_SNIPPET_VALUES}` : '';
      lines.push(`- ${cell(item.route)}: ${CATEGORY_LABEL[item.category]} fora do declarado: ${shown}${more}.`);
    }
  }
  for (const note of result.notes) lines.push(`- ${cell(note)}`);
  return lines.join('\n');
}
