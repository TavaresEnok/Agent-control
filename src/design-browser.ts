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
  request(): {url(): string};
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
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
  await context.route('**/*', async (route) => {
    const url = readRequestUrl(route);
    if (url !== undefined && onDeclaredOrigin(origin, url)) {
      await route.continue();
      return;
    }
    await route.abort('blockedbyclient');
  });
  return {
    async goto(url: string) {
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
  };
}

async function waitForPaint(page: DesignPage): Promise<void> {
  await page.waitForFunction(
    () => (document.querySelector('#root')?.textContent ?? '').trim().length > 0,
    undefined,
    {timeout: 15000},
  ).catch(() => undefined);
}

/** Host Chrome through the Playwright already installed for the panel. The design CLI captures with this driver. */
export async function openDesignBrowser(targetUrl?: string): Promise<{driver: DesignCaptureDriver; close: () => Promise<void>}> {
  if (targetUrl !== undefined) assertDesignTarget(targetUrl);
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
    const guard = targetUrl === undefined ? undefined : await installDesignBrowserGuard(context, page, targetUrl);
    let closed = false;
    const driver: DesignCaptureDriver = {
      async setViewport(width, height) {
        await page.setViewportSize({width, height});
      },
      async emulateMedia(theme: DesignCaptureTheme) {
        await page.emulateMedia({colorScheme: theme === 'escuro' ? 'dark' : 'light'});
      },
      async goto(url) {
        if (guard) await guard.goto(url);
        else await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30000});
        await waitForPaint(page);
      },
      async screenshot() {
        return Buffer.from(await page.screenshot({fullPage: true, type: 'png'}));
      },
      async content() {
        return page.content();
      },
      async fill(selector, value) {
        if (guard) await guard.fill(selector, value);
        else await page.fill(selector, value);
      },
      async click(selector) {
        await page.click(selector);
        await page.waitForFunction(
          () => document.querySelector('input[name="password"]') === null,
          undefined,
          {timeout: 15000},
        ).catch(() => undefined);
        // Login can navigate while the password field disappears.
        guard?.afterLogin();
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
