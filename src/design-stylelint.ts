import {designRawFinding, type DesignRawFinding, type DesignSeverity} from './design-types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Configuração mínima. As regras do Stylelint não são as plantadas e nunca viram alta. */
export function stylelintConfig(): Record<string, unknown> {
  return {
    rules: {
      'block-no-empty': true,
      'color-no-invalid-hex': true,
      'declaration-no-important': true,
      // Só `all`: width, height, top e left dariam ruído demais.
      'declaration-property-value-disallowed-list': [
        {transition: ['/\\ball\\b/'], 'transition-property': ['/^all$/']},
        {severity: 'warning'},
      ],
    },
  };
}

const DISALLOWED_VALUE_RULE = 'declaration-property-value-disallowed-list';
export const TRANSITION_ALL_TEXT = 'transition: all anima o layout; liste só opacity e transform';

function positiveLine(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

/** error vira media; warning e qualquer outro nível viram baixa. Nunca alta. */
function stylelintSeverity(value: unknown): DesignSeverity {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'error') return 'media';
  return 'baixa';
}

function resultList(report: unknown): unknown[] {
  if (Array.isArray(report)) return report;
  if (isRecord(report) && Array.isArray(report.results)) return report.results;
  if (isRecord(report) && Array.isArray(report.warnings)) return [report];
  return [];
}

export function stylelintToFindings(file: string, report: unknown): DesignRawFinding[] {
  const findings: DesignRawFinding[] = [];
  for (const result of resultList(report)) {
    if (!isRecord(result) || !Array.isArray(result.warnings)) continue;
    for (const warning of result.warnings) {
      if (!isRecord(warning) || typeof warning.rule !== 'string') continue;
      const rule = warning.rule.trim();
      if (rule.length === 0) continue;
      const raw = typeof warning.text === 'string' && warning.text.trim().length > 0
        ? warning.text.trim()
        : rule;
      const text = rule === DISALLOWED_VALUE_RULE && /transition/i.test(raw) ? TRANSITION_ALL_TEXT : raw;
      findings.push(designRawFinding({
        tool: 'stylelint',
        rule,
        cwe: null,
        file,
        line: positiveLine(warning.line),
        severity: stylelintSeverity(warning.severity),
        snippet: text,
      }));
    }
  }
  return findings;
}
