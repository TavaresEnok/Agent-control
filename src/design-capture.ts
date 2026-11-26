import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Refusal} from './contracts.ts';
import {publicLoginRecord, type DesignLogin, type PublicLoginRecord} from './design-discover.ts';
import {isDesignStatePath, parseDesignActionStep, type DesignActionStep} from './design-project-config.ts';
import {DESIGN_VIEWPORTS, type DesignViewport} from './design-types.ts';

export type {DesignLogin, PublicLoginRecord};

export type DesignCaptureTheme = 'claro' | 'escuro';
export type DesignCaptureState = 'padrao' | 'vazio' | 'carregando' | 'erro' | 'logado';

/** Alcance que a captura aceita. Sem isto, estado diferente de padrao não abre URL. */
export type DesignCaptureReach =
  | {kind: 'url'; path: string}
  | {kind: 'acoes'; steps: string[]};

export type DesignCapturePlan = {
  screenId: string;
  route: string;
  viewport: DesignViewport;
  theme: DesignCaptureTheme;
  state: DesignCaptureState;
  fileName: string;
  reach?: DesignCaptureReach;
};

export type DesignCaptureScreen = {
  id: string;
  route: string;
  hasDarkTheme: boolean;
  forceStates: boolean;
  hasEmptyState?: boolean;
};

export type DesignEmptyStateStatus = 'capturado' | 'ausente' | 'nao-capturado';

export type DesignEmptyStateRecord = {
  screenId: string;
  route: string;
  status: DesignEmptyStateStatus;
};

/**
 * Alturas de janela para 375, 768 e 1440.
 * A captura pede a página inteira; a largura é que muda o layout.
 */
export const DESIGN_CAPTURE_HEIGHT: Record<DesignViewport, number> = {
  375: 812,
  768: 1024,
  1440: 900,
};

export const DESIGN_CAPTURE_METADATA_FILE = 'capturas.json';

const SAFE_PNG = /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/;

export type DesignCaptureDriver = {
  setViewport(width: number, height: number): Promise<void>;
  emulateMedia(theme: DesignCaptureTheme): Promise<void>;
  goto(url: string): Promise<void>;
  screenshot(fullPage: true): Promise<Buffer>;
  content(): Promise<string>;
  fill?(selector: string, value: string): Promise<void>;
  click?(selector: string): Promise<void>;
  submitLogin?(login: DesignLogin): Promise<void>;
  verifyAuthenticated?(url: string, login: DesignLogin, allowNavigation: boolean): Promise<void>;
  /** Opcional. Sem este método, `esperar` não vira captura. */
  waitForSelector?(selector: string): Promise<void>;
};

export type DesignCaptureRecord = {
  screenId: string;
  route: string;
  url: string;
  viewport: DesignViewport;
  theme: DesignCaptureTheme;
  state: DesignCaptureState;
  fileName: string;
  bytes: number;
};

export type DesignCaptureSkipReason = 'nao-e-html' | 'sem-alcance' | 'sem-espera' | 'sem-acao' | 'acao-invalida';

export type DesignCaptureSkip = {
  screenId: string;
  route: string;
  url: string;
  state: DesignCaptureState;
  reason: DesignCaptureSkipReason;
  body: string;
};

export type DesignCaptureMetadata = {
  captures: DesignCaptureRecord[];
  login?: PublicLoginRecord;
  skipped?: DesignCaptureSkip[];
  emptyStates: DesignEmptyStateRecord[];
};

export type DesignCaptureOptions = {
  login?: DesignLogin;
  loginUrl?: string;
};

/**
 * Sempre 375, 768 e 1440 no tema claro e no estado padrao.
 * Tema escuro só com hasDarkTheme. Estados vazio, carregando e erro só com forceStates.
 * hasEmptyState acrescenta o estado vazio, sem repetir o que forceStates já pede.
 * O produto é o cartesiano desses eixos. O nome do arquivo só tem caracteres seguros, termina em .png
 * e inclui 8 hex da rota para /a-b e /a/b não coincidirem.
 * forceStates não traz alcance: a captura não inventa ?estado=.
 */
export function planCaptures(screens: readonly DesignCaptureScreen[]): DesignCapturePlan[] {
  const used = new Set<string>();
  const plans: DesignCapturePlan[] = [];
  for (const screen of screens) {
    const themes: DesignCaptureTheme[] = screen.hasDarkTheme ? ['claro', 'escuro'] : ['claro'];
    const states: DesignCaptureState[] = screen.forceStates
      ? ['padrao', 'vazio', 'carregando', 'erro']
      : screen.hasEmptyState === true
        ? ['padrao', 'vazio']
        : ['padrao'];
    for (const theme of themes) {
      for (const state of states) {
        for (const viewport of DESIGN_VIEWPORTS) {
          plans.push({
            screenId: screen.id,
            route: screen.route,
            viewport,
            theme,
            state,
            fileName: allocateFileName(screen.id, screen.route, viewport, theme, state, used),
          });
        }
      }
    }
  }
  return plans;
}

