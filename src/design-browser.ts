import {pathToFileURL} from 'node:url';
import type {DesignCaptureDriver, DesignCaptureTheme} from './design-capture.ts';
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
  fetch?: () => Promise<DesignBrowserResponse>;
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

export type DesignBrowserGuardContext = {
  route(pattern: string, handler: (route: DesignBrowserRoute) => Promise<void>): Promise<void>;
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
};

type DesignBrowser = {
  newContext(): Promise<DesignContext>;
  close(): Promise<void>;
};

type ChromiumLauncher = {
  launch(options: {executablePath: string; args: string[]}): Promise<DesignBrowser>;
};

const CHROME = '/usr/bin/google-chrome';

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
    const remembered = await rememberNonHtmlDocument(route);
    if (remembered.handled) {
      rawDocument = remembered.body;
      return;
    }
    await route.continue();
  });
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

async function rememberNonHtmlDocument(route: DesignBrowserRoute): Promise<{handled: boolean; body?: string}> {
  const kind = route.request().resourceType?.();
  if (kind !== 'document' || route.fetch === undefined || route.fulfill === undefined) return {handled: false};
  const response = await route.fetch();
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

/** Host Chrome through the Playwright already installed for the panel. The design CLI captures with this driver. */
export async function openDesignBrowser(targetUrl: string): Promise<{driver: DesignCaptureDriver; close: () => Promise<void>}> {
  assertDesignTarget(targetUrl);
  const specifier = new URL('../upstream/cezar/node_modules/playwright-core/index.mjs', import.meta.url);
  let chromium: ChromiumLauncher;
  try {
    const loaded = await import(specifier.href) as {chromium?: ChromiumLauncher};
    if (!loaded.chromium) throw new Error('DESIGN_BROWSER_MISSING');
    chromium = loaded.chromium;
  } catch (error) {
    if (error instanceof Error && error.message === 'DESIGN_BROWSER_MISSING') throw error;
    throw new Error('DESIGN_BROWSER_MISSING');
  }
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const context = await browser.newContext();
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
