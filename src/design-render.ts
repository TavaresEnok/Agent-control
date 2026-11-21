import {z} from 'zod';
import {designRawFinding, type DesignRawFinding, type DesignSeverity} from './design-types.ts';

/**
 * Régua da imagem: o que a página renderizada mostra em cada célula rota × largura × tema × estado.
 * O texto vem da página e não é confiável. Serve só de trecho no achado, nunca de instrução.
 */

const TOOL = 'régua';
const CELL_MAX = 400;
const NARROW_MAX = 375;
const ZOOM_MIN_PX = 16;
const MOTION_MIN_PX = 48;
const TEXT_FIELDS = new Set(['text', 'email', 'tel', 'url', 'search', 'password', 'number', 'select', 'textarea']);

export const DESIGN_RENDER_RULES = {
  overflow: 'DESIGN-TELA-ROLAGEM-HORIZONTAL',
  clipped: 'DESIGN-TEXTO-CORTADO-MEDIDO',
  image: 'DESIGN-IMAGEM-QUEBRADA',
  zoom: 'DESIGN-TELA-ZOOM-CAMPO',
  residue: 'DESIGN-TEXTO-SOBRA',
  chart: 'DESIGN-GRAFICO-SEM-ALTERNATIVA',
  state: 'DESIGN-CONTRASTE-ESTADO',
  motion: 'DESIGN-MOVIMENTO-REDUZIDO',
  title: 'DESIGN-TITULO-REPETIDO',
} as const;

