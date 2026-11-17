import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {installDesignBrowserGuard, type DesignBrowserRoute} from '../src/design-browser.ts';

const TARGET = 'http://127.0.0.1:4173/inicio';
const PASSWORD = 'senha-que-nao-pode-sair';
const FOREIGN = 'https://evil.example/colhe-senha';

function refusal(code: string) {
  return (error: unknown): boolean => error instanceof Refusal && error.code === code;
}

type Decision = {url: string; action: 'abort' | 'continue'};

function tracked(url: string, log: Decision[]): DesignBrowserRoute {
  return {
    request: () => ({url: () => url}),
    async abort() {
      log.push({url, action: 'abort'});
    },
    async continue() {
      log.push({url, action: 'continue'});
    },
  };
}

function fakeBrowser(landOn: {url: string; pending: string}) {
  const decisions: Decision[] = [];
  const filled: {selector: string; value: string}[] = [];
  const gotos: string[] = [];
  let handler: ((route: DesignBrowserRoute) => Promise<void>) | undefined;
  const context = {
    async route(pattern: string, installed: (route: DesignBrowserRoute) => Promise<void>) {
      assert.equal(pattern, '**/*');
      assert.equal(handler, undefined);
      handler = installed;
    },
  };
  const page = {
    url: () => landOn.url,
    async goto(url: string) {
      gotos.push(url);
      landOn.url = landOn.pending;
    },
    async fill(selector: string, value: string) {
      filled.push({selector, value});
    },
  };
  return {context, page, decisions, filled, gotos, landOn, handler: () => handler};
}

test('Block the design exam browser outside the declared origin.', async () => {
  const landOn = {url: 'about:blank', pending: FOREIGN};
  const browser = fakeBrowser(landOn);
  const guard = await installDesignBrowserGuard(browser.context, browser.page, TARGET);
  const handle = browser.handler();
  assert.equal(typeof handle, 'function');

  const same = [
    'http://127.0.0.1:4173/inicio',
    'http://127.0.0.1:4173/assets/app.js',
    'http://127.0.0.1:4173/inicio?estado=vazio',
  ];
  const foreign = [
    FOREIGN,
    'http://127.0.0.1:4174/inicio',
    'https://127.0.0.1:4173/inicio',
    'http://localhost:4173/inicio',
    'http://127.0.0.1.evil.example/inicio',
    'about:blank',
    'not a url',
  ];
  for (const url of same) await handle!(tracked(url, browser.decisions));
  for (const url of foreign) await handle!(tracked(url, browser.decisions));
  assert.deepEqual(browser.decisions, [
    ...same.map(url => ({url, action: 'continue' as const})),
    ...foreign.map(url => ({url, action: 'abort' as const})),
  ]);

  await assert.rejects(() => guard.goto(TARGET), refusal('DESIGN_TARGET_ESCAPE'));
  assert.deepEqual(browser.gotos, [TARGET]);
  assert.equal(browser.page.url(), FOREIGN);
  await assert.rejects(
    () => guard.fill('input[name="password"]', PASSWORD),
    refusal('DESIGN_TARGET_ESCAPE'),
  );
  assert.throws(() => guard.afterLogin(), refusal('DESIGN_TARGET_ESCAPE'));
  assert.deepEqual(browser.filled, []);
});

test('same-origin exam page still navigates, fills, and accepts login', async () => {
  const home = 'http://127.0.0.1:4173/painel';
  const landOn = {url: 'about:blank', pending: home};
  const browser = fakeBrowser(landOn);
  const guard = await installDesignBrowserGuard(browser.context, browser.page, TARGET);
  await browser.handler()!(tracked(home, browser.decisions));
  assert.deepEqual(browser.decisions, [{url: home, action: 'continue'}]);

  await guard.goto(TARGET);
  assert.doesNotThrow(() => guard.afterLogin());
  await guard.fill('#usuario', 'ada');
  await guard.fill('input[name="password"]', PASSWORD);
  assert.deepEqual(browser.filled, [
    {selector: '#usuario', value: 'ada'},
    {selector: 'input[name="password"]', value: PASSWORD},
  ]);

  landOn.url = 'http://127.0.0.1:4174/depois-do-login';
  assert.throws(() => guard.afterLogin(), refusal('DESIGN_TARGET_ESCAPE'));
  await assert.rejects(() => guard.fill('input[name="password"]', PASSWORD), refusal('DESIGN_TARGET_ESCAPE'));
  assert.equal(browser.filled.length, 2);
});
