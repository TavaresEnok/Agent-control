import {z} from 'zod';
import {DESIGN_PLANTED_RULES, designRawFinding, type DesignRawFinding} from './design-types.ts';

export type FocusStep = {
  selector: string;
  index: number;
  outlineWidth: string;
  outlineStyle: string;
  /** Anel de foco desenhado com sombra. Opcional: passos antigos não têm. */
  boxShadow?: string;
  visible: boolean;
  /** Parte dos 5 pontos do elemento sob algo fixo ou grudado (0 a 1). */
  covered?: number;
  x: number;
  y: number;
};

export type FocusWalk = {file: string; steps: FocusStep[]};

export const FOCUS_COVERED_RULE = 'WCAG-2-4-11-FOCO-ENCOBERTO';

const WALK_MAX = 40;
const STEP_MAX = 40;

function clean(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const Short = (max: number) => z.string().max(2000).transform(value => clean(value, max));
const Coordinate = z.number().finite().min(-1_000_000).max(1_000_000);

const FocusStepSchema = z.object({
  selector: Short(120).refine(value => value.length > 0),
  index: z.number().int().min(0).max(1000),
  outlineWidth: Short(40),
  outlineStyle: Short(40),
  boxShadow: Short(200).optional(),
  visible: z.boolean(),
  covered: z.number().finite().min(0).max(1).optional(),
  x: Coordinate,
  y: Coordinate,
});

/**
 * Lê reports.keyboard da imagem: até 40 rotas e 40 passos cada.
 * Passo malformado sai sozinho. Rota sem passo válido sai. Chave desconhecida do passo é ignorada.
 */
export function parseFocusWalks(value: unknown): FocusWalk[] {
  if (!Array.isArray(value)) return [];
  const walks: FocusWalk[] = [];
  for (const raw of value) {
    if (walks.length >= WALK_MAX) break;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const file = typeof record.file === 'string' ? clean(record.file, 400) : '';
    if (!file.startsWith('/') || !Array.isArray(record.steps)) continue;
    const steps: FocusStep[] = [];
    for (const item of record.steps.slice(0, STEP_MAX)) {
      const parsed = FocusStepSchema.safeParse(item);
      if (!parsed.success) continue;
      const step = parsed.data;
      steps.push({
        selector: step.selector,
        index: step.index,
        outlineWidth: step.outlineWidth,
        outlineStyle: step.outlineStyle,
        ...(step.boxShadow === undefined ? {} : {boxShadow: step.boxShadow}),
        visible: step.visible,
        ...(step.covered === undefined ? {} : {covered: step.covered}),
        x: step.x,
        y: step.y,
      });
    }
    if (steps.length > 0) walks.push({file, steps});
  }
  return walks;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function outlineNone(body: string): boolean {
  return /outline\s*:\s*(?:none|0(?:\.0+)?)\b/i.test(body);
}

function outlineReplaced(body: string): boolean {
  const outline = body.match(/outline\s*:\s*([^;]+)/i)?.[1]?.trim() ?? '';
  if (outline && !/^(?:none|0(?:\.0+)?)$/i.test(outline)) return true;
  const shadow = body.match(/box-shadow\s*:\s*([^;]+)/i)?.[1]?.trim() ?? '';
  return shadow.length > 0 && !/^(?:none|initial|unset)$/i.test(shadow);
}

export function focusFindingsFromCss(file: string, css: string): DesignRawFinding[] {
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  let badIndex: number | null = null;
  let badSnippet = '';
  let replaced = false;
  for (const block of blocks) {
    const selector = block[1] ?? '';
    const body = block[2] ?? '';
    if (/:focus-visible\b/i.test(selector) && outlineReplaced(body)) replaced = true;
    if (/:focus\b/i.test(selector) && outlineNone(body) && badIndex === null) {
      badIndex = block.index ?? 0;
      badSnippet = `${selector.trim()} { ${body.trim()} }`;
    }
  }
  if (badIndex === null || replaced) return [];
  return [designRawFinding({
    tool: 'teclado',
    rule: DESIGN_PLANTED_RULES.invisibleFocus,
    file,
    line: lineAt(css, badIndex),
    severity: 'alta',
    snippet: badSnippet,
  })];
}

/** Divide a lista de sombras nas vírgulas de fora dos parênteses. */
function shadowLayers(value: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      layers.push(value.slice(start, i));
      start = i + 1;
    }
  }
  layers.push(value.slice(start));
  return layers.map(layer => layer.trim()).filter(Boolean);
}

function colorAlpha(color: string): number {
  if (/^transparent$/i.test(color)) return 0;
  const args = /\(([^()]*)\)/.exec(color)?.[1];
  if (args === undefined) return 1;
  const slash = args.split('/');
  const raw = slash.length > 1 ? slash[1]?.trim() : /^(?:rgba|hsla)$/i.test(color.split('(')[0] ?? '') ? args.split(',')[3]?.trim() : undefined;
  if (raw === undefined || raw === '') return 1;
  const value = raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 1;
}

/**
 * Sombra que desenha anel de foco: sem deslocamento, com espalhamento ou desfoque, e cor de pelo menos 20%.
 * Sombra de repouso de cartão tem deslocamento vertical e não conta. Anel quase transparente também não.
 * Limite: um anel igual ao de repouso ainda conta, porque o passo não guarda a sombra sem foco.
 * Sombra que não dá para ler conta como anel, para não acusar sem medida.
 */
export function shadowDrawsRing(value: string | undefined): boolean {
  if (!value || value === 'none') return false;
  for (const layer of shadowLayers(value)) {
    const color = /(?:[a-z-]+\([^()]*\)|#[0-9a-f]{3,8}\b|\btransparent\b)/i.exec(layer)?.[0] ?? '';
    const lengths = layer.replace(color, ' ').split(/\s+/).filter(token => /^-?\d*\.?\d+(?:px)?$/.test(token)).map(Number.parseFloat);
    if (lengths.length < 2) return true;
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
    if (x === 0 && y === 0 && (spread > 0 || blur > 0) && colorAlpha(color) >= 0.2) return true;
  }
  return false;
}

export function keyboardFindings(file: string, steps: readonly FocusStep[]): DesignRawFinding[] {
  const findings: DesignRawFinding[] = [];
  let previousY: number | null = null;
  for (const step of steps) {
    // Sem contorno, mas com anel de sombra, o foco aparece. Sombra de repouso não é anel.
    const noOutline = step.outlineStyle === 'none' || step.outlineWidth === '0px';
    const hidden = !step.visible || (noOutline && !shadowDrawsRing(step.boxShadow));
    if (hidden) {
      findings.push(designRawFinding({
        tool: 'teclado',
        rule: DESIGN_PLANTED_RULES.invisibleFocus,
        file,
        line: null,
        severity: 'alta',
        snippet: `${step.selector} foco sem contorno visível`,
      }));
    }
    if (step.visible && step.covered === 1) {
      findings.push(designRawFinding({
        tool: 'teclado',
        rule: FOCUS_COVERED_RULE,
        file,
        line: null,
        severity: 'media',
        snippet: `${step.selector} com foco fica inteiro sob um elemento fixo`,
      }));
    }
    if (previousY !== null && step.y < previousY - 200) {
      findings.push(designRawFinding({
        tool: 'teclado',
        rule: 'WCAG-2-4-3-ORDEM-DO-FOCO',
        file,
        line: null,
        severity: 'media',
        snippet: `${step.selector} voltou ${Math.round(previousY - step.y)}px`,
      }));
    }
    previousY = step.y;
  }
  return findings;
}
