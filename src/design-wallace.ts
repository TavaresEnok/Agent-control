import {designRawFinding, type DesignRawFinding} from './design-types.ts';

export const WALLACE_FONT_SIZES_MAX = 8; // > 8, como os tokens
export const WALLACE_FONT_FAMILIES_MAX = 3; // > 3, como os tokens
export const WALLACE_COLORS_MAX = 16; // cores únicas > 16
export const WALLACE_SPECIFICITY_MAX = [0, 3, 0] as const; // acima de [0,3,0]; igual não gera
export const WALLACE_SELECTORS_MEAN_MAX = 3; // média de seletores por regra > 3
export const WALLACE_DUPLICATE_DECLARATIONS_MAX = 0; // total - totalUnique > 0
export const WALLACE_ZINDEX_MAX = 4; // z-index distintos > 4
export const WALLACE_UNITS_MAX = 1; // unidades distintas > 1
export const WALLACE_IMPORTANT_MAX = 0; // !important > 0

const TOOL = 'css-analyzer';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegative(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function at(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function count(root: unknown, path: readonly string[]): number | null {
  return nonNegative(at(root, path));
}

type Specificity = readonly [number, number, number];

function specificity(value: unknown): Specificity | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const a = nonNegative(value[0]);
  const b = nonNegative(value[1]);
  const c = nonNegative(value[2]);
  if (a === null || b === null || c === null) return null;
  return [a, b, c];
}

/** Primeiro componente (a, depois b, depois c) estritamente acima do limite. */
function overflowComponent(max: Specificity): number | null {
  const [limitA, limitB, limitC] = WALLACE_SPECIFICITY_MAX;
  if (max[0] !== limitA) return max[0] > limitA ? max[0] : null;
  if (max[1] !== limitB) return max[1] > limitB ? max[1] : null;
  return max[2] > limitC ? max[2] : null;
}

function add(
  findings: DesignRawFinding[],
  file: string,
  rule: string,
  metric: string,
  value: number,
  snippet: string,
): void {
  findings.push(designRawFinding({
    tool: TOOL,
    rule,
    file,
    severity: 'media',
    snippet,
    measure: {kind: 'wallace', metric, value},
  }));
}

/** Limites estourados do css-analyzer. A folha em si não é achado. Relatório inválido devolve []. */
export function wallaceFindings(file: string, report: unknown): DesignRawFinding[] {
  if (!isRecord(report)) return [];
  const findings: DesignRawFinding[] = [];

  const fontSizes = count(report, ['values', 'fontSizes', 'totalUnique']);
  if (fontSizes !== null && fontSizes > WALLACE_FONT_SIZES_MAX) {
    add(findings, file, 'DESIGN-WALLACE-FONTES', 'fontes', fontSizes, `${fontSizes} tamanhos de fonte`);
  }
  const families = count(report, ['values', 'fontFamilies', 'totalUnique']);
  if (families !== null && families > WALLACE_FONT_FAMILIES_MAX) {
    add(findings, file, 'DESIGN-WALLACE-FAMILIAS', 'familias', families, `${families} famílias`);
  }
  const colors = count(report, ['values', 'colors', 'totalUnique']);
  if (colors !== null && colors > WALLACE_COLORS_MAX) {
    add(findings, file, 'DESIGN-WALLACE-CORES', 'cores', colors, `${colors} cores`);
  }

  const max = specificity(at(report, ['selectors', 'specificity', 'max']));
  if (max !== null) {
    const value = overflowComponent(max);
    if (value !== null) {
      add(findings, file, 'DESIGN-WALLACE-ESPECIFICIDADE', 'especificidade', value, `max ${max[0]},${max[1]},${max[2]}`);
    }
  }

  const selectors = count(report, ['rules', 'selectors', 'mean']);
  if (selectors !== null && selectors > WALLACE_SELECTORS_MEAN_MAX) {
    add(findings, file, 'DESIGN-WALLACE-SELETORES', 'seletores', selectors, `${selectors} seletores por regra`);
  }

  const total = count(report, ['declarations', 'total']);
  const unique = count(report, ['declarations', 'totalUnique']);
  if (total !== null && unique !== null) {
    const duplicates = total - unique;
    if (duplicates > WALLACE_DUPLICATE_DECLARATIONS_MAX) {
      add(findings, file, 'DESIGN-WALLACE-DUPLICADAS', 'duplicadas', duplicates, `${duplicates} declarações duplicadas`);
    }
  }

  const zIndex = count(report, ['values', 'zindexes', 'totalUnique']);
  if (zIndex !== null && zIndex > WALLACE_ZINDEX_MAX) {
    add(findings, file, 'DESIGN-WALLACE-ZINDEX', 'zindex', zIndex, `${zIndex} z-index`);
  }
  const units = count(report, ['values', 'units', 'totalUnique']);
  if (units !== null && units > WALLACE_UNITS_MAX) {
    add(findings, file, 'DESIGN-WALLACE-UNIDADES', 'unidades', units, `${units} unidades`);
  }
  const importants = count(report, ['declarations', 'importants', 'total']);
  if (importants !== null && importants > WALLACE_IMPORTANT_MAX) {
    add(findings, file, 'DESIGN-WALLACE-IMPORTANT', 'important', importants, `${importants} !important`);
  }

  return findings;
}

const COMPUTED_FILE = /^computado (\S+) (.+)$/;
const MAX_LOCATIONS = 60;

/**
 * A mesma regra do css-analyzer medida na mesma rota em várias capturas (largura, tema, estado) é um ponto só.
 * Vira um achado com o maior valor, a contagem e a lista de capturas. Rota medida uma vez não muda.
 */
export function groupWallaceFindings(findings: readonly DesignRawFinding[]): DesignRawFinding[] {
  const groups = new Map<string, {first: number; items: {finding: DesignRawFinding; rest: string}[]; route: string}>();
  const out: (DesignRawFinding | string)[] = [];
  for (const finding of findings) {
    const parts = finding.measure?.kind === 'wallace' ? COMPUTED_FILE.exec(finding.file) : null;
    if (!parts || !finding.measure || finding.measure.kind !== 'wallace') {
      out.push(finding);
      continue;
    }
    const key = [finding.tool, finding.rule, finding.measure.metric, parts[1]].join('\u001f');
    const group = groups.get(key);
    if (group) {
      group.items.push({finding, rest: parts[2] ?? ''});
    } else {
      groups.set(key, {first: out.length, items: [{finding, rest: parts[2] ?? ''}], route: parts[1] ?? ''});
      out.push(key);
    }
  }
  return out.map(entry => {
    if (typeof entry !== 'string') return entry;
    const group = groups.get(entry);
    if (!group) throw new Error('grupo do css-analyzer ausente');
    const [only] = group.items;
    if (group.items.length === 1 && only) return only.finding;
    let top = group.items[0]!;
    for (const item of group.items) {
      const value = item.finding.measure?.kind === 'wallace' ? item.finding.measure.value : 0;
      const best = top.finding.measure?.kind === 'wallace' ? top.finding.measure.value : 0;
      if (value > best) top = item;
    }
    const measure = top.finding.measure;
    if (measure?.kind !== 'wallace') throw new Error('medida do css-analyzer ausente');
    const grouped = designRawFinding({
      tool: top.finding.tool,
      rule: top.finding.rule,
      file: `computado ${group.route}`,
      severity: top.finding.severity,
      snippet: top.finding.snippet,
      measure,
    });
    const locations = group.items.slice(0, MAX_LOCATIONS).map(item => {
      const value = item.finding.measure?.kind === 'wallace' ? item.finding.measure.value : 0;
      return `${item.rest}: ${value}`.slice(0, 160);
    });
    return {...grouped, occurrences: {count: group.items.length, locations}};
  });
}
