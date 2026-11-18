import {designRawFinding, type DesignRawFinding} from './design-types.ts';

type LighthouseSeverity = 'media' | 'baixa';

const TOOL = 'lighthouse';
const PERFORMANCE_MIN = 0.5;
const CLS_MAX = 0.25;
const LCP_MAX = 4000;
const ACCESSIBILITY_MIN = 0.9;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function readRoot(lhr: unknown): Record<string, unknown> | null {
  let value = lhr;
  if (typeof value === 'string') {
    value = JSON.parse(value) as unknown;
  }
  if (!isRecord(value)) return null;
  return value;
}

function categoryScore(root: Record<string, unknown>, name: string): number | null {
  if (!isRecord(root.categories)) return null;
  const category = root.categories[name];
  if (!isRecord(category)) return null;
  return finiteNumber(category.score);
}

function auditValue(root: Record<string, unknown>, name: string): number | null {
  if (!isRecord(root.audits)) return null;
  const audit = root.audits[name];
  if (!isRecord(audit)) return null;
  return finiteNumber(audit.numericValue);
}

function measuredFinding(
  file: string,
  rule: string,
  severity: LighthouseSeverity,
  label: string,
  value: number,
): DesignRawFinding {
  return designRawFinding({
    tool: TOOL,
    rule,
    cwe: null,
    file,
    line: null,
    severity,
    snippet: `${label} ${value}`,
  });
}

function findingsFromLhr(file: string, lhr: unknown): DesignRawFinding[] {
  const root = readRoot(lhr);
  if (root === null) return [];
  const findings: DesignRawFinding[] = [];
  const performance = categoryScore(root, 'performance');
  if (performance !== null && performance < PERFORMANCE_MIN) {
    findings.push(measuredFinding(file, 'LH-PERFORMANCE', 'media', 'Desempenho', performance));
  }
  const cls = auditValue(root, 'cumulative-layout-shift');
  if (cls !== null && cls > CLS_MAX) {
    findings.push(measuredFinding(file, 'LH-CLS', 'media', 'CLS', cls));
  }
  const lcp = auditValue(root, 'largest-contentful-paint');
  if (lcp !== null && lcp > LCP_MAX) {
    findings.push(measuredFinding(file, 'LH-LCP', 'media', 'LCP', lcp));
  }
  const accessibility = categoryScore(root, 'accessibility');
  if (accessibility !== null && accessibility < ACCESSIBILITY_MIN) {
    findings.push(measuredFinding(file, 'LH-ACESSIBILIDADE', 'baixa', 'Acessibilidade', accessibility));
  }
  return findings;
}

/** Converte um LHR já coletado. JSON ausente ou malformado não gera achado. */
export function lighthouseToFindings(file: string, lhr: unknown): DesignRawFinding[] {
  try {
    return findingsFromLhr(file, lhr);
  } catch {
    return [];
  }
}
