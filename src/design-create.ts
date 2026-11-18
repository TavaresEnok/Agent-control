import {chmod, mkdir, open, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {Refusal} from './contracts.ts';
import type {DesignRawFinding, DesignWorker} from './design-types.ts';
import {DesignWorkerCall} from './design-types.ts';

const SCREEN_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export type CreatedScreen = {name: string; html: string; css: string};

export type CreateBundle = {tokens: Record<string, unknown>; screens: CreatedScreen[]};

export type CreateRound = {round: number; approved: string[]; rejected: string[]; notes: string[]};

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Tira script externo e base64. O HTML gerado só é aberto no navegador do exame. */
export function stripGeneratedHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\ssrc\s*=\s*(["'])https?:\/\/[^"']+\1/gi, '')
    .replace(/data:[^"'\s)]+;base64,[A-Za-z0-9+/=]+/gi, '');
}

export function parseCreateBundle(value: unknown, screens: number): CreateBundle | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as {tokens?: unknown; screens?: unknown};
  if (!row.tokens || typeof row.tokens !== 'object' || Array.isArray(row.tokens)) return null;
  if (!Array.isArray(row.screens)) return null;
  const parsed: CreatedScreen[] = [];
  for (const item of row.screens) {
    if (!item || typeof item !== 'object') return null;
    const screen = item as {name?: unknown; html?: unknown; css?: unknown};
    const name = text(screen.name, 40).toLowerCase();
    const html = stripGeneratedHtml(text(screen.html, 200_000));
    const css = text(screen.css, 200_000).replace(/data:[^"'\s)]+;base64,[A-Za-z0-9+/=]+/gi, '');
    if (!SCREEN_NAME.test(name) || !html.includes('<') || css.length === 0) return null;
    parsed.push({name, html, css});
    if (parsed.length >= screens) break;
  }
  if (parsed.length !== screens) return null;
  return {tokens: row.tokens as Record<string, unknown>, screens: parsed};
}

function createTask(input: {briefing: string; screens: number; round: number; findings: readonly DesignRawFinding[]; referenceNote: string}): string {
  const lines = [
    'Pedido de criação.',
    'Responda só um JSON com kind "criacao", tokens (DTCG) e screens.',
    `screens tem ${input.screens} itens. Cada item tem name, html e css.`,
    'O HTML é autossuficiente, com fonte por <link>, sem base64 e sem JavaScript externo.',
    `Rodada: ${input.round}`,
    'Briefing:',
    input.briefing.slice(0, 8000),
  ];
  if (input.referenceNote.trim().length > 0) lines.push(input.referenceNote.slice(0, 2000));
  if (input.findings.length > 0) {
    lines.push('Achados para corrigir:');
    for (const finding of input.findings.slice(0, 40)) {
      lines.push(`- ${finding.rule} ${finding.severity} ${finding.snippet}`.slice(0, 300));
    }
  }
  return lines.join('\n').slice(0, 100000);
}

async function writePrivate(path: string, body: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(body);
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

function outsideRepository(directory: string, repository: string): void {
  const rel = relative(resolve(repository), resolve(directory));
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..`))) {
    if (!rel.startsWith('..')) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  }
}

/**
 * Gera telas fora do repositório e devolve cada rodada para o exame injetado.
 * O modelo de produção é claude-opus-5-5 com esforço medium, forçado no worker.
 */
export async function runDesignCreate(input: {
  dataDirectory: string;
  runId: string;
  repository: string;
  briefing: string;
  screens: number;
  rounds: number;
  referenceNote: string;
  worker: DesignWorker;
  reserve: () => Promise<{provider: string; accountId: string; profileId: string; model: string; grantId: string}>;
  release: (seat: {provider: string; accountId: string; profileId: string; model: string; grantId: string}) => Promise<void>;
  intentId: string;
  examine(round: number, files: readonly {path: string; text: string}[]): Promise<{high: boolean; belowVisual8: boolean; findings: DesignRawFinding[]; notes: string[]}>;
}): Promise<{directory: string; rounds: CreateRound[]; indexPath: string}> {
  if (input.screens < 1 || input.screens > 8 || input.rounds < 1 || input.rounds > 5) throw new Refusal('DESIGN_CREATE_INVALID', 400);
  const root = join(input.dataDirectory, 'design-criacoes', input.runId);
  outsideRepository(root, input.repository);
  await mkdir(root, {recursive: true, mode: 0o700});
  const rounds: CreateRound[] = [];
  let pending: DesignRawFinding[] = [];
  let lastScreens: CreatedScreen[] = [];
  for (let round = 1; round <= input.rounds; round += 1) {
    const seat = await input.reserve();
    let output = '';
    try {
      const call = DesignWorkerCall.parse({
        role: 'specialist',
        provider: seat.provider,
        accountId: seat.accountId,
        profileId: seat.profileId,
        model: seat.model,
        grantId: seat.grantId,
        intentId: input.intentId,
        task: createTask({briefing: input.briefing, screens: input.screens, round, findings: pending, referenceNote: input.referenceNote}),
        repo: input.repository,
        writePaths: [],
        forcedModel: 'claude-opus-5-5',
        forcedEffort: 'medium',
      });
      output = await input.worker.run(call);
    } finally {
      await input.release(seat);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(output) as unknown;
    } catch {
      parsed = null;
    }
    const bundle = parseCreateBundle(parsed, input.screens);
    if (!bundle) throw new Refusal('DESIGN_CREATE_INVALID', 400);
    const roundDir = join(root, `rodada-${round}`);
    await mkdir(roundDir, {mode: 0o700});
    await writePrivate(join(roundDir, 'tokens.json'), `${JSON.stringify(bundle.tokens, null, 2)}\n`);
    const files: {path: string; text: string}[] = [];
    for (const screen of bundle.screens) {
      const htmlName = `${screen.name}.html`;
      const cssName = `${screen.name}.css`;
      const html = screen.html.includes(cssName) ? screen.html : screen.html.replace('</head>', `<link rel="stylesheet" href="${cssName}"></head>`);
      await writePrivate(join(roundDir, htmlName), html);
      await writePrivate(join(roundDir, cssName), screen.css);
      files.push({path: htmlName, text: html}, {path: cssName, text: screen.css});
    }
    const examined = await input.examine(round, files);
    const rejected = examined.high || examined.belowVisual8 ? bundle.screens.map(screen => screen.name) : [];
    const approved = rejected.length === 0 ? bundle.screens.map(screen => screen.name) : [];
    rounds.push({round, approved, rejected, notes: examined.notes});
    lastScreens = bundle.screens;
    pending = examined.findings;
    if (approved.length > 0) break;
  }
  const index = [
    '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Vitrine</title></head><body>',
    '<h1>Vitrine</h1>',
    ...rounds.map(round => `<section><h2>Rodada ${round.round}</h2><p>Aprovadas: ${round.approved.join(', ') || 'nenhuma'}. Rejeitadas: ${round.rejected.join(', ') || 'nenhuma'}.</p></section>`),
    ...lastScreens.map(screen => `<p><a href="rodada-${rounds.at(-1)?.round ?? 1}/${screen.name}.html">${screen.name}</a></p>`),
    '</body></html>',
  ].join('\n');
  const indexPath = join(root, 'index.html');
  await writeFile(indexPath, index, {mode: 0o600});
  await chmod(indexPath, 0o600);
  await chmod(root, 0o700);
  return {directory: root, rounds, indexPath};
}
