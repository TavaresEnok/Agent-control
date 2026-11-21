import {colorsIn, cssDeclarations} from './design-inventory.ts';

/**
 * Sinais de aparência comum em telas feitas por modelo.
 * São só dicas para o relatório. Não viram achado, não entram na nota e não vão para a crítica visual.
 */
export type GenericSignalId = 'S1' | 'S2' | 'S3' | 'S4';

export type GenericHit = {id: GenericSignalId; file: string; line: number; snippet: string};

export type GenericSignal = {
  id: GenericSignalId;
  name: string;
  count: number;
  where: {file: string; line: number}[];
  example: string;
};

export const GENERIC_SIGNAL_NAMES: Record<GenericSignalId, string> = {
  S1: 'Gradiente violeta',
  S2: 'Texto com gradiente',
  S3: 'Vidro fosco repetido',
  S4: 'Emoji no lugar de ícone',
};

/** Vidro conta a partir de 3 regras de desfoque no projeto. */
export const GENERIC_GLASS_MIN = 3;
const MAX_WHERE = 5;
const MAX_SNIPPET = 120;
const CSS_FILE = /\.(?:css|scss|sass|less)$/i;
const MARKUP_FILE = /\.(?:html?|tsx|jsx|vue|svelte|astro)$/i;
const GRADIENT = /(?:linear|radial|conic)-gradient\(/i;
const TAILWIND_VIOLET = /\b(?:from|via|to)-(?:violet|purple|fuchsia)-\d{2,3}\b/;
const TAILWIND_GRADIENT = /\bbg-(?:gradient|linear|radial|conic)-/;
const CLASS_ATTR = /(?:^|[\s<])(?:class|className)\s*=\s*("[^"]*"|'[^']*'|`[^`]*`|\{[^}]*\})/g;
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const EMOJI = String.raw`(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️)`;
const EMOJI_TEXT = new RegExp(`>\\s*(${EMOJI})`, 'gu');
const EMOJI_PROP = new RegExp(`\\b(?:icon|icone|ícone|emoji)\\s*[:=]\\s*\\{?\\s*["'\`]\\s*(${EMOJI})`, 'giu');

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

function clip(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET);
}

/** Matiz em graus e saturação de 0 a 1 do HSL. */
function hueSaturation(rgb: {r: number; g: number; b: number}): {hue: number; saturation: number} {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return {hue: 0, saturation: 0};
  const light = (max + min) / 2;
  const saturation = delta / (1 - Math.abs(2 * light - 1));
  let hue = 0;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return {hue: (hue * 60 + 360) % 360, saturation};
}

/** Violeta e roxo: matiz de 255 a 300 graus, com cor de verdade. */
function isViolet(rgb: {r: number; g: number; b: number; a: number}): boolean {
  if (rgb.a < 0.2) return false;
  const {hue, saturation} = hueSaturation(rgb);
  return hue >= 255 && hue <= 300 && saturation >= 0.3;
}

