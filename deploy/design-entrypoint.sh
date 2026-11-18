#!/bin/sh
# Entrypoint da imagem de design.
# Não executa código do repositório montado em /repository.
# Lê DESIGN_TARGET_URL, recusa outro host e escreve /output/achados-brutos.json.
set -eu
cd /tmp
export HOME="${HOME:-/tmp}"
export TMPDIR="${TMPDIR:-/tmp}"
export PATH="/opt/design-tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"

exec node --input-type=module <<'DESIGN_ENTRYPOINT_END'
import {spawnSync} from 'node:child_process';
import {readdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const HOST = /^(?:127\.0\.0\.1|localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local)$/;

function writtenHost(value) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value);
  const authority = match?.[1] ?? '';
  if (authority === '' || authority.includes('@') || authority.startsWith('[')) return '';
  const colon = authority.lastIndexOf(':');
  if (colon > 0 && /^\d{1,5}$/.test(authority.slice(colon + 1))) return authority.slice(0, colon).toLowerCase();
  return authority.toLowerCase();
}

function refuse(message) {
  console.error(message);
  process.exit(2);
}

function targetOf(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) refuse('DESIGN_EXTERNAL_TARGET');
  if (/[\u0000-\u0020\u007f\\]/.test(value)) refuse('DESIGN_EXTERNAL_TARGET');
  let url;
  try {
    url = new URL(value);
  } catch {
    refuse('DESIGN_EXTERNAL_TARGET');
  }
  if (url.username !== '' || url.password !== '') refuse('DESIGN_EXTERNAL_TARGET');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') refuse('DESIGN_EXTERNAL_TARGET');
  const host = url.hostname.toLowerCase();
  if (!HOST.test(host) || writtenHost(value) !== host) refuse('DESIGN_EXTERNAL_TARGET');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) refuse('DESIGN_EXTERNAL_TARGET');
  return {host, port, origin: url.origin, protocol: url.protocol};
}

const target = targetOf(process.env.DESIGN_TARGET_URL ?? '');

function packageVersion(name) {
  try {
    const parsed = JSON.parse(readFileSync(`/opt/design-tools/node_modules/${name}/package.json`, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function cliVersion(file) {
  if (!file) return null;
  const run = spawnSync(file, ['--version'], {
    encoding: 'utf8', timeout: 20000, cwd: '/tmp', env: process.env, shell: false,
  });
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().slice(0, 300);
  return run.status === 0 ? text : null;
}

function findChrome() {
  let entries;
  try {
    entries = readdirSync('/ms-playwright', {withFileTypes: true});
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('chromium-')) continue;
    for (const relative of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = join('/ms-playwright', entry.name, relative);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* próximo candidato */
      }
    }
  }
  return null;
}

const tools = [];
for (const name of ['stylelint', 'pa11y', 'lhci']) {
  const file = `/opt/design-tools/node_modules/.bin/${name}`;
  const version = cliVersion(file);
  tools.push({tool: name, version, status: version ? 'disponivel' : 'ausente'});
}
tools.push({
  tool: 'axe-core',
  version: packageVersion('axe-core'),
  status: packageVersion('axe-core') ? 'disponivel' : 'ausente',
});
tools.push({
  tool: '@axe-core/playwright',
  version: packageVersion('@axe-core/playwright'),
  status: packageVersion('@axe-core/playwright') ? 'disponivel' : 'ausente',
});

const css = [];
function listCss(directory, depth) {
  if (depth > 6 || css.length >= 20) return;
  let entries;
  try {
    entries = readdirSync(directory, {withFileTypes: true});
  } catch {
    return;
  }
  for (const entry of entries) {
    if (css.length >= 20 || entry.name === 'node_modules' || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) listCss(full, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.css')) css.push(full);
  }
}
listCss('/repository', 0);

let analyzer = null;
try {
  const imported = await import('/opt/design-tools/node_modules/@projectwallace/css-analyzer/dist/index.js');
  analyzer = imported.analyze;
} catch {
  analyzer = null;
}
const cssNotes = [];
if (typeof analyzer === 'function') {
  for (const file of css) {
    try {
      const text = readFileSync(file, 'utf8').slice(0, 100_000);
      const report = analyzer(text);
      const complexity = report && report.stylesheet ? report.stylesheet.complexity : null;
      cssNotes.push({file, bytes: text.length, complexity});
    } catch (error) {
      cssNotes.push({file, error: String(error).slice(0, 200)});
    }
  }
}
tools.push({
  tool: 'css-analyzer',
  version: packageVersion('@projectwallace/css-analyzer'),
  status: analyzer ? 'disponivel' : 'ausente',
  files: cssNotes,
});

const chrome = findChrome();
if (chrome) process.env.PUPPETEER_EXECUTABLE_PATH = chrome;
const pa11y = '/opt/design-tools/node_modules/.bin/pa11y';
const pa11yConfig = '/tmp/pa11y.json';
writeFileSync(pa11yConfig, JSON.stringify({
  chromeLaunchConfig: {
    executablePath: chrome ?? undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
}), {mode: 0o600});
let pa11yRun = null;
try {
  if (statSync(pa11y).isFile()) {
    const run = spawnSync(pa11y, [target.origin, '--reporter', 'json', '--timeout', '20000', '--runner', 'axe', '--config', pa11yConfig], {
      encoding: 'utf8', timeout: 45000, cwd: '/tmp', env: process.env, shell: false,
    });
    pa11yRun = {
      status: run.status,
      stdout: `${run.stdout ?? ''}`.slice(0, 8000),
      stderr: `${run.stderr ?? ''}`.slice(0, 2000),
    };
  }
} catch (error) {
  pa11yRun = {status: null, stdout: '', stderr: String(error).slice(0, 200)};
}

const body = {
  schema: 'design-achados-brutos-1',
  target: target.origin,
  findings: [],
  tools,
  pa11y: pa11yRun,
  notes: [
    'Esqueleto da imagem de design. Não executa código do repositório.',
    'A rede design-homologation não tem saída genérica. Só a URL declarada é alvo.',
  ],
};
const temporary = '/output/achados-brutos.json.tmp';
const destination = '/output/achados-brutos.json';
try {
  writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, {mode: 0o600});
  renameSync(temporary, destination);
} catch (error) {
  console.error(`não foi possível escrever ${destination}: ${String(error)}`);
  process.exit(1);
}
DESIGN_ENTRYPOINT_END
