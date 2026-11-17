import {DESIGN_CONTRAST_AA, DESIGN_CONTRAST_AA_LARGE, DESIGN_PLANTED_RULES, designRawFinding, type DesignRawFinding} from './design-types.ts';

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
    }));
  }
}

function accessibleName(attrs: string, inner: string): string {
  const aria = attrs.match(/\baria-label\s*=\s*(["'])([\s\S]*?)\1/i)?.[2]?.trim() ?? '';
  if (aria) return aria;
  const labelled = attrs.match(/\baria-labelledby\s*=\s*(["'])([\s\S]*?)\1/i)?.[2]?.trim() ?? '';
  if (labelled) return labelled;
  const title = attrs.match(/\btitle\s*=\s*(["'])([\s\S]*?)\1/i)?.[2]?.trim() ?? '';
  if (title) return title;
  const alt = inner.match(/\balt\s*=\s*(["'])([\s\S]*?)\1/i)?.[2]?.trim() ?? '';
  if (alt) return alt;
  return inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function flagUnlabeled(findings: DesignRawFinding[], file: string, html: string, index: number, attrs: string, inner: string, raw: string): void {
  if (accessibleName(attrs, inner)) return;
  findings.push(designRawFinding({
    tool: 'html',
    rule: DESIGN_PLANTED_RULES.unlabeledButton,
    file,
    line: lineAt(html, index),
    severity: 'alta',
    snippet: raw.replace(/\s+/g, ' ').slice(0, 180),
  }));
}

function unlabeledButtons(findings: DesignRawFinding[], file: string, html: string): void {
  const buttons = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let match: RegExpExecArray | null;
  while ((match = buttons.exec(html)) !== null) {
    flagUnlabeled(findings, file, html, match.index, match[1] ?? '', match[2] ?? '', match[0]);
  }
  const roles = /<([a-zA-Z][\w:-]*)\b([^>]*\brole\s*=\s*(["'])button\3[^>]*)>([\s\S]*?)<\/\1>/gi;
  while ((match = roles.exec(html)) !== null) {
    flagUnlabeled(findings, file, html, match.index, match[2] ?? '', match[4] ?? '', match[0]);
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

function axeRule(id: string): {rule: string; allowHigh: boolean} {
  if (id === 'color-contrast') return {rule: DESIGN_PLANTED_RULES.contrast, allowHigh: true};
  if (id === 'button-name' || id === 'link-name' || id === 'image-alt' || id === 'label') {
    return {rule: id === 'button-name' ? DESIGN_PLANTED_RULES.unlabeledButton : `WCAG-${id}`.slice(0, 200), allowHigh: true};
  }
  if (id.includes('focus')) return {rule: DESIGN_PLANTED_RULES.invisibleFocus, allowHigh: true};
  return {rule: id.slice(0, 200), allowHigh: false};
}

export function axeToFindings(file: string, axeJson: unknown): DesignRawFinding[] {
  if (!axeJson || typeof axeJson !== 'object' || !('violations' in axeJson) || !Array.isArray(axeJson.violations)) return [];
  const findings: DesignRawFinding[] = [];
  for (const violation of axeJson.violations) {
    if (!violation || typeof violation !== 'object') continue;
    const id = 'id' in violation && typeof violation.id === 'string' ? violation.id : '';
    if (!id) continue;
    const impact = 'impact' in violation && typeof violation.impact === 'string' ? violation.impact : 'minor';
    const mapped = axeRule(id);
    const nodes = 'nodes' in violation && Array.isArray(violation.nodes) ? violation.nodes : [null];
    const help = 'help' in violation && typeof violation.help === 'string' ? violation.help : id;
    for (const node of nodes) {
      const html = node && typeof node === 'object' && 'html' in node && typeof node.html === 'string' ? node.html : help;
      findings.push(designRawFinding({
        tool: 'axe',
        rule: mapped.rule,
        file,
        line: null,
        severity: impactSeverity(impact, mapped.allowHigh),
        snippet: html,
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
    findings.push(designRawFinding({
      tool: 'pa11y',
      rule: contrast ? DESIGN_PLANTED_RULES.contrast : button ? DESIGN_PLANTED_RULES.unlabeledButton : code.slice(0, 200),
      file,
      line: null,
      severity: contrast || button ? 'alta' : 'media',
      snippet: context || message,
    }));
  }
  return findings;
}
