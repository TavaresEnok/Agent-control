import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {apcaLc, deltaE2000, parseCssColor, wcagContrast, type Rgb} from './design-color.ts';
import {DESIGN_PLANTED_RULES, designRawFinding, type DesignRawFinding} from './design-types.ts';

export type ComputedStyleSample = {
  selector?: string;
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  margin?: string;
  padding?: string;
  gap?: string;
  borderRadius?: string;
  boxShadow?: string;
  transitionDuration?: string;
  width?: string;
  height?: string;
};

export type DesignReferenceScale = {
  id: string;
  name: string;
  source: string;
  url: string;
  consulted: string;
  typePx: number[];
  spacePx: number[];
  radiusPx: number[];
  targetMinPx: number | null;
};

export type TokenAnalysis = {
  document: Record<string, unknown>;
  findings: DesignRawFinding[];
  nearest: {id: string; name: string; distance: number; notes: string[]};
  summary: {
    fontSizes: number[];
    families: string[];
    spaces: number[];
    offScale: number[];
    grays: string[];
    nearGrays: number;
    accents: number;
    radii: number[];
    shadows: string[];
    durations: string[];
    contrasts: {ratio: number; apca: number}[];
  };
};

function pxOf(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(-?[\d.]+)px$/.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

function numbersIn(value: string | undefined): number[] {
  if (!value || value === 'normal' || value === 'none') return [];
  return [...value.matchAll(/(-?[\d.]+)px/g)].map(match => Number(match[1])).filter(number => Number.isFinite(number) && number > 0);
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.map(value => Math.round(value * 100) / 100))].sort((a, b) => a - b);
}

function familyName(value: string | undefined): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? '';
  if (first.length === 0 || first.length > 80) return null;
  return first;
}

function isGray(rgb: Rgb): boolean {
  return Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b) <= 12
    && Math.max(rgb.r, rgb.g, rgb.b) > 16
    && Math.min(rgb.r, rgb.g, rgb.b) < 245;
}

function hex(rgb: Rgb): string {
  const part = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

function tokenGroup(type: string, values: readonly {name: string; value: string | number}[]): Record<string, unknown> {
  const group: Record<string, unknown> = {};
  values.forEach((item, index) => {
    group[`${index}`] = {$type: type, $value: item.value, $description: item.name};
  });
  return group;
}

export function loadDesignReferences(directory: string): DesignReferenceScale[] {
  let names: string[] = [];
  try {
    names = readdirSync(directory).filter(name => name.endsWith('.json'));
  } catch {
    return [];
  }
  const scales: DesignReferenceScale[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(directory, name), 'utf8')) as Record<string, unknown>;
      const typePx = Array.isArray(parsed.typePx) ? parsed.typePx.filter((item): item is number => typeof item === 'number' && item > 0) : [];
      const spacePx = Array.isArray(parsed.spacePx) ? parsed.spacePx.filter((item): item is number => typeof item === 'number' && item > 0) : [];
      const radiusPx = Array.isArray(parsed.radiusPx) ? parsed.radiusPx.filter((item): item is number => typeof item === 'number' && item >= 0) : [];
      if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string') continue;
      scales.push({
        id: parsed.id,
        name: parsed.name,
        source: typeof parsed.source === 'string' ? parsed.source : parsed.name,
        url: typeof parsed.url === 'string' ? parsed.url : '',
        consulted: typeof parsed.consulted === 'string' ? parsed.consulted : '',
        typePx,
        spacePx,
        radiusPx,
        targetMinPx: typeof parsed.targetMinPx === 'number' ? parsed.targetMinPx : null,
      });
    } catch {
      /* arquivo ilegível não entra na comparação */
    }
  }
  return scales;
}