/**
 * Captura cada plano em PNG de página inteira.
 * A URL é baseUrl + route. Estado diferente de padrao só navega se o plano trouxer alcance.
 * Login efêmero preenche os seletores e não grava a senha. O JSON usa publicLoginRecord.
 * Corpo JSON ou não-HTML não vira PNG: o plano fica em skipped.
 * Sem alcance, o estado fica em skipped e o vazio pedido fica nao-capturado.
 */
export async function captureScreens(
  driver: DesignCaptureDriver,
  baseUrl: string,
  plans: readonly DesignCapturePlan[],
  outputDir: string,
  options?: DesignCaptureOptions,
): Promise<DesignCaptureMetadata> {
  const login = options?.login;
  const revealed = publicLoginRecord(login);
  for (const plan of plans) assertSafeFileName(plan.fileName);
  if (login !== undefined && (driver.fill === undefined || driver.click === undefined)) {
    throw new Error('DRIVER_LOGIN_INCOMPLETO');
  }
  const root = resolve(outputDir);
  if (login !== undefined && driver.fill !== undefined && driver.click !== undefined) {
    try {
      await driver.goto(options?.loginUrl ?? baseUrl);
      await driver.fill(login.usernameSelector, login.username);
      await driver.fill(login.passwordSelector, login.password);
      if (driver.submitLogin === undefined) await driver.click(login.submitSelector);
      else await driver.submitLogin(login);
    } catch {
      throw new Refusal('DESIGN_CAPTURE_LOGIN_FAILED');
    }
  }
  const captures: DesignCaptureRecord[] = [];
  const skipped: DesignCaptureSkip[] = [];
  const files: {fileName: string; bytes: Buffer}[] = [];
  for (const plan of plans) {
    const prepared = preparePlan(driver, baseUrl, plan);
    if (!prepared.ok) {
      skipped.push({
        screenId: plan.screenId,
        route: plan.route,
        url: prepared.url,
        state: plan.state,
        reason: prepared.reason,
        body: '',
      });
      continue;
    }
    await driver.setViewport(plan.viewport, DESIGN_CAPTURE_HEIGHT[plan.viewport]);
    await driver.emulateMedia(plan.theme);
    await driver.goto(prepared.url);
    if (login !== undefined) await driver.verifyAuthenticated?.(prepared.url, login, false);
    const allowNavigation = (prepared.steps?.length ?? 0) > 0;
    try {
      await runSteps(driver, prepared.steps);
    } finally {
      if (login !== undefined && allowNavigation) await driver.verifyAuthenticated?.(prepared.url, login, true);
    }
    const body = await driver.content();
    if (!isHtmlScreen(body)) {
      if (login !== undefined) await driver.verifyAuthenticated?.(prepared.url, login, allowNavigation);
      skipped.push({
        screenId: plan.screenId,
        route: plan.route,
        url: prepared.url,
        state: plan.state,
        reason: 'nao-e-html',
        body: body.trim().slice(0, 200),
      });
      continue;
    }
    const bytes = await driver.screenshot(true);
    if (login !== undefined) await driver.verifyAuthenticated?.(prepared.url, login, allowNavigation);
    captures.push({
      screenId: plan.screenId,
      route: plan.route,
      url: prepared.url,
      viewport: plan.viewport,
      theme: plan.theme,
      state: plan.state,
      fileName: plan.fileName,
      bytes: bytes.length,
    });
    files.push({fileName: plan.fileName, bytes});
  }
  const emptyStates = emptyStateRecords(plans, captures);
  const metadata: DesignCaptureMetadata = revealed === undefined
    ? {captures, emptyStates}
    : {captures, login: revealed, emptyStates};
  if (skipped.length > 0) metadata.skipped = skipped;
  const body = JSON.stringify(metadata, null, 2);
  if (login !== undefined && login.password.length > 0 && jsonValuesContain(metadata, login.password)) {
    throw new Refusal('DESIGN_PASSWORD_LEAK');
  }
  await mkdir(root, {recursive: true, mode: 0o700});
  for (const file of files) {
    await writeFile(join(root, file.fileName), file.bytes, {mode: 0o600});
  }
  await writeFile(join(root, DESIGN_CAPTURE_METADATA_FILE), `${body}\n`, {mode: 0o600});
  return metadata;
}

type PreparedPlan =
  | {ok: true; url: string; steps?: DesignActionStep[]}
  | {ok: false; url: string; reason: DesignCaptureSkipReason};

function preparePlan(driver: DesignCaptureDriver, baseUrl: string, plan: DesignCapturePlan): PreparedPlan {
  const routeUrl = joinBase(baseUrl, plan.route);
  if (plan.state === 'padrao') return {ok: true, url: routeUrl};
  const reach = plan.reach;
  if (reach === undefined) return {ok: false, url: routeUrl, reason: 'sem-alcance'};
  if (reach.kind === 'url') {
    const url = resolveStateUrl(baseUrl, reach.path);
    if (url === undefined) return {ok: false, url: routeUrl, reason: 'sem-alcance'};
    return {ok: true, url};
  }
  if (reach.steps.length === 0) return {ok: false, url: routeUrl, reason: 'sem-alcance'};
  const steps: DesignActionStep[] = [];
  for (const step of reach.steps) {
    const parsed = parseDesignActionStep(step);
    if (parsed === undefined) return {ok: false, url: routeUrl, reason: 'acao-invalida'};
    steps.push(parsed);
  }
  if (steps.some(step => step.op === 'esperar') && driver.waitForSelector === undefined) {
    return {ok: false, url: routeUrl, reason: 'sem-espera'};
  }
  if (steps.some(step => step.op === 'clicar') && driver.click === undefined) {
    return {ok: false, url: routeUrl, reason: 'sem-acao'};
  }
  if (steps.some(step => step.op === 'preencher') && driver.fill === undefined) {
    return {ok: false, url: routeUrl, reason: 'sem-acao'};
  }
  return {ok: true, url: routeUrl, steps};
}

