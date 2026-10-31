import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const here = resolve(root, 'tools/f0/mobile');
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(here, '.runtime/browsers');
process.env.TMPDIR = resolve(here, '.runtime/tmp');
const require = createRequire(resolve(here, 'package.json'));
const { chromium } = require('playwright');
const startedAt = new Date().toISOString();
const artifacts = resolve(here, 'artifacts', startedAt.replaceAll(':', '').replaceAll('.', '-'));
await mkdir(artifacts, { recursive: true });
const report = {
  startedAt, node: process.version,
  command: 'python3 tools/f0/mobile/run.py',
  browserCommand: 'node test/f0/mobile/browser.mjs (isolated Node)',
  tree: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  upstream: JSON.parse(await readFile(resolve(root, 'UPSTREAM.json'))),
  classification: 'PARTIAL: real source components; synthetic HTTP/ActionCable transport and task data',
  g0: 'PENDENTE', checks: [], screenshots: [], errors: [],
  notRun: [
    'Authenticated Rails routes, authorization/CSRF and account/model profile creation: no isolated Rails/database runtime provisioned; ruby absent in PATH',
    'Task creation through BoardPage/API: harness renders a task fixture only',
    'Backend command deduplication and durable state: no Rails/DB/Temporal execution',
    'Temporal graph/run transitions and full mobile navigation: not mounted; dependency tree is only a component proof',
  ],
};
let browser, server, context, page;
const heartbeats = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function screenshot(page, name) {
  const path = resolve(artifacts, name);
  await page.screenshot({ path, fullPage: true });
  report.screenshots.push({ name, sha256: sha(await readFile(path)) });
}
async function check(name, fn) {
  try {
    await fn();
    report.checks.push({ name, result: 'PASS (partial component proof)' });
  } catch (error) {
    report.checks.push({ name, result: 'FAIL', cause: error.message });
    throw error;
  }
}
try {
  const { startHarness } = await import('../../../tools/f0/mobile/server.mjs');
  ({ server, url: report.url } = await startHarness());
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) {
    report.preflight = 'Browser launch failed: install isolated browser with python3 tools/f0/mobile/setup.py; missing OS libraries require manager intervention (no sudo in this proof)';
    throw error;
  }
  report.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const blocked = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === report.url) return route.continue();
    blocked.push(url.origin);
    return route.abort('blockedbyclient');
  });
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  const requests = [];
  let snapshot = 'running';
  let snapshotReads = 0;
  await page.route('**/__f0/agent', async route => {
    requests.push(JSON.parse(route.request().postData()));
    // Model receipt followed by lost acknowledgement. This is NOT a backend ledger.
    if (requests.length === 1) return route.abort('connectionreset');
    return route.fulfill({ json: { synthetic: true } });
  });
  await page.route('**/__f0/snapshot', route => {
    snapshotReads++;
    return route.fulfill({ json: { state: snapshot, synthetic: true } });
  });
  const sockets = [];
  await context.routeWebSocket('**/*', socket => {
    const target = new URL(socket.url());
    if (target.origin !== report.url.replace('http:', 'ws:')) {
      blocked.push(target.origin);
      return socket.close();
    }
    if (target.pathname !== '/cable') return socket.connectToServer();
    sockets.push(socket);
    socket.send(JSON.stringify({ type: 'welcome' }));
    const heartbeat = setInterval(() => socket.send(JSON.stringify({ type: 'ping', message: Date.now() / 1000 })), 1000);
    heartbeats.push(heartbeat);
    socket.onClose(() => clearInterval(heartbeat));
    socket.onMessage(raw => {
      const message = JSON.parse(raw.toString());
      if (message.command === 'subscribe') socket.send(JSON.stringify({ type: 'confirm_subscription', identifier: message.identifier }));
    });
  });
  await page.goto(report.url);
  await check('real agent form validates and retains input after lost synthetic acknowledgement', async () => {
    await page.getByRole('button', { name: 'Open real agent form' }).click();
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByText('Title is required', { exact: true }).waitFor();
    assert.equal(requests.length, 0);
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('mobile_f0');
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Synthetic F0 agent');
    await page.getByRole('textbox', { name: 'Persona', exact: true }).fill('Synthetic persona; no AI account attached.');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByText('Synthetic acknowledgement lost; retry possible', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'mobile_f0');
    await screenshot(page, '390-agent-lost-ack.png');
  });
  await check('resubmission emits identical payload twice; no command ID supplied by agent form', async () => {
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByTestId('agent-result').filter({ hasText: 'acknowledgement received' }).waitFor();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.deepEqual(Object.keys(requests[0]).sort(), ['agent']);
    report.resend = { attempts: requests.length, payloads: requests, backendDeduplication: 'NOT RUN', uiObserved: 'two identical transport attempts; form loading is not backend deduplication' };
  });
  await check('real task card, step expansion and dependency selection respond to touch clicks', async () => {
    await page.getByText('Synthetic mobile task', { exact: true }).waitFor();
    await page.getByRole('region', { name: 'Task fixture' }).getByText('Running', { exact: true }).waitFor();
    const steps = page.getByRole('region', { name: 'Run steps', exact: true });
    assert.equal(await steps.getByText('Report', { exact: true }).isVisible(), false);
    await page.getByRole('button', { name: 'Show all 4 steps' }).click();
    await steps.getByText('Report', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show fewer steps' }).click();
    assert.equal(await steps.getByText('Report', { exact: true }).isVisible(), false);
    const dependencies = page.getByRole('region', { name: 'Dependencies', exact: true });
    await dependencies.getByText('↳ AFTER Implementation', { exact: true }).waitFor();
    await dependencies.getByText('Review', { exact: true }).click();
    assert.equal(await page.getByTestId('selection').textContent(), 'session:2');
    await screenshot(page, '390-running-dependencies.png');
  });
  await check('real ActionCable client reconnect makes real hook reload missed synthetic snapshot', async () => {
    await page.waitForFunction(() => document.querySelector('[data-testid="reconnect"]').textContent.includes('Reloads: 0'));
    assert.equal(snapshotReads, 0);
    assert.equal(sockets.length, 1);
    snapshot = 'completed';
    clearInterval(heartbeats[0]);
    sockets[0].close({ code: 1012, reason: 'Synthetic connection loss' });
    await page.getByTestId('reconnect').filter({ hasText: 'Reloads: 1; snapshot: completed' }).waitFor({ timeout: 40000 });
    assert.ok(sockets.length >= 2);
    assert.equal(snapshotReads, 1);
    await page.getByRole('region', { name: 'Task fixture' }).getByText('Succeeded', { exact: true }).waitFor();
    report.reconnect = { socketConnections: sockets.length, snapshotReads, missedState: snapshot, backendExecution: 'NOT RUN' };
    await screenshot(page, '390-reconnected-completed.png');
  });
  report.layout = [];
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    report.layout.push(await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
      overflowing: [...document.querySelectorAll('main *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 12).map(el => ({ tag: el.tagName, class: el.className, right: el.getBoundingClientRect().right })) })));
    if (width === 360) await screenshot(page, '360-components.png');
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(blocked, []);
  assert.equal(report.layout.length, 2);
  assert.ok(report.layout.every(item => !item.overflow), 'horizontal overflow in mobile viewport');
  report.externalOriginsBlocked = blocked;
  report.status = 'completed';
} catch (error) {
  report.status = 'failed';
  report.failure = error.stack;
  if (page) await screenshot(page, 'failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  heartbeats.forEach(clearInterval);
  // Seal and export evidence while the browser and harness are still alive.
  // Cleanup must also happen if evidence validation/export fails.
  try {
  if (context) await context.tracing.stop({ path: resolve(artifacts, 'trace.zip') });
  if (server) {
    report.sourceInputs = {};
    for (const path of server.moduleGraph.idToModuleMap.keys()) {
      const file = path.split('?')[0];
      if (file.startsWith(resolve(root, 'app/frontend') + '/') && /\.(tsx?|css)$/.test(file)) {
        report.sourceInputs[file.slice(root.length + 1)] = sha(await readFile(file));
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  for (const name of ['harness.tsx', 'harness.css', 'server.mjs', 'package.json', 'package-lock.json',
    'run.py', 'setup.py', 'preflight.py', 'browser-libs.py', 'evidence.py', 'index.html',
    'fonts.conf', 'apt-isolated.conf', 'debian.sources.list']) {
    report.inputs ??= {};
    report.inputs[name] = sha(await readFile(resolve(here, name)));
  }
  report.inputs['test/f0/mobile/browser.mjs'] = sha(await readFile(fileURLToPath(import.meta.url)));
  const lock = JSON.parse(await readFile(resolve(here, 'package-lock.json')));
  report.dependencyVersions = Object.fromEntries(Object.entries(lock.packages)
    .filter(([name]) => name).map(([name, value]) => [name, value.version]));
  report.exitCode = process.exitCode || 0;
  report.sourceModuleCount = Object.keys(report.sourceInputs || {}).length;
  report.scenarios = report.checks;
  report.dependencyArchives = {};
  const archives = resolve(here, '.runtime/apt/downloads');
  for (const name of await readdir(archives).catch(() => [])) {
    if (name.endsWith('.deb')) report.dependencyArchives[name] = sha(await readFile(resolve(archives, name)));
  }
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  execFileSync('python3', [resolve(here, 'evidence.py'), 'export', artifacts], { cwd: root, stdio: 'inherit' });
  console.log(JSON.stringify({ status: report.status, checks: report.checks,
    failure: report.failure, layout: report.layout, report: resolve(artifacts, 'report.json') }, null, 2));
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
}