function nearestScale(sizes: number[], spaces: number[], references: readonly DesignReferenceScale[]): TokenAnalysis['nearest'] {
  if (references.length === 0) return {id: 'nenhuma', name: 'nenhuma', distance: 1, notes: ['Não há referência versionada.']};
  let best = references[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  const notesOf = new Map<string, string[]>();
  for (const reference of references) {
    const notes: string[] = [];
    let distance = 0;
    if (sizes.length > 0 && reference.typePx.length > 0) {
      const deltas = sizes.map(size => Math.min(...reference.typePx.map(item => Math.abs(item - size) / item)));
      distance += deltas.reduce((sum, item) => sum + item, 0) / deltas.length;
      if (sizes.length > reference.typePx.length + 2) notes.push(`${sizes.length} tamanhos contra ${reference.typePx.length} de ${reference.name}.`);
    } else distance += 0.5;
    if (spaces.length > 0 && reference.spacePx.length > 0) {
      const off = spaces.filter(space => !reference.spacePx.some(item => Math.abs(item - space) < 0.5));
      distance += off.length / spaces.length;
      if (off.length > 0) notes.push(`${off.length} espaçamentos fora da escala de ${reference.name}.`);
    }
    notesOf.set(reference.id, notes);
    if (distance < bestDistance) {
      best = reference;
      bestDistance = distance;
    }
  }
  const chosen = best ?? references[0];
  return {
    id: chosen.id,
    name: chosen.name,
    distance: Number.isFinite(bestDistance) ? Math.round(bestDistance * 1000) / 1000 : 1,
    notes: notesOf.get(chosen.id) ?? [],
  };
}

export function analyzeDesignTokens(file: string, samples: readonly ComputedStyleSample[], references: readonly DesignReferenceScale[]): TokenAnalysis {
  const sizes: number[] = [];
  const families: string[] = [];
  const weights: number[] = [];
  const lineHeights: number[] = [];
  const spaces: number[] = [];
  const radii: number[] = [];
  const shadows: string[] = [];
  const durations: string[] = [];
  const colors: Rgb[] = [];
  const contrasts: {ratio: number; apca: number}[] = [];
  const targets: number[] = [];
  for (const sample of samples) {
    const size = pxOf(sample.fontSize);
    if (size !== null && size > 0) sizes.push(size);
    const family = familyName(sample.fontFamily);
    if (family) families.push(family);
    const weight = Number(sample.fontWeight);
    if (Number.isFinite(weight) && weight > 0) weights.push(weight);
    const line = pxOf(sample.lineHeight);
    if (line !== null) lineHeights.push(line);
    spaces.push(...numbersIn(sample.margin), ...numbersIn(sample.padding), ...numbersIn(sample.gap));
    radii.push(...numbersIn(sample.borderRadius));
    if (sample.boxShadow && sample.boxShadow !== 'none') shadows.push(sample.boxShadow.trim());
    if (sample.transitionDuration && sample.transitionDuration !== '0s') durations.push(sample.transitionDuration.trim());
    for (const key of [sample.color, sample.backgroundColor, sample.borderColor]) {
      const parsed = parseCssColor(key);
      if (parsed) colors.push(parsed);
    }
    const text = parseCssColor(sample.color);
    const background = parseCssColor(sample.backgroundColor);
    if (text && background) {
      const ratio = wcagContrast(text, background);
      if (Number.isFinite(ratio)) contrasts.push({ratio: Math.round(ratio * 100) / 100, apca: Math.round(apcaLc(text, background) * 10) / 10});
    }
    const width = pxOf(sample.width);
    const height = pxOf(sample.height);
    const control = sample.selector === 'button' || sample.selector === 'a' || sample.selector === 'input';
    if (control && width !== null && height !== null && width >= 16 && width < 44 && height >= 16 && height < 44) {
      targets.push(Math.min(width, height));
    }
  }
  const fontSizes = uniqueSorted(sizes);
  const familyList = [...new Set(families)];
  const spaceList = uniqueSorted(spaces);
  const offScale = spaceList.filter(value => Math.abs(value / 4 - Math.round(value / 4)) > 0.01);
  const grayList = [...new Set(colors.filter(isGray).map(hex))];
  let nearGrays = 0;
  const grayRgb = colors.filter(isGray);
  const used = new Set<number>();
  for (let left = 0; left < grayRgb.length; left += 1) {
    for (let right = left + 1; right < grayRgb.length; right += 1) {
      const first = grayRgb[left];
      const second = grayRgb[right];
      if (!first || !second) continue;
      if (deltaE2000(first, second) < 3) {
        if (!used.has(left)) nearGrays += 1;
        if (!used.has(right)) nearGrays += 1;
        used.add(left);
        used.add(right);
      }
    }
  }
  const accents = [...new Set(colors.filter(rgb => !isGray(rgb) && Math.max(rgb.r, rgb.g, rgb.b) > 40 && Math.min(rgb.r, rgb.g, rgb.b) < 250).map(hex))].length;
  const radiusList = uniqueSorted(radii);
  const shadowList = [...new Set(shadows)].slice(0, 40);
  const durationList = [...new Set(durations)].slice(0, 40);
  const findings: DesignRawFinding[] = [];
  if (fontSizes.length > 8) {
    findings.push(designRawFinding({
      tool: 'tokens',
      rule: 'DESIGN-TOKENS-TIPO-CONTAGEM',
      file,
      severity: 'alta',
      snippet: `${fontSizes.length} tamanhos: ${fontSizes.join(' ')}`.slice(0, 240),
      measure: {kind: 'token', px: fontSizes.length},
    }));
  }
  if (familyList.length > 3) {
    findings.push(designRawFinding({
      tool: 'tokens',
      rule: 'DESIGN-TOKENS-FAMILIAS',
      file,
      severity: 'alta',
      snippet: familyList.join(', ').slice(0, 240),
      measure: {kind: 'token', px: familyList.length},
    }));
  }
  if (offScale.length >= 4) {
    findings.push(designRawFinding({
      tool: 'tokens',
      rule: DESIGN_PLANTED_RULES.spacing,
      file,
      severity: 'media',
      snippet: offScale.join(' ').slice(0, 240),
    }));
  }
  if (nearGrays >= 8) {
    findings.push(designRawFinding({
      tool: 'tokens',
      rule: DESIGN_PLANTED_RULES.grays,
      file,
      severity: 'alta',
      snippet: `${nearGrays} cinzas com ΔE2000 < 3: ${grayList.slice(0, 12).join(' ')}`.slice(0, 240),
      measure: {kind: 'token', px: nearGrays},
    }));
  }
  if (accents > 3) {
    findings.push(designRawFinding({
      tool: 'tokens',
      rule: 'DESIGN-TOKENS-ACENTOS',
      file,
      severity: 'media',
      snippet: `${accents} acentos`,
    }));
  }
  const weak = contrasts.find(item => item.ratio > 1 && item.ratio < 4.5);
  if (weak) {
    findings.push(designRawFinding({
      tool: 'tokens',
      rule: 'DESIGN-TOKENS-CONTRASTE',
      file,
      severity: 'alta',
      snippet: `razão ${weak.ratio} APCA ${weak.apca}`,
      measure: {kind: 'contrast', ratio: weak.ratio},
    }));
  }
  if (radiusList.length > 6) {
    findings.push(designRawFinding({
      tool: 'tokens',
      rule: 'DESIGN-TOKENS-RAIO-ESCALA',
      file,
      severity: 'media',
      snippet: radiusList.join(' ').slice(0, 240),
    }));
  }
  if (shadowList.length > 4) {
    findings.push(designRawFinding({
      tool: 'tokens',
      rule: 'DESIGN-TOKENS-SOMBRA-ESCALA',
      file,
      severity: 'media',
      snippet: `${shadowList.length} sombras`,
    }));
  }
  if (durationList.length > 4) {
    findings.push(designRawFinding({
      tool: 'tokens',
      rule: 'DESIGN-TOKENS-MOVIMENTO',
      file,
      severity: 'media',
      snippet: durationList.join(' ').slice(0, 240),
    }));
  }
  const smallTarget = targets.sort((a, b) => a - b)[0];
  if (smallTarget !== undefined) {
    findings.push(designRawFinding({
      tool: 'tokens',
      rule: 'DESIGN-ALVO-REFERENCIA',
      file,
      severity: 'alta',
      snippet: `alvo ${smallTarget}px abaixo de 44px`,
      measure: {kind: 'target', px: smallTarget},
    }));
  }
  const ratios: number[] = [];
  for (let index = 1; index < fontSizes.length; index += 1) {
    const previous = fontSizes[index - 1];
    const current = fontSizes[index];
    if (previous && current) ratios.push(Math.round((current / previous) * 100) / 100);
  }
  const document: Record<string, unknown> = {
    $schema: 'https://www.designtokens.org/schemas/2025.10/format.json',
    color: tokenGroup('color', [...new Set(colors.map(hex))].slice(0, 40).map((value, index) => ({name: `cor-${index}`, value}))),
    fontFamily: tokenGroup('fontFamily', familyList.map(value => ({name: value, value}))),
    fontSize: tokenGroup('dimension', fontSizes.map(value => ({name: `${value}`, value: `${value}px`}))),
    fontWeight: tokenGroup('fontWeight', uniqueSorted(weights).map(value => ({name: `${value}`, value}))),
    lineHeight: tokenGroup('dimension', uniqueSorted(lineHeights).map(value => ({name: `${value}`, value: `${value}px`}))),
    spacing: tokenGroup('dimension', spaceList.map(value => ({name: `${value}`, value: `${value}px`}))),
    radius: tokenGroup('dimension', radiusList.map(value => ({name: `${value}`, value: `${value}px`}))),
    shadow: tokenGroup('shadow', shadowList.map((value, index) => ({name: `sombra-${index}`, value}))),
    duration: tokenGroup('duration', durationList.map(value => ({name: value, value}))),
    scale: {typeRatio: ratios},
  };
  return {
    document,
    findings,
    nearest: nearestScale(fontSizes, spaceList, references),
    summary: {
      fontSizes,
      families: familyList,
      spaces: spaceList,
      offScale,
      grays: grayList,
      nearGrays,
      accents,
      radii: radiusList,
      shadows: shadowList,
      durations: durationList,
      contrasts: contrasts.slice(0, 20),
    },
  };
}

export function tokenReportMarkdown(analysis: TokenAnalysis): string {
  const lines = [
    '## Tokens',
    '',
    `Tamanhos: ${analysis.summary.fontSizes.join(', ') || 'nenhum'}.`,
    `Famílias: ${analysis.summary.families.join(', ') || 'nenhuma'}.`,
    `Espaçamentos fora da grade de 4px: ${analysis.summary.offScale.join(', ') || 'nenhum'}.`,
    `Cinzas quase iguais (ΔE2000 < 3): ${analysis.summary.nearGrays}.`,
    `Acentos: ${analysis.summary.accents}. Raios: ${analysis.summary.radii.join(', ') || 'nenhum'}.`,
    `A escala mais próxima é ${analysis.nearest.name} (distância ${analysis.nearest.distance}).`,
    ...analysis.nearest.notes.map(note => `- ${note}`),
    '',
  ];
  return lines.join('\n');
}