/** Tira controle, marca de direção e espaço repetido; corta no tamanho. */
function clean(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const Snippet = (max: number) => z.string().max(4000).transform(value => clean(value, max));
const Px = z.number().finite().min(0).max(100_000);
const Size = z.number().finite().positive().max(100_000);
const Route = z.string().regex(/^\/\S{0,199}$/);

function listOf<T extends z.ZodTypeAny>(item: T, max: number) {
  return z.preprocess(
    value => Array.isArray(value) ? value.filter(entry => item.safeParse(entry).success).slice(0, max) : value,
    z.array(item).max(max),
  );
}

const Offender = z.object({sel: Snippet(120), right: Px}).strict();
const Overflow = z.object({px: Px, clip: z.boolean(), offenders: listOf(Offender, 3).default([])}).strict();
const Clipped = z.object({sel: Snippet(120), text40: Snippet(40), px: Size}).strict();
const BrokenImage = z.object({path: Snippet(120)}).strict();
const Field = z.object({sel: Snippet(120), type: z.string().regex(/^[a-z-]{1,20}$/), fontPx: z.number().finite().positive().max(200)}).strict();
export const DesignResidueKind = z.enum(['lorem', 'modelo', 'interpolacao', 'objeto', 'valor', 'codificacao']);
export type DesignResidueKind = z.infer<typeof DesignResidueKind>;
const Residue = z.object({kind: DesignResidueKind, text40: Snippet(40), sel: Snippet(120)}).strict();
const Chart = z.object({sel: Snippet(120), w: Size, h: Size}).strict();
const StateContrast = z.object({
  label40: Snippet(40),
  state: z.enum(['hover', 'foco']),
  ratio: z.number().finite().min(1).max(21),
  need: z.union([z.literal(3), z.literal(4.5)]),
}).strict();
const Running = z.object({sel: Snippet(120), w: Size, h: Size}).strict();
const Motion = z.object({running: listOf(Running, 5)}).strict();

const FIELDS = {
  overflow: Overflow,
  clipped: listOf(Clipped, 10),
  images: listOf(BrokenImage, 10),
  inputs: listOf(Field, 20),
  residue: listOf(Residue, 10),
  charts: listOf(Chart, 10),
  title: Snippet(120),
  states: listOf(StateContrast, 40),
  motion: Motion,
} as const;

export const DesignRenderCell = z.object({
  file: z.string().max(400).optional(),
  route: Route,
  viewport: z.union([z.literal(320), z.literal(375), z.literal(768), z.literal(1440)]),
  theme: z.enum(['claro', 'escuro']),
  state: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  overflow: FIELDS.overflow.optional(),
  clipped: FIELDS.clipped.optional(),
  images: FIELDS.images.optional(),
  inputs: FIELDS.inputs.optional(),
  residue: FIELDS.residue.optional(),
  charts: FIELDS.charts.optional(),
  title: FIELDS.title.optional(),
  states: FIELDS.states.optional(),
  motion: FIELDS.motion.optional(),
}).strict();
export type DesignRenderCell = z.infer<typeof DesignRenderCell>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lê reports.render. Célula sem rota, largura, tema ou estado válidos sai.
 * Campo malformado sai sozinho; item malformado de uma lista também. Chave desconhecida é ignorada.
 */
export function parseRenderCells(value: unknown): DesignRenderCell[] {
  if (!Array.isArray(value)) return [];
  const cells: DesignRenderCell[] = [];
  for (const raw of value.slice(0, CELL_MAX)) {
    if (!isRecord(raw)) continue;
    const candidate: Record<string, unknown> = {
      route: raw.route,
      viewport: raw.viewport,
      theme: raw.theme,
      state: raw.state,
    };
    if (typeof raw.file === 'string') candidate.file = clean(raw.file, 400);
    for (const [key, schema] of Object.entries(FIELDS)) {
      if (raw[key] === undefined) continue;
      const parsed = schema.safeParse(raw[key]);
      if (parsed.success) candidate[key] = parsed.data;
    }
    const parsed = DesignRenderCell.safeParse(candidate);
    if (parsed.success) cells.push(parsed.data);
  }
  return cells;
}

function cellFile(cell: DesignRenderCell): string {
  return `${cell.route} ${cell.viewport} ${cell.theme} ${cell.state}`;
}

function where(cell: DesignRenderCell): string {
  const state = cell.state === 'padrao' ? '' : `, estado ${cell.state}`;
  return `${cell.viewport}px, tema ${cell.theme}${state}`;
}

function finding(
  cell: DesignRenderCell,
  rule: string,
  severity: DesignSeverity,
  snippet: string,
  measure?: {kind: 'overflow'; px: number} | {kind: 'contrast'; ratio: number},
): DesignRawFinding {
  return designRawFinding({
    tool: TOOL,
    rule,
    file: cellFile(cell),
    line: null,
    severity,
    snippet,
    ...(measure === undefined ? {} : {measure}),
  });
}

/** O pior de uma lista: maior nota; no empate fica o primeiro. */
function worst<T>(items: readonly T[], score: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return best;
}

function offenderText(offenders: readonly {sel: string; right: number}[]): string {
  if (offenders.length === 0) return '';
  return `; passa da tela: ${offenders.map(item => `${item.sel} (até ${Math.round(item.right)}px)`).join(', ')}`;
}

/**
 * Até 375px a rolagem lateral é alta e leva a medida. Em 768 e 1440 é média.
 * Com overflow-x escondido no html ou no body, a medida não vale: é média, conteúdo cortado.
 */
function overflowFinding(cells: readonly DesignRenderCell[]): DesignRawFinding[] {
  const ranked = cells.flatMap(cell => {
    const overflow = cell.overflow;
    if (!overflow) return [];
    if (overflow.clip) {
      if (overflow.px < 2 && overflow.offenders.length === 0) return [];
      const reach = Math.max(overflow.px, ...overflow.offenders.map(item => item.right - cell.viewport));
      return [{cell, overflow, rank: 1, px: reach}];
    }
    if (overflow.px < 2) return [];
    return [{cell, overflow, rank: cell.viewport <= NARROW_MAX ? 3 : 2, px: overflow.px}];
  });
  const top = worst(ranked, item => item.rank * 1_000_000 + item.px);
  if (!top) return [];
  const extra = offenderText(top.overflow.offenders);
  if (top.rank === 1) {
    return [finding(top.cell, DESIGN_RENDER_RULES.overflow, 'media', `conteúdo cortado na lateral em ${where(top.cell)}${extra}`)];
  }
  const px = Math.max(2, Math.round(top.px));
  return [finding(
    top.cell,
    DESIGN_RENDER_RULES.overflow,
    top.rank === 3 ? 'alta' : 'media',
    `rolagem horizontal de ${px}px em ${where(top.cell)}${extra}`,
    {kind: 'overflow', px},
  )];
}

function clippedFinding(cells: readonly DesignRenderCell[]): DesignRawFinding[] {
  const hits = cells.flatMap(cell => (cell.clipped ?? []).map(item => ({cell, item})));
  const top = worst(hits, hit => hit.item.px);
  if (!top) return [];
  const more = hits.filter(hit => hit.cell === top.cell).length - 1;
  const tail = more > 0 ? `; e mais ${more}` : '';
  return [finding(
    top.cell,
    DESIGN_RENDER_RULES.clipped,
    'media',
    `texto cortado em ${top.item.sel}: "${top.item.text40}" perde ${Math.round(top.item.px)}px em ${where(top.cell)}${tail}`,
  )];
}

function imageFinding(cells: readonly DesignRenderCell[]): DesignRawFinding[] {
  const top = worst(cells.filter(cell => (cell.images ?? []).length > 0), cell => cell.images?.length ?? 0);
  if (!top) return [];
  const paths = [...new Set((top.images ?? []).map(item => item.path))];
  return [finding(top, DESIGN_RENDER_RULES.image, 'media', `imagem quebrada em ${where(top)}: ${paths.slice(0, 3).join(', ')}`)];
}

function zoomFinding(cells: readonly DesignRenderCell[]): DesignRawFinding[] {
  const hits = cells.flatMap(cell => (cell.inputs ?? [])
    .filter(item => TEXT_FIELDS.has(item.type) && item.fontPx < ZOOM_MIN_PX)
    .map(item => ({cell, item})));
  const top = worst(hits, hit => -hit.item.fontPx);
  if (!top) return [];
  const size = Math.round(top.item.fontPx * 100) / 100;
  return [finding(
    top.cell,
    DESIGN_RENDER_RULES.zoom,
    'baixa',
    `campo ${top.item.sel} com fonte de ${size}px em ${where(top.cell)}; abaixo de ${ZOOM_MIN_PX}px o iPhone amplia a tela ao tocar`,
  )];
}

const RESIDUE_LABEL: Record<DesignResidueKind, string> = {
  lorem: 'texto de exemplo (lorem ipsum)',
  modelo: 'variável de modelo sem valor',
  interpolacao: 'interpolação sem valor',
  objeto: 'objeto impresso como texto',
  valor: 'valor indefinido na tela',
  codificacao: 'acento com codificação errada',
};

function residueFindings(cells: readonly DesignRenderCell[]): DesignRawFinding[] {
  const found: DesignRawFinding[] = [];
  for (const kind of DesignResidueKind.options) {
    const hits = cells.flatMap(cell => (cell.residue ?? []).filter(item => item.kind === kind).map(item => ({cell, item})));
    const first = hits[0];
    if (!first) continue;
    found.push(finding(
      first.cell,
      DESIGN_RENDER_RULES.residue,
      'media',
      `${RESIDUE_LABEL[kind]} em ${first.item.sel}: "${first.item.text40}" (${where(first.cell)})`,
    ));
  }
  return found;
}

function chartFinding(cells: readonly DesignRenderCell[]): DesignRawFinding[] {
  const top = worst(cells.filter(cell => (cell.charts ?? []).length > 0), cell => cell.charts?.length ?? 0);
  const chart = top?.charts?.[0];
  if (!top || !chart) return [];
  const more = (top.charts?.length ?? 1) - 1;
  const tail = more > 0 ? `; e mais ${more}` : '';
  return [finding(
    top,
    DESIGN_RENDER_RULES.chart,
    'media',
    `gráfico ${chart.sel} de ${Math.round(chart.w)}x${Math.round(chart.h)}px sem nome, legenda ou tabela em ${where(top)}${tail}`,
  )];
}

function stateFindings(cells: readonly DesignRenderCell[]): DesignRawFinding[] {
  const found: DesignRawFinding[] = [];
  for (const state of ['hover', 'foco'] as const) {
    const hits = cells.flatMap(cell => (cell.states ?? [])
      .filter(item => item.state === state && item.ratio < item.need)
      .map(item => ({cell, item})));
    const top = worst(hits, hit => -hit.item.ratio);
    if (!top) continue;
    const ratio = Math.floor(top.item.ratio * 100) / 100;
    const moment = state === 'hover' ? 'ao passar o mouse' : 'com foco';
    found.push(finding(
      top.cell,
      DESIGN_RENDER_RULES.state,
      'alta',
      `"${top.item.label40}" ${moment}: contraste ${ratio.toFixed(2)}:1, mínimo ${top.item.need}:1 em ${where(top.cell)}`,
      {kind: 'contrast', ratio},
    ));
  }
  return found;
}

function motionFinding(cells: readonly DesignRenderCell[]): DesignRawFinding[] {
  const hits = cells.flatMap(cell => (cell.motion?.running ?? [])
    .filter(item => item.w >= MOTION_MIN_PX && item.h >= MOTION_MIN_PX)
    .map(item => ({cell, item})));
  const top = worst(hits, hit => hit.item.w * hit.item.h);
  if (!top) return [];
  return [finding(
    top.cell,
    DESIGN_RENDER_RULES.motion,
    'baixa',
    `animação infinita segue com movimento reduzido: ${top.item.sel} ${Math.round(top.item.w)}x${Math.round(top.item.h)}px em ${where(top.cell)}`,
  )];
}

/** O mesmo título em duas ou mais rotas. O achado fica na primeira rota. Título vazio não conta. */
function titleFindings(cells: readonly DesignRenderCell[]): DesignRawFinding[] {
  const byTitle = new Map<string, {title: string; routes: string[]; cell: DesignRenderCell}>();
  for (const cell of cells) {
    const title = cell.title ?? '';
    if (title.length === 0) continue;
    const key = title.toLocaleLowerCase('pt-BR');
    const entry = byTitle.get(key);
    if (!entry) byTitle.set(key, {title, routes: [cell.route], cell});
    else if (!entry.routes.includes(cell.route)) entry.routes.push(cell.route);
  }
  const found: DesignRawFinding[] = [];
  for (const entry of byTitle.values()) {
    if (entry.routes.length < 2) continue;
    const listed = entry.routes.slice(0, 5).join(', ');
    const tail = entry.routes.length > 5 ? ` e mais ${entry.routes.length - 5}` : '';
    found.push(finding(
      entry.cell,
      DESIGN_RENDER_RULES.title,
      'baixa',
      `título "${entry.title}" repetido em ${entry.routes.length} rotas: ${listed}${tail}`,
    ));
  }
  return found;
}

/**
 * Um achado por rota e regra, com a pior célula. O arquivo é "<rota> <largura> <tema> <estado>",
 * como no axe, para o módulo trocar a rota pelo arquivo da tela.
 * Só leva medida o defeito com número: rolagem lateral sem corte e contraste de estado.
 */
export function renderFindings(cells: readonly DesignRenderCell[]): DesignRawFinding[] {
  const routes: string[] = [];
  const byRoute = new Map<string, DesignRenderCell[]>();
  for (const cell of cells) {
    const list = byRoute.get(cell.route);
    if (list) list.push(cell);
    else {
      byRoute.set(cell.route, [cell]);
      routes.push(cell.route);
    }
  }
  const found: DesignRawFinding[] = [];
  for (const route of routes) {
    const list = byRoute.get(route) ?? [];
    found.push(
      ...overflowFinding(list),
      ...clippedFinding(list),
      ...imageFinding(list),
      ...zoomFinding(list),
      ...residueFindings(list),
      ...chartFinding(list),
      ...stateFindings(list),
      ...motionFinding(list),
    );
  }
  found.push(...titleFindings(cells));
  return found;
}
