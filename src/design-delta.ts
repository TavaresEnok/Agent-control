import {designFingerprint, type DesignRawFinding} from './design-types.ts';
import {wallaceDeltaFiles} from './design-wallace.ts';

/** Só ferramentas que dão o mesmo resultado na mesma tela. O modelo fica de fora. */
export const DESIGN_DELTA_TOOLS: readonly string[] = [
  'axe', 'pa11y', 'lighthouse', 'stylelint', 'css-analyzer', 'tokens', 'inventario',
  'teclado', 'régua', 'html', 'tokens-projeto', 'consistencia', 'navegacao',
];

const MAX_LISTED = 20;

/** Rodada vista pela comparação. `tools` são as ferramentas que rodaram; sem a lista, vale quem teve achado. */
export type DesignDeltaRun = {
  findings: readonly DesignRawFinding[];
  tools?: readonly string[] | null;
};

export type DesignDeltaItem = {tool: string; rule: string; file: string; line: number | null};

export type DesignDelta = {
  novos: DesignDeltaItem[];
  ausentes: DesignDeltaItem[];
  mantidos: DesignDeltaItem[];
  notCompared: string[];
};

/** Chave do achado entre rodadas: ferramenta, regra, arquivo e linha. Trecho e medida ficam fora. */
export function deltaKey(finding: Pick<DesignRawFinding, 'tool' | 'rule' | 'file' | 'line'>): string {
  return designFingerprint([finding.tool, finding.rule, finding.file, String(finding.line ?? '')]);
}

function ranTools(run: DesignDeltaRun): Set<string> {
  const tools = new Set<string>();
  for (const finding of run.findings) tools.add(finding.tool);
  for (const tool of run.tools ?? []) tools.add(tool);
  return tools;
}

function byKey(findings: readonly DesignRawFinding[], tools: ReadonlySet<string>): Map<string, DesignDeltaItem> {
  const map = new Map<string, DesignDeltaItem>();
  for (const finding of findings) {
    if (!tools.has(finding.tool)) continue;
    // O achado do css-analyzer agrupado vale por cada rota que cobre, como as medições soltas de antes.
    for (const file of wallaceDeltaFiles(finding)) {
      const key = deltaKey({...finding, file});
      if (!map.has(key)) map.set(key, {tool: finding.tool, rule: finding.rule, file, line: finding.line});
    }
  }
  return map;
}

/** Compara duas rodadas. Ferramenta que faltou em uma delas não entra na conta e vai para `notCompared`. */
export function compareDesignRuns(previous: DesignDeltaRun, current: DesignDeltaRun): DesignDelta {
  const before = ranTools(previous);
  const now = ranTools(current);
  const deterministic = new Set(DESIGN_DELTA_TOOLS);
  const compared = new Set([...before].filter(tool => deterministic.has(tool) && now.has(tool)));
  const notCompared = [...new Set([...before, ...now])]
    .filter(tool => deterministic.has(tool) && !compared.has(tool))
    .sort((a, b) => a.localeCompare(b));
  const old = byKey(previous.findings, compared);
  const fresh = byKey(current.findings, compared);
  const novos: DesignDeltaItem[] = [];
  const mantidos: DesignDeltaItem[] = [];
  for (const [key, item] of fresh) (old.has(key) ? mantidos : novos).push(item);
  const ausentes = [...old].filter(([key]) => !fresh.has(key)).map(([, item]) => item);
  return {novos, ausentes, mantidos, notCompared};
}

function itemLine(item: DesignDeltaItem): string {
  const where = item.line === null ? item.file : `${item.file}:${item.line}`;
  return `- ${item.tool} ${item.rule} em ${where}`.replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 300);
}

function listed(title: string, items: readonly DesignDeltaItem[]): string[] {
  if (items.length === 0) return [];
  const lines = items.slice(0, MAX_LISTED).map(itemLine);
  if (items.length > MAX_LISTED) lines.push(`- e mais ${items.length - MAX_LISTED}.`);
  return ['', `${title}:`, ...lines];
}

/**
 * Texto da seção 'Desde o último relatório'.
 * `previous` null: o relatório anterior não pôde ser lido. `previousName` null: primeira rodada.
 */
export function deltaMarkdown(previous: (DesignDeltaRun & {directoryName: string | null}) | null, current: DesignDeltaRun): string {
  if (previous === null) return 'O relatório anterior não pôde ser lido. A comparação não foi feita.';
  if (previous.directoryName === null) return 'Primeira rodada deste projeto.';
  const delta = compareDesignRuns(previous, current);
  return [
    `Comparado com \`${previous.directoryName}\`. A chave é ferramenta, regra, arquivo e linha. Só entram ferramentas que medem.`,
    'Não apareceu não quer dizer fechado: a tela, a rota ou o plano pode ter mudado. Só a reverificação fecha um achado.',
    '',
    `- Novos: ${delta.novos.length}`,
    `- Não apareceram: ${delta.ausentes.length}`,
    `- Mantidos: ${delta.mantidos.length}`,
    ...(delta.notCompared.length > 0 ? ['', `Ferramentas não comparadas, porque faltaram em uma das rodadas: ${delta.notCompared.join(', ')}.`] : []),
    ...listed('Novos', delta.novos),
    ...listed('Não apareceram', delta.ausentes),
  ].join('\n');
}
