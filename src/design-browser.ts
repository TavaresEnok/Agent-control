import {pathToFileURL} from 'node:url';
import type {DesignCaptureDriver, DesignCaptureTheme} from './design-capture.ts';

type DesignPage = {
  setViewportSize(size: {width: number; height: number}): Promise<void>;
  emulateMedia(options: {colorScheme: 'dark' | 'light'}): Promise<void>;
  goto(url: string, options: {waitUntil: 'domcontentloaded'; timeout: number}): Promise<unknown>;
  screenshot(options: {fullPage: true; type: 'png'}): Promise<Buffer>;
  content(): Promise<string>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForFunction(expression: () => boolean, arg: undefined, options: {timeout: number}): Promise<unknown>;
};

type DesignBrowser = {
  newContext(): Promise<{newPage(): Promise<DesignPage>}>;
  close(): Promise<void>;
};

type ChromiumLauncher = {
  launch(options: {executablePath: string; args: string[]}): Promise<DesignBrowser>;
};

const CHROME = '/usr/bin/google-chrome';

async function waitForPaint(page: DesignPage): Promise<void> {
  await page.waitForFunction(
    () => (document.querySelector('#root')?.textContent ?? '').trim().length > 0,
    undefined,
    {timeout: 15000},
  ).catch(() => undefined);
}

/** Host Chrome through the Playwright already installed for the panel. The design CLI captures with this driver. */
export async function openDesignBrowser(): Promise<{driver: DesignCaptureDriver; close: () => Promise<void>}> {
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
  const context = await browser.newContext();
  const page = await context.newPage();
  let closed = false;
  const driver: DesignCaptureDriver = {
    async setViewport(width, height) {
      await page.setViewportSize({width, height});
    },
    async emulateMedia(theme: DesignCaptureTheme) {
      await page.emulateMedia({colorScheme: theme === 'escuro' ? 'dark' : 'light'});
    },
    async goto(url) {
      await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30000});
      await waitForPaint(page);
    },
    async screenshot() {
      return Buffer.from(await page.screenshot({fullPage: true, type: 'png'}));
    },
    async content() {
      return page.content();
    },
    async fill(selector, value) {
      await page.fill(selector, value);
    },
    async click(selector) {
      await page.click(selector);
      await page.waitForFunction(
        () => document.querySelector('input[name="password"]') === null,
        undefined,
        {timeout: 15000},
      ).catch(() => undefined);
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
}
