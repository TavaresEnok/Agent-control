import {axeToFindings, pa11yToFindings, staticHtmlFindings} from './design-a11y.ts';
import {missingEmptyStateFindings} from './design-discover.ts';
import {inventoryFindingsFromCss} from './design-inventory.ts';
import {focusFindingsFromCss, keyboardFindings, type FocusStep} from './design-keyboard.ts';
import {lighthouseToFindings} from './design-lighthouse.ts';
import {renderFindings, type DesignRenderCell} from './design-render.ts';
import {stylelintToFindings} from './design-stylelint.ts';
import {dedupeDesignFindings, type DesignRawFinding} from './design-types.ts';
import {wallaceFindings} from './design-wallace.ts';

const MARKUP = /\.(?:html?|tsx|jsx|vue)$/i;
const STYLE = /\.css$/i;

export const DESIGN_RAW_SCHEMA = 'design-achados-brutos-1';

export type DesignSourceFile = {path: string; text: string};

/** Saídas já coletadas. Este módulo só converte; não chama as ferramentas. */
export type DesignToolReports = {
  axe?: readonly {file: string; json: unknown}[];
  pa11y?: readonly {file: string; json: unknown}[];
  lighthouse?: readonly {file: string; lhr: unknown}[];
  stylelint?: readonly {file: string; report: unknown}[];
  cssAnalyzer?: readonly {file: string; report: unknown}[];
  keyboard?: readonly {file: string; steps: readonly FocusStep[]}[];
  /** Régua da página renderizada, célula por célula. */
  render?: readonly DesignRenderCell[];
};

/**
 * Achados brutos no formato do módulo 1, a partir do código e dos JSON das ferramentas.
 * HTML, TSX, JSX e Vue passam por contraste, nome e estado vazio. CSS passa por tokens e foco.
 */
export function collectDesignFindings(
  files: readonly DesignSourceFile[],
  tools?: DesignToolReports,
): DesignRawFinding[] {
  const findings: DesignRawFinding[] = [];
  for (const file of files) {
    if (MARKUP.test(file.path)) {
      findings.push(...staticHtmlFindings(file.path, file.text));
      findings.push(...missingEmptyStateFindings(file.path, file.text));
    }
    if (STYLE.test(file.path)) {
      findings.push(...inventoryFindingsFromCss(file.path, file.text));
      findings.push(...focusFindingsFromCss(file.path, file.text));
    }
  }
  for (const entry of tools?.axe ?? []) findings.push(...axeToFindings(entry.file, entry.json));
  for (const entry of tools?.pa11y ?? []) findings.push(...pa11yToFindings(entry.file, entry.json));
  for (const entry of tools?.lighthouse ?? []) findings.push(...lighthouseToFindings(entry.file, entry.lhr));
  for (const entry of tools?.stylelint ?? []) findings.push(...stylelintToFindings(entry.file, entry.report));
  for (const entry of tools?.cssAnalyzer ?? []) findings.push(...wallaceFindings(entry.file, entry.report));
  for (const entry of tools?.keyboard ?? []) findings.push(...keyboardFindings(entry.file, entry.steps));
  // Uma chamada só: a regra do título compara as rotas entre si.
  if (tools?.render !== undefined && tools.render.length > 0) findings.push(...renderFindings(tools.render));
  return dedupeDesignFindings(findings);
}

/** Documento único que a imagem e o relatório gravam como achados-brutos.json. */
export function designRawDocument(target: string, findings: readonly DesignRawFinding[]): {
  schema: typeof DESIGN_RAW_SCHEMA;
  target: string;
  findings: DesignRawFinding[];
} {
  return {
    schema: DESIGN_RAW_SCHEMA,
    target,
    findings: [...findings],
  };
}
