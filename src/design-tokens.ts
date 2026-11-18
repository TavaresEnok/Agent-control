import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {apcaLc, compositeRgb, deltaE2000, parseCssColor, wcagContrast, type Rgb} from './design-color.ts';
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
  /** Fundo com imagem ou gradiente: o contraste não entra como achado. */
  contrastNote?: string;
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
  elevation: string[];
  colorSteps: number[];
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
    contrastUnmeasured: number;
    palette: {stepsByHue: number[]; hasRamp: boolean; referenceSteps: number};
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
      const elevation = Array.isArray(parsed.elevation) ? parsed.elevation.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
      const colorSteps = Array.isArray(parsed.colorSteps) ? parsed.colorSteps.filter((item): item is number => typeof item === 'number' && item > 0) : [];
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
        elevation,
        colorSteps,
        targetMinPx: typeof parsed.targetMinPx === 'number' ? parsed.targetMinPx : null,
      });
    } catch {
      /* arquivo ilegível não entra na comparação */
    }
  }
  return scales;
}

function meanRelative(sample: readonly number[], scale: readonly number[]): number | null {
  if (sample.length === 0 || scale.length === 0) return null;
  const deltas = sample.map(size => Math.min(...scale.map(item => Math.abs(item - size) / Math.max(item, 1))));
  return deltas.reduce((sum, item) => sum + item, 0) / deltas.length;
}

/**
 * A distância é a média só dos campos que os dois lados têm.
 * Referência com menos de dois campos comparáveis fica fora da disputa.
 */
function nearestScale(
  sizes: number[],
  spaces: number[],
  radii: number[],
  references: readonly DesignReferenceScale[],
): TokenAnalysis['nearest'] {
  if (references.length === 0) return {id: 'nenhuma', name: 'nenhuma', distance: 1, notes: ['Não há referência versionada.']};
  let best: DesignReferenceScale | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  const notesOf = new Map<string, string[]>();
  for (const reference of references) {
    const notes: string[] = [];
    const parts: number[] = [];
    const typeDistance = meanRelative(sizes, reference.typePx);
    if (typeDistance !== null) {
      parts.push(typeDistance);
      if (sizes.length > reference.typePx.length + 2) notes.push(`${sizes.length} tamanhos contra ${reference.typePx.length} de ${reference.name}.`);
    }
    if (spaces.length > 0 && reference.spacePx.length > 0) {
      const off = spaces.filter(space => !reference.spacePx.some(item => Math.abs(item - space) < 0.5));
      parts.push(off.length / spaces.length);
      if (off.length > 0) notes.push(`${off.length} espaçamentos fora da escala de ${reference.name}.`);
    }
    const radiusDistance = meanRelative(radii, reference.radiusPx);
    if (radiusDistance !== null) parts.push(Math.min(1, radiusDistance));
    if (parts.length < 2) continue;
    const distance = parts.reduce((sum, item) => sum + item, 0) / parts.length;
    notesOf.set(reference.id, notes);
    if (distance < bestDistance) {
      best = reference;
      bestDistance = distance;
    }
  }
  if (best === undefined) return {id: 'nenhuma', name: 'nenhuma', distance: 1, notes: ['Nenhuma referência tem dois campos comparáveis.']};
  return {
    id: best.id,
    name: best.name,
    distance: Math.round(bestDistance * 1000) / 1000,
    notes: notesOf.get(best.id) ?? [],
  };
}

function hueBucket(rgb: Rgb): number | null {
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  if (max - min <= 18 || max === 0) return null;
  const delta = max - min;
  let hue = 0;
  if (max === rgb.r) hue = ((rgb.g - rgb.b) / delta) % 6;
  else if (max === rgb.g) hue = (rgb.b - rgb.r) / delta + 2;
  else hue = (rgb.r - rgb.g) / delta + 4;
  const degrees = Math.round((hue * 60 + 360) % 360 / 30) * 30;
  return degrees === 360 ? 0 : degrees;
}

function paletteOf(colors: readonly Rgb[], references: readonly DesignReferenceScale[]): TokenAnalysis['summary']['palette'] {
  const referenceSteps = Math.max(0, ...references.map(item => item.colorSteps.length));
  const byHue = new Map<number, Set<number>>();
  for (const rgb of colors) {
    const hue = hueBucket(rgb);
    if (hue === null) continue;
    const light = Math.round(((Math.max(rgb.r, rgb.g, rgb.b) + Math.min(rgb.r, rgb.g, rgb.b)) / 2 / 255) * 20) / 20;
    const bucket = byHue.get(hue) ?? new Set<number>();
    bucket.add(light);
    byHue.set(hue, bucket);
  }
  const stepsByHue = [...byHue.values()].map(bucket => bucket.size).sort((a, b) => b - a);
  const rampFloor = referenceSteps > 0 ? Math.max(4, Math.ceil(referenceSteps / 2)) : 4;
  return {stepsByHue, hasRamp: stepsByHue.some(steps => steps >= rampFloor), referenceSteps};
}

function contrastSample(sample: ComputedStyleSample): {ratio: number; apca: number} | 'unmeasured' | null {
  if (sample.contrastNote === 'nao-medido') return 'unmeasured';
  const text = parseCssColor(sample.color);
  const background = parseCssColor(sample.backgroundColor);
  if (!text || !background) return null;
  const textAlpha = text.a ?? 1;
  const backgroundAlpha = background.a ?? 1;
  if (textAlpha <= 0) return null;
  if (backgroundAlpha < 0.999) return 'unmeasured';
  const flat = textAlpha < 0.999 ? compositeRgb(text, background) : text;
  const ratio = wcagContrast(flat, background);
  if (!Number.isFinite(ratio)) return null;
  return {ratio: Math.round(ratio * 100) / 100, apca: Math.round(apcaLc(flat, background) * 10) / 10};
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
  let contrastUnmeasured = 0;
  const targets: number[] = [];
  const targets24: number[] = [];
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
    const contrast = contrastSample(sample);
    if (contrast === 'unmeasured') contrastUnmeasured += 1;
    else if (contrast) contrasts.push(contrast);
    const width = pxOf(sample.width);
    const height = pxOf(sample.height);
    const control = sample.selector === 'button' || sample.selector === 'a' || sample.selector === 'input';
    if (control && width !== null && height !== null && width >= 8 && height >= 8) {
      const size = Math.min(width, height);
      if (size < 44) targets.push(size);
      if (size < 24) targets24.push(size);
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
  const tinyTarget = targets24.sort((a, b) => a - b)[0];
  if (tinyTarget !== undefined) {
    findings.push(designRawFinding({
      tool: 'tokens',
      rule: 'DESIGN-ALVO-24',
      file,
      severity: 'alta',
      snippet: `alvo ${tinyTarget}px abaixo de 24px`,
      measure: {kind: 'target', px: tinyTarget},
    }));
  }
  const palette = paletteOf(colors, references);
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
    nearest: nearestScale(fontSizes, spaceList, radiusList, references),
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
      contrastUnmeasured,
      palette,
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
    `Contraste não medido: ${analysis.summary.contrastUnmeasured}.`,
    `Paleta: ${analysis.summary.palette.stepsByHue.join(', ') || '0'} passos por matiz. Rampa: ${analysis.summary.palette.hasRamp ? 'sim' : 'não'}. Passos da referência: ${analysis.summary.palette.referenceSteps}.`,
    `A escala mais próxima é ${analysis.nearest.name} (distância ${analysis.nearest.distance}).`,
    ...analysis.nearest.notes.map(note => `- ${note}`),
    '',
  ];
  return lines.join('\n');
}
