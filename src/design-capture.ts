import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Refusal} from './contracts.ts';
import {publicLoginRecord, type DesignLogin, type PublicLoginRecord} from './design-discover.ts';
import {DESIGN_VIEWPORTS, type DesignViewport} from './design-types.ts';

export type {DesignLogin, PublicLoginRecord};

export type DesignCaptureTheme = 'claro' | 'escuro';
export type DesignCaptureState = 'padrao' | 'vazio' | 'carregando' | 'erro';

export type DesignCapturePlan = {
  screenId: string;
  route: string;
  viewport: DesignViewport;
  theme: DesignCaptureTheme;
  state: DesignCaptureState;
  fileName: string;
};

export type DesignCaptureScreen = {
  id: string;
  route: string;
  hasDarkTheme: boolean;
  forceStates: boolean;
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

export type DesignCaptureSkip = {
  screenId: string;
  route: string;
  url: string;
  reason: 'nao-e-html';
  body: string;
};

export type DesignCaptureMetadata = {
  captures: DesignCaptureRecord[];
  login?: PublicLoginRecord;
  skipped?: DesignCaptureSkip[];
};

export type DesignCaptureOptions = {
  login?: DesignLogin;
};

/**
 * Sempre 375, 768 e 1440 no tema claro e no estado padrao.
 * Tema escuro só com hasDarkTheme. Estados vazio, carregando e erro só com forceStates.
 * O produto é o cartesiano desses eixos. O nome do arquivo só tem caracteres seguros e termina em .png.
 */
export function planCaptures(screens: readonly DesignCaptureScreen[]): DesignCapturePlan[] {
  const used = new Set<string>();
  const plans: DesignCapturePlan[] = [];
  for (const screen of screens) {
    const themes: DesignCaptureTheme[] = screen.hasDarkTheme ? ['claro', 'escuro'] : ['claro'];
    const states: DesignCaptureState[] = screen.forceStates
      ? ['padrao', 'vazio', 'carregando', 'erro']
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
            fileName: allocateFileName(screen.id, viewport, theme, state, used),
          });
        }
      }
    }
  }
  return plans;
}

/**
 * Captura cada plano em PNG de página inteira.
 * A URL é baseUrl + route. Estado forçado acrescenta estado= sem apagar a rota.
 * Login efêmero preenche os seletores e não grava a senha. O JSON usa publicLoginRecord.
 * Corpo JSON ou não-HTML não vira PNG: o plano fica em skipped.
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
    await driver.goto(baseUrl);
    await driver.fill(login.usernameSelector, login.username);
    await driver.fill(login.passwordSelector, login.password);
    await driver.click(login.submitSelector);
  }
  const captures: DesignCaptureRecord[] = [];
  const skipped: DesignCaptureSkip[] = [];
  const files: {fileName: string; bytes: Buffer}[] = [];
  for (const plan of plans) {
    const url = withState(joinBase(baseUrl, plan.route), plan.state);
    await driver.setViewport(plan.viewport, DESIGN_CAPTURE_HEIGHT[plan.viewport]);
    await driver.emulateMedia(plan.theme);
    await driver.goto(url);
    const body = await driver.content();
    if (!isHtmlScreen(body)) {
      skipped.push({
        screenId: plan.screenId,
        route: plan.route,
        url,
        reason: 'nao-e-html',
        body: body.trim().slice(0, 200),
      });
      continue;
    }
    const bytes = await driver.screenshot(true);
    captures.push({
      screenId: plan.screenId,
      route: plan.route,
      url,
      viewport: plan.viewport,
      theme: plan.theme,
      state: plan.state,
      fileName: plan.fileName,
      bytes: bytes.length,
    });
    files.push({fileName: plan.fileName, bytes});
  }
  const metadata: DesignCaptureMetadata = revealed === undefined ? {captures} : {captures, login: revealed};
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

function isHtmlScreen(body: string): boolean {
  const trimmed = body.trim().replace(/^\uFEFF/, '');
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (value !== null && typeof value === 'object') return false;
    } catch {
      // texto que só começa com chave continua candidato a HTML
    }
  }
  return /<\/?[A-Za-z!][^>]*>/.test(trimmed);
}

function joinBase(baseUrl: string, route: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  if (route === '/') return `${base}/`;
  const path = route.startsWith('/') ? route : `/${route}`;
  return base + path;
}

function withState(url: string, state: DesignCaptureState): string {
  if (state === 'padrao') return url;
  const hashAt = url.indexOf('#');
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const before = hashAt === -1 ? url : url.slice(0, hashAt);
  const separator = before.includes('?') ? '&' : '?';
  return `${before}${separator}estado=${state}${hash}`;
}

function assertSafeFileName(fileName: string): void {
  if (fileName.length > 200 || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\') || !SAFE_PNG.test(fileName)) {
    throw new Refusal('DESIGN_PATH_FORBIDDEN');
  }
}

function allocateFileName(
  screenId: string,
  viewport: DesignViewport,
  theme: DesignCaptureTheme,
  state: DesignCaptureState,
  used: Set<string>,
): string {
  const id = safeId(screenId);
  const plain = `${id}-${viewport}-${theme}-${state}.png`;
  if (!used.has(plain)) {
    used.add(plain);
    assertSafeFileName(plain);
    return plain;
  }
  let suffix = 2;
  let name = `${id}-${suffix}-${viewport}-${theme}-${state}.png`;
  while (used.has(name)) {
    suffix += 1;
    name = `${id}-${suffix}-${viewport}-${theme}-${state}.png`;
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