async function runSteps(driver: DesignCaptureDriver, steps: readonly DesignActionStep[] | undefined): Promise<void> {
  if (steps === undefined) return;
  for (const step of steps) {
    if (step.op === 'clicar') {
      if (driver.click === undefined) throw new Error('DRIVER_ACAO_INCOMPLETA');
      await driver.click(step.selector);
      continue;
    }
    if (step.op === 'preencher') {
      if (driver.fill === undefined) throw new Error('DRIVER_ACAO_INCOMPLETA');
      await driver.fill(step.selector, step.text);
      continue;
    }
    if (driver.waitForSelector === undefined) throw new Error('DRIVER_ACAO_INCOMPLETA');
    await driver.waitForSelector(step.selector);
  }
}

/** Caminho do config, no mesmo host do alvo. Não acrescenta estado=. */
function resolveStateUrl(baseUrl: string, path: string): string | undefined {
  if (!isDesignStatePath(path)) return undefined;
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const resolved = new URL(path, base);
  if (resolved.protocol !== base.protocol || resolved.host !== base.host) return undefined;
  if (resolved.username !== '' || resolved.password !== '') return undefined;
  return `${resolved.protocol}//${resolved.host}${resolved.pathname}${resolved.search}${resolved.hash}`;
}

function emptyStateRecords(
  plans: readonly DesignCapturePlan[],
  captures: readonly DesignCaptureRecord[],
): DesignEmptyStateRecord[] {
  const rows: {screenId: string; route: string; wanted: boolean; captured: boolean}[] = [];
  const index = new Map<string, number>();
  for (const plan of plans) {
    const key = `${plan.screenId}\0${plan.route}`;
    let at = index.get(key);
    if (at === undefined) {
      at = rows.length;
      index.set(key, at);
      rows.push({screenId: plan.screenId, route: plan.route, wanted: false, captured: false});
    }
    const row = rows[at];
    if (row && plan.state === 'vazio') row.wanted = true;
  }
  for (const capture of captures) {
    if (capture.state !== 'vazio') continue;
    const row = rows[index.get(`${capture.screenId}\0${capture.route}`) ?? -1];
    if (row) row.captured = true;
  }
  return rows.map(row => ({
    screenId: row.screenId,
    route: row.route,
    status: !row.wanted ? 'ausente' : row.captured ? 'capturado' : 'nao-capturado',
  }));
}

function isHtmlScreen(body: string): boolean {
  const trimmed = body.trim().replace(/^\uFEFF/, '');
  if (trimmed.length === 0) return false;
  if (isJsonValue(trimmed)) return false;
  if (!/<\/?[A-Za-z!][^>]*>/.test(trimmed)) return false;
  return !isJsonValue(visibleMarkupText(trimmed));
}

function isJsonValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

function visibleMarkupText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function joinBase(baseUrl: string, route: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  if (route === '/') return `${base}/`;
  const path = route.startsWith('/') ? route : `/${route}`;
  return base + path;
}

function assertSafeFileName(fileName: string): void {
  if (fileName.length > 200 || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\') || !SAFE_PNG.test(fileName)) {
    throw new Refusal('DESIGN_PATH_FORBIDDEN');
  }
}

function allocateFileName(
  screenId: string,
  route: string,
  viewport: DesignViewport,
  theme: DesignCaptureTheme,
  state: DesignCaptureState,
  used: Set<string>,
): string {
  const id = safeId(screenId);
  const hash = createHash('sha256').update(route).digest('hex').slice(0, 8);
  const plain = `${id}-${hash}-${viewport}-${theme}-${state}.png`;
  if (!used.has(plain)) {
    used.add(plain);
    assertSafeFileName(plain);
    return plain;
  }
  let suffix = 2;
  let name = `${id}-${suffix}-${hash}-${viewport}-${theme}-${state}.png`;
  while (used.has(name)) {
    suffix += 1;
    name = `${id}-${suffix}-${hash}-${viewport}-${theme}-${state}.png`;
  }
  used.add(name);
  assertSafeFileName(name);
  return name;
}

function safeId(screenId: string): string {
  const cleaned = screenId
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : 'tela';
}

function jsonValuesContain(value: unknown, password: string): boolean {
  if (typeof value === 'string') return value.includes(password);
  if (Array.isArray(value)) return value.some(item => jsonValuesContain(item, password));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(item => jsonValuesContain(item, password));
  }
  return false;
}
