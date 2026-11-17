import {DESIGN_CONTRAST_AA, DESIGN_CONTRAST_AA_LARGE, DESIGN_PLANTED_RULES, designRawFinding, type DesignMeasure, type DesignRawFinding} from './design-types.ts';

type Rgb = {r: number; g: number; b: number};

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function parseHex(token: string): Rgb | null {
  const match = token.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match?.[1]) return null;
  const hex = match[1].length === 3 ? match[1].split('').map(char => char + char).join('') : match[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(fg: Rgb, bg: Rgb): number {
  const lum = (color: Rgb) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  const lighter = Math.max(lum(fg), lum(bg));
  const darker = Math.min(lum(fg), lum(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

function declared(style: string, prop: string): string | null {
  const match = style.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i'));
  return match?.[1]?.trim() ?? null;
}

function isInherit(value: string | null): boolean {
  return value === null || /^(inherit|initial|unset|revert)$/i.test(value);
}

function fontSizePx(style: string): number | null {
  const raw = declared(style, 'font-size');
  if (!raw) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)px$/i);
  return match?.[1] ? Number(match[1]) : null;
}

function isBold(style: string): boolean {
  const weight = declared(style, 'font-weight');
  if (!weight) return false;
  if (/bold/i.test(weight)) return true;
  const numeric = Number(weight);
  return Number.isFinite(numeric) && numeric >= 700;
}

function threshold(style: string): number {
  const size = fontSizePx(style);
  if (size !== null && (size >= 24 || (size >= 18 && isBold(style)))) return DESIGN_CONTRAST_AA_LARGE;
  return DESIGN_CONTRAST_AA;
}

function elementContrast(findings: DesignRawFinding[], file: string, html: string): void {
  const pattern = /<([a-zA-Z][\w:-]*)\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attrs = match[2] ?? '';
    const style = attrs.match(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i)?.[2];
    if (!style) continue;
    const open = match[0].replace(/\s+/g, ' ').slice(0, 160);
    const colorText = declared(style, 'color');
    if (isInherit(colorText) || !colorText) continue;
    const fg = parseHex(colorText);
    if (!fg) continue;
    const bgText = declared(style, 'background-color') ?? declared(style, 'background');
    const bg = !bgText || isInherit(bgText) ? {r: 255, g: 255, b: 255} : parseHex(bgText);
    if (!bg) continue;
    const ratio = contrastRatio(fg, bg);
    if (ratio >= threshold(style)) continue;
    findings.push(designRawFinding({
      tool: 'axe',
      rule: DESIGN_PLANTED_RULES.contrast,
      file,
      line: lineAt(html, match.index),
      severity: 'alta',
      snippet: `${open} contraste ${ratio.toFixed(2)}:1`,
      measure: {kind: 'contrast', ratio},
    }));
  }
}

const CLOSE_TAG = /^<\s*\/\s*([A-Za-z][\w:-]*)\s*>/;
const OPEN_NAME = /^<([A-Za-z][\w:-]*)\b/;

function endOfOpeningTag(text: string, start: number): number {
  let quote: '"' | "'" | '`' | null = null;
  let brace = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') {
      brace += 1;
      continue;
    }
    if (char === '}') {
      brace = Math.max(0, brace - 1);
      continue;
    }
    if (char === '>' && brace === 0) return index;
  }
  return -1;
}

function readQuoted(source: string, start: number): {value: string; end: number} | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source[index] === quote) return {value: source.slice(start + 1, index), end: index};
  }
  return null;
}

function readBraced(source: string, start: number): {expr: string; end: number} | null {
  if (source[start] !== '{') return null;
  let quote: '"' | "'" | '`' | null = null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return {expr: source.slice(start + 1, index), end: index};
    }
  }
  return null;
}

function expressionCounts(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed.length === 0 || trimmed === 'null' || trimmed === 'undefined' || trimmed === 'false') return false;
  if (trimmed.startsWith('/*') || trimmed.startsWith('//')) return false;
  const quote = trimmed[0];
  const end = trimmed[trimmed.length - 1];
  if ((quote === '"' || quote === "'" || quote === '`') && end === quote && trimmed.length >= 2) {
    const body = trimmed.slice(1, -1);
    if (quote === '`' && body.includes('${')) return true;
    return body.trim().length > 0;
  }
  return true;
}

function attributeCounts(source: string, name: string): boolean {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const from = match.index + match[0].length;
    const char = source[from];
    if (char === '"' || char === "'") {
      const quoted = readQuoted(source, from);
      if (quoted === null) continue;
      pattern.lastIndex = quoted.end + 1;
      if (quoted.value.trim().length > 0) return true;
      continue;
    }
    if (char === '{') {
      const braced = readBraced(source, from);
      if (braced === null) continue;
      pattern.lastIndex = braced.end + 1;
      if (expressionCounts(braced.expr)) return true;
    }
  }
  return false;
}

