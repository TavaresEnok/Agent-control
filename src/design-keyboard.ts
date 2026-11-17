import {DESIGN_PLANTED_RULES, designRawFinding, type DesignRawFinding} from './design-types.ts';

export type FocusStep = {
  selector: string;
  index: number;
  outlineWidth: string;
  outlineStyle: string;
  visible: boolean;
  x: number;
  y: number;
};

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

export function keyboardFindings(file: string, steps: readonly FocusStep[]): DesignRawFinding[] {
  const findings: DesignRawFinding[] = [];
  let previousY: number | null = null;
  for (const step of steps) {
    const hidden = !step.visible || step.outlineStyle === 'none' || step.outlineWidth === '0px';
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
