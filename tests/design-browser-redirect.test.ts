import assert from 'node:assert/strict';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {test} from 'node:test';
import {
  designBrowserContextOptions,
  installDesignBrowserGuard,
  type DesignBrowserRoute,
} from '../src/design-browser.ts';

const SECRET = 'CORPO-DO-ALVO-QUE-NAO-PODE-CHEGAR';

type Fetched = {
  status(): number;
  headers(): Record<string, string>;
  text(): Promise<string>;
};

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('missing port'));
        return;
      }
      resolve((address as AddressInfo).port);
    });
  });
}

function stop(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

/** Playwright's route.fetch follows up to 20 redirects unless maxRedirects is 0. */
async function simulatePlaywrightFetch(url: string, options?: {maxRedirects?: number}): Promise<Fetched> {
  const maxRedirects = options?.maxRedirects ?? 20;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetch(current, {redirect: 'manual'});
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = await response.text();
    const location = headers.location;
    const redirecting = response.status >= 300 && response.status < 400 && typeof location === 'string' && location !== '';
    if (options?.maxRedirects === 0 || !redirecting || hop === maxRedirects) {
      return {
        status: () => response.status,
        headers: () => headers,
        async text() {
          return body;
        },
      };
    }
    current = new URL(location, current).href;
  }
  throw new Error('redirect limit');
}

test('document fetch does not follow a redirect off the declared origin', async () => {
  let targetHits = 0;
  const target = http.createServer((_req, res) => {
    targetHits += 1;
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', connection: 'close'});
    res.end(SECRET);
  });
  const targetPort = await listen(target);
  const source = http.createServer((req, res) => {
    if (req.url === '/relativo') {
      res.writeHead(302, {Location: '/painel', 'content-type': 'text/html; charset=utf-8', connection: 'close'});
      res.end();
      return;
    }
    if (req.url === '/painel') {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8', connection: 'close'});
      res.end('MESMA-ORIGEM');
      return;
    }
    res.writeHead(302, {
      Location: `http://127.0.0.1:${targetPort}/secret`,
      'content-type': 'text/html; charset=utf-8',
      connection: 'close',
    });
    res.end();
  });
  const sourcePort = await listen(source);
  const origin = `http://127.0.0.1:${sourcePort}`;
  let handler: ((route: DesignBrowserRoute) => Promise<void>) | undefined;
  let wsHandler: ((socket: {url(): string; connectToServer(): void; close(): void}) => void) | undefined;
  const context = {
    async route(pattern: string, installed: (route: DesignBrowserRoute) => Promise<void>) {
      assert.equal(pattern, '**/*');
      handler = installed;
    },
    async routeWebSocket(
      pattern: string,
      installed: (socket: {url(): string; connectToServer(): void; close(): void}) => void,
    ) {
      assert.equal(pattern, '**/*');
      wsHandler = installed;
    },
  };
  const page = {
    url: () => 'about:blank',
    async goto() {},
    async fill() {},
  };
  try {
    await installDesignBrowserGuard(context, page, `${origin}/inicio`);
    assert.equal(typeof handler, 'function');

    const crossFulfilled: string[] = [];
    let crossAbort: string | undefined;
    await handler!({
      request: () => ({url: () => `${origin}/inicio`, resourceType: () => 'document'}),
      async abort(errorCode?: string) {
        crossAbort = errorCode;
      },
      async continue() {
        throw new Error('cross-origin redirect must not continue');
      },
      fetch: (options) => simulatePlaywrightFetch(`${origin}/inicio`, options),
      async fulfill(options) {
        const body = options.body ?? (options.response ? await options.response.text() : '');
        crossFulfilled.push(body);
      },
    });
    assert.equal(targetHits, 0);
    assert.equal(crossFulfilled.some((body) => body.includes(SECRET)), false);
    assert.equal(crossAbort, 'blockedbyclient');

    const sameFulfilled: {status?: number; body: string}[] = [];
    let sameAbort: string | undefined;
    await handler!({
      request: () => ({url: () => `${origin}/relativo`, resourceType: () => 'document'}),
      async abort(errorCode?: string) {
        sameAbort = errorCode ?? 'aborted';
      },
      async continue() {
        throw new Error('same-origin redirect must be fulfilled for the browser');
      },
      fetch: (options) => simulatePlaywrightFetch(`${origin}/relativo`, options),
      async fulfill(options) {
        const body = options.body ?? (options.response ? await options.response.text() : '');
        sameFulfilled.push({status: options.status ?? options.response?.status(), body});
      },
    });
    assert.equal(sameAbort, undefined);
    assert.equal(sameFulfilled.some((item) => item.status === 302), true);
    assert.equal(sameFulfilled.some((item) => item.body.includes(SECRET)), false);
    assert.equal(targetHits, 0);

    assert.equal(typeof wsHandler, 'function');
    const decisions: {url: string; action: 'close' | 'connect'}[] = [];
    const probe = (url: string) => wsHandler!({
      url: () => url,
      connectToServer() {
        decisions.push({url, action: 'connect'});
      },
      close() {
        decisions.push({url, action: 'close'});
      },
    });
    probe(`ws://127.0.0.1:${targetPort}/`);
    probe(`ws://127.0.0.1:${sourcePort}/`);
    assert.deepEqual(decisions, [
      {url: `ws://127.0.0.1:${targetPort}/`, action: 'close'},
      {url: `ws://127.0.0.1:${sourcePort}/`, action: 'connect'},
    ]);
    assert.equal(designBrowserContextOptions.serviceWorkers, 'block');
  } finally {
    await stop(source);
    await stop(target);
  }
});
