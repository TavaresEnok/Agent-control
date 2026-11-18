import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {constants} from 'node:fs';
import {mkdirSync} from 'node:fs';
import {chmod, mkdir, open, readdir, readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Refusal} from './contracts.ts';

const require = createRequire(import.meta.url);
const tools = join(dirname(fileURLToPath(import.meta.url)), '../deploy/design-tools/node_modules');

type Png = {width: number; height: number; data: Uint8Array};

type PngModule = {PNG: {sync: {read: (buffer: Buffer) => Png; write: (png: Png) => Buffer}; new (input: {width: number; height: number}): Png}};

function pngjs(): PngModule {
  return require(join(tools, 'pngjs')) as PngModule;
}

function pixelmatch(): (left: Uint8Array, right: Uint8Array, diff: Uint8Array | null, width: number, height: number, options: {threshold: number}) => number {
  const loaded = require(join(tools, 'pixelmatch')) as {default?: unknown};
  const fn = typeof loaded === 'function' ? loaded : loaded.default;
  if (typeof fn !== 'function') throw new Error('PIXELMATCH_AUSENTE');
  return fn as (left: Uint8Array, right: Uint8Array, diff: Uint8Array | null, width: number, height: number, options: {threshold: number}) => number;
}

export type RegressionHit = {
  fileName: string;
  percent: number;
  changed: boolean;
  diffFileName: string | null;
  note: string;
};

/**
 * Compara capturas com a baseline usando pixelmatch.
 * `threshold` é o limiar de cor do pixelmatch, padrão 0,1. Porcentagem é de pixels diferentes.
 */
export function comparePngBuffers(baseline: Buffer, current: Buffer, threshold: number): {percent: number; diff: Buffer | null; note: string} {
  const png = pngjs();
  const left = png.PNG.sync.read(baseline);
  const right = png.PNG.sync.read(current);
  if (left.width !== right.width || left.height !== right.height) {
    return {percent: 100, diff: null, note: `tamanhos ${left.width}x${left.height} e ${right.width}x${right.height}`};
  }
  const diff = new png.PNG({width: left.width, height: left.height});
  const mismatched = pixelmatch()(left.data, right.data, diff.data, left.width, left.height, {threshold});
  const total = left.width * left.height;
  const percent = total === 0 ? 0 : Math.round((mismatched / total) * 10000) / 100;
  return {percent, diff: Buffer.from(png.PNG.sync.write(diff)), note: `${mismatched} pixels`};
}

export function regressionHits(input: {
  pairs: readonly {fileName: string; baseline: Buffer | null; current: Buffer}[];
  threshold: number;
}): RegressionHit[] {
  return input.pairs.map(pair => {
    if (pair.baseline === null) {
      return {fileName: pair.fileName, percent: 0, changed: false, diffFileName: null, note: 'sem baseline'};
    }
    try {
      const compared = comparePngBuffers(pair.baseline, pair.current, input.threshold);
      const changed = compared.percent > 0;
      return {
        fileName: pair.fileName,
        percent: compared.percent,
        changed,
        diffFileName: changed && compared.diff ? `diff-${pair.fileName}` : null,
        note: compared.note,
        ...(compared.diff ? {diff: compared.diff} : {}),
      };
    } catch (error) {
      return {
        fileName: pair.fileName,
        percent: 100,
        changed: true,
        diffFileName: null,
        note: error instanceof Error ? error.message.slice(0, 160) : 'falha',
      };
    }
  });
}

export function regressionMarkdown(hits: readonly RegressionHit[]): string {
  const lines = ['## Regressão visual', ''];
  if (hits.length === 0 || hits.every(hit => hit.note === 'sem baseline')) {
    lines.push('Sem baseline aprovada. Nada foi comparado.');
    return lines.join('\n');
  }
  const changed = hits.filter(hit => hit.changed);
  lines.push(changed.length === 0 ? 'Nenhuma tela mudou em relação à baseline.' : `${changed.length} telas mudaram.`);
  for (const hit of hits) {
    lines.push(`- ${hit.fileName}: ${hit.changed ? 'mudou' : 'igual'} (${hit.percent}% ) ${hit.note}${hit.diffFileName ? ` diferença ${hit.diffFileName}` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const BASELINE_PNG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,140}\.png$/;

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, {recursive: true, mode: 0o700});
}

/** `/a-b` e `/a/b` produzem nomes diferentes: 8 hex de sha256 da rota entram no arquivo. */
export function baselineFileName(route: string, viewport: number, theme: string, state: string): string {
  const hash = createHash('sha256').update(route).digest('hex').slice(0, 8);
  const part = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 24);
  const view = Number.isSafeInteger(viewport) ? String(Math.trunc(Math.abs(viewport))).slice(0, 6) : '0';
  return `r${hash}-${view || '0'}-${part(theme) || 'tema'}-${part(state) || 'estado'}.png`;
}

export async function approveDesignBaseline(input: {
  dataDirectory: string;
  projectId: string;
  captures: readonly {fileName: string; bytes: Buffer}[];
}): Promise<string> {
  if (!PROJECT_ID.test(input.projectId)) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  const directory = join(input.dataDirectory, 'design-baseline', input.projectId);
  await mkdir(directory, {recursive: true, mode: 0o700});
  for (const capture of input.captures) {
    if (!BASELINE_PNG.test(capture.fileName)) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    const path = join(directory, capture.fileName);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(capture.bytes);
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
  }
  await chmod(directory, 0o700);
  return directory;
}

export async function baselineBuffer(dataDirectory: string, projectId: string, fileName: string): Promise<Buffer | null> {
  if (!PROJECT_ID.test(projectId) || !BASELINE_PNG.test(fileName)) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  try {
    return await readFile(join(dataDirectory, 'design-baseline', projectId, fileName));
  } catch {
    return null;
  }
}

export async function listBaselineNames(dataDirectory: string, projectId: string): Promise<string[]> {
  try {
    const names = await readdir(join(dataDirectory, 'design-baseline', projectId));
    return names.filter(name => name.endsWith('.png'));
  } catch {
    return [];
  }
}