function visibleText(inner: string): string {
  let text = '';
  let index = 0;
  while (index < inner.length) {
    const char = inner[index];
    if (char === '<') {
      if (inner.startsWith('<!--', index)) {
        const end = inner.indexOf('-->', index + 4);
        index = end < 0 ? inner.length : end + 3;
        continue;
      }
      const tagEnd = endOfOpeningTag(inner, index);
      if (tagEnd < 0) {
        text += char;
        index += 1;
        continue;
      }
      index = tagEnd + 1;
      continue;
    }
    if (char === '{') {
      const braced = readBraced(inner, index);
      if (braced === null) {
        text += char;
        index += 1;
        continue;
      }
      if (expressionCounts(braced.expr)) text += ' x ';
      index = braced.end + 1;
      continue;
    }
    text += char;
    index += 1;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function containsComponent(inner: string): boolean {
  return /<[A-Z][\w.]*/.test(inner);
}

function accessibleName(attrs: string, inner: string): string {
  for (const name of ['aria-label', 'aria-labelledby', 'title']) {
    if (attributeCounts(attrs, name)) return name;
  }
  if (attributeCounts(inner, 'alt')) return 'alt';
  return visibleText(inner);
}

function findClosingTag(html: string, tag: string, from: number): {innerEnd: number; rawEnd: number} | null {
  const lower = tag.toLowerCase();
  let quote: '"' | "'" | '`' | null = null;
  let brace = 0;
  let depth = 1;
  for (let index = from; index < html.length; index += 1) {
    const char = html[index];
    if (brace > 0 && quote !== null) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (brace > 0 && (char === '"' || char === "'" || char === '`')) {
      quote = char;
      continue;
    }
    if (char === '{') {
      brace += 1;
      continue;
    }
    if (char === '}' && brace > 0) {
      brace -= 1;
      continue;
    }
    if (char !== '<' || brace !== 0) continue;
    const slice = html.slice(index);
    const close = CLOSE_TAG.exec(slice);
    if (close?.[1] && close[1].toLowerCase() === lower) {
      depth -= 1;
      if (depth === 0) return {innerEnd: index, rawEnd: index + close[0].length};
      index += close[0].length - 1;
      continue;
    }
    const open = OPEN_NAME.exec(slice);
    if (!open?.[1] || open[1].toLowerCase() !== lower) continue;
    const tagEnd = endOfOpeningTag(html, index);
    if (tagEnd < 0) return null;
    const opening = html.slice(index, tagEnd + 1);
    if (!/\/\s*>$/.test(opening)) depth += 1;
    index = tagEnd;
  }
  return null;
}

function isButtonLike(tag: string, attrs: string): boolean {
  if (tag.toLowerCase() === 'button') return true;
  return /\brole\s*=\s*(["'])button\1/i.test(attrs);
}

function openingParts(opening: string, tokenLength: number): {attrs: string; selfClosing: boolean} {
  const suffix = /\/\s*>$/.exec(opening);
  const cut = suffix ? suffix[0].length : 1;
  return {attrs: opening.slice(tokenLength, opening.length - cut), selfClosing: suffix !== null};
}

function flagUnlabeled(findings: DesignRawFinding[], file: string, html: string, index: number, attrs: string, inner: string, raw: string): void {
  if (accessibleName(attrs, inner) || containsComponent(inner)) return;
  findings.push(designRawFinding({
    tool: 'html',
    rule: DESIGN_PLANTED_RULES.unlabeledButton,
    file,
    line: lineAt(html, index),
    severity: 'media',
    snippet: raw.replace(/\s+/g, ' ').slice(0, 180),
  }));
}

function unlabeledButtons(findings: DesignRawFinding[], file: string, html: string): void {
  const open = /<([A-Za-z][\w:-]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = open.exec(html)) !== null) {
    const start = match.index;
    const tag = match[1] ?? '';
    const tagEnd = endOfOpeningTag(html, start);
    if (tagEnd < 0) {
      open.lastIndex = start + 1;
      continue;
    }
    const opening = html.slice(start, tagEnd + 1);
    const parts = openingParts(opening, match[0].length);
    if (!isButtonLike(tag, parts.attrs)) {
      open.lastIndex = tagEnd + 1;
      continue;
    }
    if (parts.selfClosing) {
      flagUnlabeled(findings, file, html, start, parts.attrs, '', opening);
      open.lastIndex = tagEnd + 1;
      continue;
    }
    const close = findClosingTag(html, tag, tagEnd + 1);
    if (close === null) {
      open.lastIndex = tagEnd + 1;
      continue;
    }
    const inner = html.slice(tagEnd + 1, close.innerEnd);
    flagUnlabeled(findings, file, html, start, parts.attrs, inner, html.slice(start, close.rawEnd));
    open.lastIndex = close.rawEnd;
  }
}

export function staticHtmlFindings(file: string, html: string, css?: string): DesignRawFinding[] {
  const findings: DesignRawFinding[] = [];
  elementContrast(findings, file, html);
  unlabeledButtons(findings, file, html);
  if (css) elementContrast(findings, file, css);
  return findings;
}

function impactSeverity(impact: string, allowHigh: boolean): DesignRawFinding['severity'] {
  if (impact === 'critical' || impact === 'serious') return allowHigh ? 'alta' : 'media';
  if (impact === 'moderate') return 'baixa';
  return 'informativa';
}

const RATIO_EXPECTED = /(?:expected|at least|minimum|m[ií]nimo|requer|exig)[^0-9]{0,40}$/i;

function ratioFromText(text: string): number | null {
  const patterns = [
    /contrast of (\d+(?:\.\d+)?)/gi,
    /contraste(?:\s+de)?\s+(\d+(?:\.\d+)?)(?!\s*px)/gi,
    /(\d+(?:\.\d+)?)\s*:\s*1/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const before = text.slice(Math.max(0, match.index - 48), match.index);
      if (RATIO_EXPECTED.test(before)) continue;
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

function finiteRatio(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function contrastMeasure(ratio: number | null): DesignMeasure | undefined {
  if (ratio === null) return undefined;
  return {kind: 'contrast', ratio};
}

function nodeContrastRatio(node: unknown, help: string): number | null {
  if (node && typeof node === 'object') {
    const data = 'data' in node && node.data && typeof node.data === 'object' && !Array.isArray(node.data)
      ? node.data as Record<string, unknown>
      : null;
    const structured = finiteRatio(data?.contrastRatio ?? data?.['contrast-ratio']);
    if (structured !== null) return structured;
    const summary = 'failureSummary' in node && typeof node.failureSummary === 'string' ? node.failureSummary : '';
    const html = 'html' in node && typeof node.html === 'string' ? node.html : '';
    const fromNode = ratioFromText(`${summary}\n${html}`);
    if (fromNode !== null) return fromNode;
  }
  return ratioFromText(help);
}

function axeRule(id: string): string {
  if (id === 'color-contrast') return DESIGN_PLANTED_RULES.contrast;
  if (id === 'button-name') return DESIGN_PLANTED_RULES.unlabeledButton;
  if (id === 'link-name' || id === 'image-alt' || id === 'label') return `WCAG-${id}`.slice(0, 200);
  if (id.includes('focus')) return DESIGN_PLANTED_RULES.invisibleFocus;
  return id.slice(0, 200);
}

export function axeToFindings(file: string, axeJson: unknown): DesignRawFinding[] {
  if (!axeJson || typeof axeJson !== 'object' || !('violations' in axeJson) || !Array.isArray(axeJson.violations)) return [];
  const findings: DesignRawFinding[] = [];
  for (const violation of axeJson.violations) {
    if (!violation || typeof violation !== 'object') continue;
    const id = 'id' in violation && typeof violation.id === 'string' ? violation.id : '';
    if (!id) continue;
    const impact = 'impact' in violation && typeof violation.impact === 'string' ? violation.impact : 'minor';
    const rule = axeRule(id);
    const nodes = 'nodes' in violation && Array.isArray(violation.nodes) ? violation.nodes : [null];
    const help = 'help' in violation && typeof violation.help === 'string' ? violation.help : id;
    for (const node of nodes) {
      const html = node && typeof node === 'object' && 'html' in node && typeof node.html === 'string' ? node.html : help;
      const ratio = rule === DESIGN_PLANTED_RULES.contrast ? nodeContrastRatio(node, help) : null;
      const measure = contrastMeasure(ratio);
      findings.push(designRawFinding({
        tool: 'axe',
        rule,
        file,
        line: null,
        severity: impactSeverity(impact, measure !== undefined),
        snippet: html,
        ...(measure === undefined ? {} : {measure}),
      }));
    }
  }
  return findings;
}

export function pa11yToFindings(file: string, pa11yJson: unknown): DesignRawFinding[] {
  const issues = Array.isArray(pa11yJson) ? pa11yJson : (pa11yJson && typeof pa11yJson === 'object' && 'issues' in pa11yJson && Array.isArray(pa11yJson.issues) ? pa11yJson.issues : []);
  const findings: DesignRawFinding[] = [];
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object') continue;
    const code = 'code' in issue && typeof issue.code === 'string' ? issue.code : 'pa11y';
    const message = 'message' in issue && typeof issue.message === 'string' ? issue.message : code;
    const context = 'context' in issue && typeof issue.context === 'string' ? issue.context : message;
    const contrast = /1\.4\.3|color-contrast|contrast/i.test(code + message);
    const button = /button-name|4\.1\.2|empty button/i.test(code + message);
    const ratio = contrast ? ratioFromText(`${code}\n${message}\n${context}`) : null;
    const measure = contrastMeasure(ratio);
    findings.push(designRawFinding({
      tool: 'pa11y',
      rule: contrast ? DESIGN_PLANTED_RULES.contrast : button ? DESIGN_PLANTED_RULES.unlabeledButton : code.slice(0, 200),
      file,
      line: null,
      severity: measure !== undefined ? 'alta' : 'media',
      snippet: context || message,
      ...(measure === undefined ? {} : {measure}),
    }));
  }
  return findings;
}