function cssHits(file: string, css: string, lineOffset: number): GenericHit[] {
  const hits: GenericHit[] = [];
  for (const decl of cssDeclarations(css)) {
    const line = decl.line + lineOffset;
    const text = `${decl.prop}: ${decl.value}`;
    if (GRADIENT.test(decl.value) && colorsIn(decl.value).some(isViolet)) {
      hits.push({id: 'S1', file, line, snippet: clip(text)});
    }
    if ((decl.prop === 'background-clip' || decl.prop === '-webkit-background-clip') && /\btext\b/i.test(decl.value)) {
      hits.push({id: 'S2', file, line, snippet: clip(text)});
    }
    if ((decl.prop === 'backdrop-filter' || decl.prop === '-webkit-backdrop-filter') && /blur\(/i.test(decl.value)) {
      hits.push({id: 'S3', file, line, snippet: clip(text)});
    }
  }
  return dedupeGlass(hits);
}

/** backdrop-filter e o prefixo -webkit- na mesma regra contam uma vez. */
function dedupeGlass(hits: GenericHit[]): GenericHit[] {
  const out: GenericHit[] = [];
  for (const hit of hits) {
    if (hit.id === 'S3') {
      const near = out.some(item => item.id === 'S3' && item.file === hit.file && Math.abs(item.line - hit.line) <= 1);
      if (near) continue;
    }
    out.push(hit);
  }
  return out;
}

export function genericSignalsFromCss(file: string, css: string): GenericHit[] {
  return cssHits(file, css, 0);
}

/** Marcação: classes do Tailwind, blocos <style> e emoji no começo do texto ou como ícone de dado. */
export function genericSignalsFromMarkup(file: string, text: string): GenericHit[] {
  const hits: GenericHit[] = [];
  for (const match of text.matchAll(STYLE_BLOCK)) {
    const body = match[1] ?? '';
    const bodyIndex = match.index + match[0].indexOf(body);
    hits.push(...cssHits(file, body, lineAt(text, bodyIndex) - 1));
  }
  for (const match of text.matchAll(CLASS_ATTR)) {
    const value = match[1] ?? '';
    const line = lineAt(text, match.index);
    if (TAILWIND_GRADIENT.test(value) && TAILWIND_VIOLET.test(value)) hits.push({id: 'S1', file, line, snippet: clip(value)});
    if (/\bbg-clip-text\b/.test(value) && /\btext-transparent\b/.test(value)) hits.push({id: 'S2', file, line, snippet: clip(value)});
    if (/\bbackdrop-blur(?:-\w+)?\b/.test(value)) hits.push({id: 'S3', file, line, snippet: clip(value)});
  }
  const seenEmoji = new Set<number>();
  for (const pattern of [EMOJI_TEXT, EMOJI_PROP]) {
    for (const match of text.matchAll(pattern)) {
      const emoji = match[1] ?? '';
      const at = match.index + match[0].lastIndexOf(emoji);
      if (seenEmoji.has(at)) continue;
      seenEmoji.add(at);
      const lineStart = text.lastIndexOf('\n', at) + 1;
      const lineEnd = text.indexOf('\n', at);
      hits.push({id: 'S4', file, line: lineAt(text, at), snippet: clip(text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd))});
    }
  }
  return hits;
}

/** Junta os sinais do projeto. Vidro só entra com 3 regras ou mais. */
export function collectGenericSignals(files: readonly {path: string; text: string}[]): GenericSignal[] {
  const hits: GenericHit[] = [];
  for (const file of files) {
    if (CSS_FILE.test(file.path)) hits.push(...genericSignalsFromCss(file.path, file.text));
    else if (MARKUP_FILE.test(file.path)) hits.push(...genericSignalsFromMarkup(file.path, file.text));
  }
  const signals: GenericSignal[] = [];
  for (const id of ['S1', 'S2', 'S3', 'S4'] as const) {
    const own = hits.filter(hit => hit.id === id);
    if (own.length === 0) continue;
    if (id === 'S3' && own.length < GENERIC_GLASS_MIN) continue;
    signals.push({
      id,
      name: GENERIC_SIGNAL_NAMES[id],
      count: own.length,
      where: own.slice(0, MAX_WHERE).map(hit => ({file: hit.file, line: hit.line})),
      example: own[0]?.snippet ?? '',
    });
  }
  return signals;
}

function cell(text: string): string {
  return text.replace(/[|`<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Corpo da seção 'Sinais de modelo genérico', sem o título. */
export function genericLookMarkdown(signals: readonly GenericSignal[]): string {
  const lines = ['Aparência comum em telas feitas por modelo. É dica de leitura: não conta como achado nem entra na nota.', ''];
  if (signals.length === 0) lines.push('Nenhum sinal encontrado.');
  for (const signal of signals) {
    const where = signal.where.map(item => `${cell(item.file)}:${item.line}`).join(', ');
    const more = signal.count > signal.where.length ? ` e mais ${signal.count - signal.where.length}` : '';
    const label = signal.count === 1 ? 'ocorrência' : 'ocorrências';
    lines.push(`- ${signal.name}: ${signal.count} ${label} (${where}${more}). Exemplo: \`${cell(signal.example)}\`.`);
  }
  lines.push('', 'É preferência, não falha.');
  return lines.join('\n');
}
