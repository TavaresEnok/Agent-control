import {chmod, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import type {DesignCaptureDriver, DesignCaptureTheme} from './design-capture.ts';
import type {DesignLogin} from './design-discover.ts';
import {assertDesignDestination, assertDesignTarget} from './design-image.ts';

type DesignPage = {
  url(): string;
  setViewportSize(size: {width: number; height: number}): Promise<void>;
  emulateMedia(options: {colorScheme: 'dark' | 'light'}): Promise<void>;
  goto(url: string, options: {waitUntil: 'domcontentloaded'; timeout: number}): Promise<unknown>;
  screenshot(options: {fullPage: true; type: 'png'}): Promise<Buffer>;
  content(): Promise<string>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForFunction(expression: () => boolean, arg: undefined, options: {timeout: number}): Promise<unknown>;
};

export type DesignBrowserRoute = {
  request(): {url(): string; resourceType?: () => string};
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
  fetch?: (options?: {maxRedirects?: number}) => Promise<DesignBrowserResponse>;
  fulfill?: (options: {response?: DesignBrowserResponse; status?: number; headers?: Record<string, string>; body?: string}) => Promise<void>;
};

type DesignBrowserResponse = {
  status(): number;
  headers(): Record<string, string>;
  text(): Promise<string>;
};

export type DesignBrowserGuardPage = {
  url(): string;
  goto(url: string, options: {waitUntil: 'domcontentloaded'; timeout: number}): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
};

type DesignBrowserWebSocketRoute = {
  url(): string;
  connectToServer(): void;
  close(): void | Promise<void>;
};

export type DesignBrowserGuardContext = {
  route(pattern: string, handler: (route: DesignBrowserRoute) => Promise<void>): Promise<void>;
  routeWebSocket?: (
    pattern: string,
    handler: (socket: DesignBrowserWebSocketRoute) => Promise<void> | void,
  ) => Promise<void>;
};

export type DesignBrowserGuard = {
  goto(url: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  afterLogin(): void;
  /** Raw document when the response is not HTML. Undefined for an HTML page. */
  documentBody(): string | undefined;
};

type DesignContext = DesignBrowserGuardContext & {
  newPage(): Promise<DesignPage>;
  storageState(): Promise<unknown>;
};

type DesignBrowser = {
  newContext(options: {serviceWorkers: 'allow' | 'block'}): Promise<DesignContext>;
  close(): Promise<void>;
};

type ChromiumLauncher = {
  launch(options: {executablePath: string; args: string[]}): Promise<DesignBrowser>;
};

const CHROME = '/usr/bin/google-chrome';

/** Service workers can answer fetches outside the page route, so the exam context blocks them. */
export const designBrowserContextOptions = {serviceWorkers: 'block' as const};

function readRequestUrl(route: DesignBrowserRoute): string | undefined {
  try {
    const value = route.request().url();
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function onDeclaredOrigin(origin: string, candidate: string): boolean {
  try {
    return new URL(candidate).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The exam may only talk to the declared origin.
 * A redirect that lands elsewhere refuses the login fill.
 * Document fetches stay on the first response so the host never follows a Location itself.
 */
export async function installDesignBrowserGuard(
  context: DesignBrowserGuardContext,
  page: DesignBrowserGuardPage,
  targetUrl: string,
): Promise<DesignBrowserGuard> {
  const {origin} = assertDesignTarget(targetUrl);
  let rawDocument: string | undefined;
  await context.route('**/*', async (route) => {
    const url = readRequestUrl(route);
    if (url === undefined || !onDeclaredOrigin(origin, url)) {
      await route.abort('blockedbyclient');
      return;
    }
    const remembered = await rememberNonHtmlDocument(route, origin);
    if (remembered.handled) {
      rawDocument = remembered.body;
      return;
    }
    await route.continue();
  });
  if (context.routeWebSocket) {
    await context.routeWebSocket('**/*', async (socket) => {
      const url = readSocketUrl(socket);
      if (url !== undefined && socketOnDeclaredOrigin(origin, url)) {
        socket.connectToServer();
        return;
      }
      await socket.close();
    });
  }
  return {
    async goto(url: string) {
      rawDocument = undefined;
      await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30000});
      assertDesignDestination(targetUrl, page.url());
    },
    async fill(selector: string, value: string) {
      assertDesignDestination(targetUrl, page.url());
      await page.fill(selector, value);
    },
    afterLogin() {
      assertDesignDestination(targetUrl, page.url());
    },
    documentBody() {
      return rawDocument;
    },
  };
}

function isHtmlContentType(type: string): boolean {
  const media = type.split(';')[0]?.trim().toLowerCase() ?? '';
  return media === 'text/html' || media === 'application/xhtml+xml';
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return undefined;
}

/** Resolve Location against the document URL. Only a same-origin target may be fulfilled. */
function redirectStaysOnOrigin(origin: string, requestUrl: string | undefined, headers: Record<string, string>): boolean {
  if (requestUrl === undefined) return false;
  const location = headerValue(headers, 'location')?.trim();
  if (!location) return false;
  try {
    return new URL(location, requestUrl).origin === origin;
  } catch {
    return false;
  }
}

function readSocketUrl(socket: DesignBrowserWebSocketRoute): string | undefined {
  try {
    const value = socket.url();
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** ws/wss is the declared http(s) origin when host and port match. */
function socketOnDeclaredOrigin(origin: string, candidate: string): boolean {
  try {
    const declared = new URL(origin);
    const socket = new URL(candidate);
    const protocol = socket.protocol === 'ws:' ? 'http:' : socket.protocol === 'wss:' ? 'https:' : '';
    if (protocol === '') return false;
    const mapped = new URL(socket.href);
    mapped.protocol = protocol;
    return mapped.origin === declared.origin;
  } catch {
    return false;
  }
}

async function rememberNonHtmlDocument(
  route: DesignBrowserRoute,
  origin: string,
): Promise<{handled: boolean; body?: string}> {
  const kind = route.request().resourceType?.();
  if (kind !== 'document' || route.fetch === undefined || route.fulfill === undefined) return {handled: false};
  const response = await route.fetch({maxRedirects: 0});
  if (isRedirectStatus(response.status())) {
    if (!redirectStaysOnOrigin(origin, readRequestUrl(route), response.headers())) {
      await route.abort('blockedbyclient');
      return {handled: true};
    }
    await route.fulfill({response});
    return {handled: true};
  }
  const type = response.headers()['content-type'] ?? '';
  if (isHtmlContentType(type)) {
    await route.fulfill({response});
    return {handled: true};
  }
  const body = await response.text();
  await route.fulfill({status: response.status(), headers: response.headers(), body});
  return {handled: true, body};
}

async function waitForPaint(page: DesignPage): Promise<void> {
  await page.waitForFunction(
    () => (document.querySelector('#root')?.textContent ?? '').trim().length > 0,
    undefined,
    {timeout: 15000},
  ).catch(() => undefined);
}

/**
 * O host faz o login e grava o storageState em 0600.
 * A senha não entra no arquivo. O chamador apaga o diretório no fim.
 */
export async function writeDesignLoginState(targetUrl: string, login: DesignLogin): Promise<string> {
  assertDesignTarget(targetUrl);
  const chromium = await loadChromium();
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const directory = await mkdtemp(join(tmpdir(), 'design-login-'));
  try {
    await chmod(directory, 0o700);
    const context = await browser.newContext(designBrowserContextOptions);
    const page = await context.newPage();
    const guard = await installDesignBrowserGuard(context, page, targetUrl);
    await guard.goto(assertDesignTarget(targetUrl).origin);
    await guard.fill(login.usernameSelector, login.username);
    await guard.fill(login.passwordSelector, login.password);
    await page.click(login.submitSelector);
    guard.afterLogin();
    const body = JSON.stringify(await context.storageState());
    if (body.includes(login.password)) throw new Refusal('DESIGN_PASSWORD_LEAK');
    const path = join(directory, 'state.json');
    await writeFile(path, body, {mode: 0o600});
    await chmod(path, 0o600);
    return path;
  } catch (error) {
    const {rm} = await import('node:fs/promises');
    await rm(directory, {recursive: true, force: true});
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function loadChromium(): Promise<ChromiumLauncher> {
  const specifier = new URL('../upstream/cezar/node_modules/playwright-core/index.mjs', import.meta.url);
  try {
    const loaded = await import(specifier.href) as {chromium?: ChromiumLauncher};
    if (!loaded.chromium) throw new Error('DESIGN_BROWSER_MISSING');
    return loaded.chromium;
  } catch (error) {
    if (error instanceof Error && error.message === 'DESIGN_BROWSER_MISSING') throw error;
    throw new Error('DESIGN_BROWSER_MISSING');
  }
}

/** Host Chrome through the Playwright already installed for the panel. The design CLI captures with this driver. */
export async function openDesignBrowser(targetUrl: string): Promise<{driver: DesignCaptureDriver; close: () => Promise<void>}> {
  assertDesignTarget(targetUrl);
  const chromium = await loadChromium();
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const context = await browser.newContext(designBrowserContextOptions);
    const page = await context.newPage();
    const guard = await installDesignBrowserGuard(context, page, targetUrl);
    let closed = false;
    const driver: DesignCaptureDriver = {
      async setViewport(width, height) {
        await page.setViewportSize({width, height});
      },
      async emulateMedia(theme: DesignCaptureTheme) {
        await page.emulateMedia({colorScheme: theme === 'escuro' ? 'dark' : 'light'});
      },
      async goto(url) {
        await guard.goto(url);
        await waitForPaint(page);
      },
      async screenshot() {
        return Buffer.from(await page.screenshot({fullPage: true, type: 'png'}));
      },
      async content() {
        return guard.documentBody() ?? await page.content();
      },
      async fill(selector, value) {
        await guard.fill(selector, value);
      },
      async click(selector) {
        await page.click(selector);
        await page.waitForFunction(
          () => document.querySelector('input[name="password"]') === null,
          undefined,
          {timeout: 15000},
        ).catch(() => undefined);
        // Login can navigate while the password field disappears.
        guard.afterLogin();
      },
    };
    return {
      driver,
      async close() {
        if (closed) return;
        closed = true;
        await browser.close();
      },
    };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}
