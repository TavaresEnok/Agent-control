import {designRawFinding, type DesignOccurrences, type DesignRawFinding} from './design-types.ts';

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
const MAX_ROUTES = 200;

type Capture = {finding: DesignRawFinding; rest: string; value: number};
type RouteGroup = {tool: string; rule: string; metric: string; route: string; captures: Capture[]; top: Capture};

function wallaceValue(finding: DesignRawFinding): number {
  return finding.measure?.kind === 'wallace' ? finding.measure.value : 0;
}

function groupedFinding(top: DesignRawFinding, file: string, occurrences: DesignOccurrences): DesignRawFinding {
  const measure = top.measure;
  if (measure?.kind !== 'wallace') throw new Error('medida do css-analyzer ausente');
  const grouped = designRawFinding({tool: top.tool, rule: top.rule, file, severity: top.severity, snippet: top.snippet, measure});
  return {...grouped, occurrences};
}

/**
 * Dois passos sobre as medidas do css-analyzer feitas em capturas (`computado <rota> <largura> <tema> <estado>`):
 * 1. a mesma regra na mesma rota, em várias larguras, temas e estados, é um ponto só, com o maior valor;
 * 2. a mesma regra com o mesmo valor em rotas diferentes (a folha global medida em cada rota) é um achado só,
 *    com a lista das rotas.
 * Cada achado agrupado leva a contagem de capturas e os locais. O que foi medido uma vez não muda.
 */
export function groupWallaceFindings(findings: readonly DesignRawFinding[]): DesignRawFinding[] {
  const byRoute = new Map<string, RouteGroup>();
  const slots: (DesignRawFinding | RouteGroup)[] = [];
  for (const finding of findings) {
    const parts = finding.measure?.kind === 'wallace' ? COMPUTED_FILE.exec(finding.file) : null;
    if (!parts) {
      slots.push(finding);
      continue;
    }
    const metric = finding.measure?.kind === 'wallace' ? finding.measure.metric : '';
    const capture: Capture = {finding, rest: parts[2] ?? '', value: wallaceValue(finding)};
    const key = [finding.tool, finding.rule, metric, parts[1]].join('\u001f');
    const group = byRoute.get(key);
    if (group) {
      group.captures.push(capture);
      if (capture.value > group.top.value) group.top = capture;
    } else {
      const created: RouteGroup = {tool: finding.tool, rule: finding.rule, metric, route: parts[1] ?? '', captures: [capture], top: capture};
      byRoute.set(key, created);
      slots.push(created);
    }
  }
  const byValue = new Map<string, RouteGroup[]>();
  const merged: (DesignRawFinding | RouteGroup[])[] = [];
  for (const slot of slots) {
    if (!('captures' in slot)) {
      merged.push(slot);
      continue;
    }
    const key = [slot.tool, slot.rule, slot.metric, slot.top.value].join('\u001f');
    const same = byValue.get(key);
    if (same) {
      same.push(slot);
    } else {
      const created = [slot];
      byValue.set(key, created);
      merged.push(created);
    }
  }
  return merged.map(entry => {
    if (!Array.isArray(entry)) return entry;
    const [first] = entry;
    if (!first) throw new Error('grupo do css-analyzer vazio');
    if (entry.length === 1) {
      if (first.captures.length === 1) return first.top.finding;
      const locations = first.captures.slice(0, MAX_LOCATIONS).map(item => `${item.rest}: ${item.value}`.slice(0, 160));
      return groupedFinding(first.top.finding, `computado ${first.route}`, {count: first.captures.length, locations});
    }
    const routes = entry.map(group => group.route);
    const locations = entry.slice(0, MAX_LOCATIONS).map(group => `${group.route} (${group.captures.length} capturas): ${group.top.value}`.slice(0, 160));
    const count = entry.reduce((sum, group) => sum + group.captures.length, 0);
    return groupedFinding(first.top.finding, `computado ${first.route} e mais ${entry.length - 1} rotas`, {count, locations, routes: routes.slice(0, MAX_ROUTES)});
  });
}

/** Arquivos `computado <rota>` que um achado do css-analyzer cobre. O delta compara por rota, antes e depois do agrupamento. */
export function wallaceDeltaFiles(finding: Pick<DesignRawFinding, 'file' | 'occurrences'>): string[] {
  if (!finding.file.startsWith('computado ')) return [finding.file];
  const routes = finding.occurrences?.routes;
  if (routes && routes.length > 0) return routes.map(route => `computado ${route}`);
  const route = finding.file.split(' ')[1];
  return [route ? `computado ${route}` : finding.file];
}
