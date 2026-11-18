/**
 * Exame real da imagem ac-design.
 * Não importa nem executa código do repositório. Lê CSS como texto e abre só DESIGN_TARGET_URL.
 * O plano chega em /output/pedido.json, gravado pelo host antes do `docker run`.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const HOST = /^(?:127\.0\.0\.1|localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local)$/;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'];
const VIEWPORTS = new Set([375, 768, 1440]);
const STATE_NAMES = new Set(['padrao', 'vazio', 'carregando', 'erro', 'logado']);
const SHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,140}\.png$/;
const LOGIN_STATE = '/login/state.json';

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

function packageVersion(name) {
  try {
    const parsed = JSON.parse(readFileSync(`/opt/design-tools/node_modules/${name}/package.json`, 'utf8'));
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : 'desconhecida';
  } catch {
    return 'desconhecida';
  }
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
        /* próximo */
      }
    }
  }
  return null;
}

function listCss(directory, depth, out) {
  if (depth > 8 || out.length >= 80) return;
  let entries;
  try {
    entries = readdirSync(directory, {withFileTypes: true});
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= 80 || entry.name === 'node_modules' || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) listCss(full, depth + 1, out);
    else if (entry.isFile() && entry.name.endsWith('.css')) out.push(full);
  }
}

function row(tool, version, executed, findings, failure) {
  return {
    tool,
    version: version && String(version).trim() ? String(version).slice(0, 80) : 'desconhecida',
    executed: executed && String(executed).trim() ? String(executed).slice(0, 240) : '0',
    findings: Number.isFinite(findings) ? Math.max(0, Math.trunc(findings)) : 0,
    failure: failure && String(failure).trim() ? String(failure).replace(/\s+/g, ' ').trim().slice(0, 400) : 'nenhuma',
  };
}

/**
 * pa11y termina com 0 sem achados e com 2 quando há achados. Os dois contam como célula feita.
 * Status ausente, outro status, ou JSON que não é uma lista é falha: a célula não entra em Executado.
 */
export function classifyPa11yRun(status, stdout) {
  if (typeof status !== 'number') return {ok: false, issues: [], detail: 'não terminou'};
  const parsed = parseToolStdout(stdout);
  if (!parsed.ok || !Array.isArray(parsed.value)) {
    return {ok: false, issues: [], detail: `status ${status} json inválido`};
  }
  if (status !== 0 && status !== 2) return {ok: false, issues: [], detail: `status ${status}`};
  return {ok: true, issues: parsed.value, detail: ''};
}

/** Uma falha fica na linha da ferramenta. As outras linhas continuam com "nenhuma". css-analyzer deixa a contagem de achados para o host. */
export function coverageRows(parts) {
  return [
    row('axe-core', parts.versions.axe, parts.executed.axe, parts.findings.axe, failureText(parts.failures.axe)),
    row('pa11y', parts.versions.pa11y, parts.executed.pa11y, parts.findings.pa11y, failureText(parts.failures.pa11y)),
    row('lighthouse', parts.versions.lighthouse, parts.executed.lighthouse, parts.findings.lighthouse, failureText(parts.failures.lighthouse)),
    row('stylelint', parts.versions.stylelint, parts.executed.stylelint, parts.findings.stylelint, failureText(parts.failures.stylelint)),
    row('css-analyzer', parts.versions.analyzer, parts.executed.analyzer, 0, failureText(parts.failures.analyzer)),
  ];
}

/** Até 8 itens; se houver mais, o total fica no prefixo e o resto em "e mais N". */
export function failureText(items) {
  const list = [];
  for (const item of items) {
    const text = String(item ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > 0) list.push(text);
  }
  if (list.length === 0) return '';
  const noun = list.length === 1 ? 'falha' : 'falhas';
  const extra = list.length > 8 ? `; e mais ${list.length - 8}` : '';
  const head = `${list.length} ${noun}: `;
  const budget = Math.max(0, 400 - head.length - extra.length);
  const parts = [];
  let used = 0;
  for (const [index, item] of list.slice(0, 8).entries()) {
    const sep = index === 0 ? 0 : 2;
    const room = budget - used - sep;
    if (room < 8) break;
    const piece = item.slice(0, room);
    parts.push(piece);
    used += sep + piece.length;
  }
  return `${head}${parts.join('; ')}${extra}`;
}

function viewportHeight(width) {
  if (width === 375) return 812;
  if (width === 768) return 1024;
  return 900;
}

/** 8 hex de sha256 da rota, para /a-b e /a/b não colidirem. */
export function routeShotName(route, viewport, theme, state) {
  const hash = createHash('sha256').update(String(route)).digest('hex').slice(0, 8);
  const slug = String(route).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'raiz';
  const themeSlug = theme === 'escuro' ? 'escuro' : 'claro';
  const stateSlug = String(state).replace(/[^A-Za-z0-9]+/g, '').slice(0, 24) || 'padrao';
  const viewportSlug = String(viewport).replace(/[^0-9]/g, '').slice(0, 4) || '0';
  const name = `${slug}-${hash}-${viewportSlug}-${themeSlug}-${stateSlug}.png`;
  if (SHOT_NAME.test(name)) return name;
  const fallback = `r-${hash}-${viewportSlug}-${themeSlug}-${stateSlug}.png`;
  return SHOT_NAME.test(fallback) ? fallback : `r-${hash}.png`;
}

export function parseAction(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+$/g, '');
  if (text.length < 1 || text.length > 500 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  let match = /^clicar\s+(\S(?:.*\S)?)$/.exec(text);
  if (match) {
    const selector = match[1];
    if (selector.length > 180) return null;
    return {op: 'click', selector};
  }
  match = /^esperar\s+(\S(?:.*\S)?)$/.exec(text);
  if (match) {
    const selector = match[1];
    if (selector.length > 180) return null;
    return {op: 'wait', selector};
  }
  match = /^preencher\s+(\S+)\s([\s\S]*)$/.exec(text);
  if (!match) return null;
  const selector = match[1];
  const filled = match[2];
  if (selector.length > 180 || selector.length < 1 || filled.length > 400) return null;
  return {op: 'fill', selector, text: filled};
}

/** Caminho relativo ao origin. Outro host, esquema ou `..` não resolve. */
export function resolveDeclaredUrl(origin, value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) return null;
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return null;
  if (value.includes('..') || value.includes('//') || value.includes('\\')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  let url;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username !== '' || url.password !== '') return null;
  return url.href;
}

function stateLabel(name) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return clean.length > 0 ? clean : 'sem nome';
}

/**
 * String só captura 'padrao'. Os outros exigem url ou acoes no objeto.
 * Logado não leva query; o arquivo de sessão é decisão de quem chama.
 */
export function normalizeRouteStates(origin, source) {
  const states = [];
  const misses = [];
  const seen = new Set();
  const list = Array.isArray(source) ? source : ['padrao'];
  const miss = (name) => {
    misses.push(`estado ${stateLabel(name)} não capturado`);
  };
  for (const entry of list) {
    if (states.length >= 8) break;
    if (typeof entry === 'string') {
      if (entry !== 'padrao' || !STATE_NAMES.has(entry)) {
        miss(entry);
        continue;
      }
      if (seen.has('padrao')) continue;
      seen.add('padrao');
      states.push({name: 'padrao', href: null, actions: [], auth: false});
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      miss('sem nome');
      continue;
    }
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (!STATE_NAMES.has(name)) {
      miss(name);
      continue;
    }
    if (seen.has(name)) continue;
    const actions = [];
    const rejected = [];
    if (Array.isArray(entry.acoes)) {
      for (const action of entry.acoes) {
        const parsed = parseAction(action);
        if (parsed) actions.push(parsed);
        else rejected.push(typeof action === 'string' ? action : 'ação');
      }
    }
    const urlGiven = typeof entry.url === 'string' && entry.url.length > 0;
    const href = urlGiven ? resolveDeclaredUrl(origin, entry.url) : null;
    if (urlGiven && href === null) {
      miss(name);
      continue;
    }
    const reachable = name === 'padrao' || name === 'logado' || href !== null || actions.length > 0;
    if (!reachable) {
      miss(name);
      continue;
    }
    for (const action of rejected) {
      misses.push(`não capturado: ${stateLabel(action)}`);
    }
    seen.add(name);
    states.push({name, href, actions, auth: name === 'logado'});
  }
  if (states.length === 0) states.push({name: 'padrao', href: null, actions: [], auth: false});
  return {states, misses};
}

function routeUrl(origin, route) {
  const url = new URL(route, origin);
  if (url.origin !== origin) refuse('DESIGN_TARGET_ESCAPE');
  return url.href;
}

function loginFileReady() {
  try {
    return statSync(LOGIN_STATE).isFile();
  } catch {
    return false;
  }
}

function readPlan(origin) {
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync('/output/pedido.json', 'utf8'));
  } catch {
    parsed = null;
  }
  const routes = [];
  const misses = [];
  const source = parsed && Array.isArray(parsed.routes) ? parsed.routes : [{route: '/', themes: ['claro'], states: ['padrao']}];
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const route = typeof item.route === 'string' && item.route.startsWith('/') ? item.route.slice(0, 200) : null;
    if (!route || route.includes('..') || route.includes('\\') || route.includes('//')) continue;
    const themes = Array.isArray(item.themes) ? item.themes.filter(theme => theme === 'claro' || theme === 'escuro') : ['claro'];
    const normalized = normalizeRouteStates(origin, item.states);
    misses.push(...normalized.misses);
    routes.push({
      route,
      themes: themes.length > 0 ? [...new Set(themes)] : ['claro'],
      states: normalized.states,
    });
    if (routes.length >= 40) break;
  }
  if (routes.length === 0) {
    const normalized = normalizeRouteStates(origin, ['padrao']);
    routes.push({route: '/', themes: ['claro'], states: normalized.states});
  }
  const viewports = Array.isArray(parsed?.viewports)
    ? parsed.viewports.map(Number).filter(value => VIEWPORTS.has(value))
    : [375, 768, 1440];
  const stylelint = parsed && parsed.stylelint && typeof parsed.stylelint === 'object' ? parsed.stylelint : {
    rules: {'block-no-empty': true, 'color-no-invalid-hex': true, 'declaration-no-important': true},
  };
  return {
    origin,
    routes,
    viewports: viewports.length > 0 ? [...new Set(viewports)] : [375, 768, 1440],
    stylelint,
    misses,
    note: parsed ? null : 'pedido.json ausente: só a raiz, tema claro, estado padrão',
  };
}

function plainStylelintResult(item) {
  const warnings = Array.isArray(item?.warnings) ? item.warnings : [];
  return {
    source: typeof item?.source === 'string' ? item.source : '',
    warnings: warnings.map(warning => ({
      line: warning?.line ?? null,
      column: warning?.column ?? null,
      rule: typeof warning?.rule === 'string' ? warning.rule : '',
      severity: typeof warning?.severity === 'string' ? warning.severity : '',
      text: typeof warning?.text === 'string' ? warning.text : '',
    })),
  };
}

function safeJson(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'function' || typeof item === 'symbol') return undefined;
    if (item && typeof item === 'object') {
      if (seen.has(item)) return undefined;
      seen.add(item);
    }
    return item;
  });
}

function slimLighthouse(lhr) {
  if (!lhr || typeof lhr !== 'object') return null;
  const categories = {};
  for (const [key, value] of Object.entries(lhr.categories ?? {})) {
    if (!value || typeof value !== 'object') continue;
    categories[key] = {id: key, title: value.title ?? key, score: value.score ?? null};
  }
  const audits = {};
  for (const id of ['cumulative-layout-shift', 'largest-contentful-paint', 'first-contentful-paint', 'total-blocking-time', 'speed-index', 'interactive']) {
    const audit = lhr.audits?.[id];
    if (!audit || typeof audit !== 'object') continue;
    audits[id] = {id, title: audit.title ?? id, score: audit.score ?? null, numericValue: audit.numericValue ?? null, displayValue: audit.displayValue ?? null};
  }
  return {
    lighthouseVersion: lhr.lighthouseVersion ?? null,
    requestedUrl: lhr.requestedUrl ?? null,
    finalUrl: lhr.finalUrl ?? null,
    fetchTime: lhr.fetchTime ?? null,
    configSettings: {formFactor: lhr.configSettings?.formFactor ?? null},
    categories,
    audits,
  };
}

function shortError(error) {
  const message = error instanceof Error ? error.message : 'erro';
  return message.replace(/\s+/g, ' ').trim().slice(0, 100);
}

function parseToolStdout(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : '';
  if (text.length === 0) return {ok: false, value: null};
  try {
    return {ok: true, value: JSON.parse(text)};
  } catch {
    return {ok: false, value: null};
  }
}

function warningCount(results) {
  let count = 0;
  for (const item of results) count += Array.isArray(item?.warnings) ? item.warnings.length : 0;
  return count;
}

async function readStyleBlocks(page) {
  try {
    const blocks = await page.evaluate(() => {
      const out = [];
      const nodes = document.querySelectorAll('style');
      for (const node of nodes) {
        if (out.length >= 20) break;
        const text = node.textContent || '';
        if (text.trim().length > 0) out.push(text);
      }
      return out;
    });
    return Array.isArray(blocks) ? blocks.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

async function runActions(page, actions) {
  for (const action of actions) {
    if (action.op === 'click') await page.click(action.selector, {timeout: 5000});
    else if (action.op === 'fill') await page.fill(action.selector, action.text, {timeout: 5000});
    else if (action.op === 'wait') await page.waitForSelector(action.selector, {timeout: 5000});
    else return false;
  }
  return true;
}

async function main() {
  const target = targetOf(process.env.DESIGN_TARGET_URL ?? '');
  const plan = readPlan(target.origin);
  const chrome = findChrome();
  if (chrome) process.env.PUPPETEER_EXECUTABLE_PATH = chrome;
  mkdirSync('/output/capturas', {recursive: true});
  const coverage = [];
  const axeReports = [];
  const pa11yReports = [];
  const lighthouseReports = [];
  const stylelintReports = [];
  const analyzerReports = [];
  const computed = [];
  const screenshots = [];
  const notes = ['Não executa código do repositório. A rede design-homologation não tem saída genérica.'];
  const seenNotes = new Set(notes);
  const note = (text) => {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (clean.length === 0 || seenNotes.has(clean)) return;
    seenNotes.add(clean);
    notes.push(clean);
  };
  if (plan.note) note(plan.note);
  for (const item of plan.misses) note(item);

  const unavailable = [];
  const findings = [];
  const seenFindings = new Set();
  const markUnavailable = (cell, status) => {
    const code = Number.isInteger(status) && status > 0 ? status : 0;
    unavailable.push({route: cell.route, viewport: cell.viewport, theme: cell.theme, state: cell.state, status: code});
    note(`rota indisponível (${code}) ${cell.route} ${cell.viewport} ${cell.theme} ${cell.state}`);
    const key = `${cell.route}\u0000${code}`;
    if (seenFindings.has(key)) return;
    seenFindings.add(key);
    findings.push({
      tool: 'navegacao',
      rule: 'DESIGN-ROTA-INDISPONIVEL',
      severity: 'alta',
      file: cell.route,
      snippet: `rota indisponível (${code})`,
    });
  };

  let playwright;
  let AxeBuilder;
  let browser;
  const axeFailures = [];
  try {
    playwright = await import('playwright');
    const axeMod = await import('@axe-core/playwright');
    AxeBuilder = axeMod.default ?? axeMod.AxeBuilder;
    browser = await playwright.chromium.launch({
      executablePath: chrome ?? undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  } catch (error) {
    axeFailures.push(`DESIGN_AXE_FAILED ${shortError(error)}`);
    browser = null;
  }

  const loginRequested = plan.routes.some(route => route.states.some(state => state.auth));
  const loginReady = loginRequested && loginFileReady();
  if (loginRequested && !loginReady) note('logado não capturado');

  const cells = [];
  for (const route of plan.routes) {
    for (const theme of route.themes) {
      for (const state of route.states) {
        if (state.auth && !loginReady) continue;
        for (const viewport of plan.viewports) {
          cells.push({
            route: route.route,
            theme,
            state: state.name,
            viewport,
            href: state.href,
            actions: state.actions,
            auth: state.auth,
          });
        }
      }
    }
  }

  const pageStyles = [];
  const seenStyles = new Set();
  const rememberStyles = (blocks) => {
    for (const block of blocks) {
      const text = String(block).slice(0, 200_000);
      if (text.trim().length === 0 || seenStyles.has(text) || pageStyles.length >= 40) continue;
      seenStyles.add(text);
      pageStyles.push(text);
    }
  };

  let axeFinished = 0;
  let axeFindings = 0;
  if (browser) {
    let anonContext;
    let authContext;
    try {
      anonContext = await browser.newContext({serviceWorkers: 'block'});
      const anonPage = await anonContext.newPage();
      let authPage = null;
      if (loginReady) {
        try {
          authContext = await browser.newContext({serviceWorkers: 'block', storageState: LOGIN_STATE});
          authPage = await authContext.newPage();
        } catch {
          note('logado não capturado');
          authPage = null;
        }
      }
      for (const cell of cells) {
        const page = cell.auth ? authPage : anonPage;
        if (!page) {
          note('logado não capturado');
          continue;
        }
        const fileName = routeShotName(cell.route, cell.viewport, cell.theme, cell.state);
        try {
          await page.setViewportSize({width: cell.viewport, height: viewportHeight(cell.viewport)});
          await page.emulateMedia({colorScheme: cell.theme === 'escuro' ? 'dark' : 'light'});
          const url = cell.href ?? routeUrl(target.origin, cell.route);
          let response;
          try {
            response = await page.goto(url, {waitUntil: 'load', timeout: 20000});
          } catch {
            markUnavailable(cell, 0);
            continue;
          }
          const status = response && Number.isInteger(response.status()) ? response.status() : 0;
          let landed = null;
          try {
            landed = new URL(page.url());
          } catch {
            landed = null;
          }
          if (status >= 400 || status === 0 || !landed || landed.origin !== target.origin) {
            markUnavailable(cell, status >= 400 ? status : 0);
            continue;
          }
          rememberStyles(await readStyleBlocks(page));
          try {
            const acted = await runActions(page, cell.actions);
            if (!acted) {
              note(`estado ${cell.state} não capturado`);
              continue;
            }
          } catch {
            note(`estado ${cell.state} não capturado`);
            continue;
          }
          rememberStyles(await readStyleBlocks(page));
          const shot = join('/output/capturas', fileName);
          await page.screenshot({path: shot, fullPage: true, type: 'png'});
          screenshots.push({fileName, route: cell.route, viewport: cell.viewport, theme: cell.theme, state: cell.state});
          const samples = await page.evaluate(() => {
            function parseColor(value) {
              if (!value) return null;
              const text = String(value).trim().toLowerCase();
              if (text === 'transparent') return {r: 0, g: 0, b: 0, a: 0};
              const comma = /^rgba?\(\s*([+-]?[\d.]+)\s*,\s*([+-]?[\d.]+)\s*,\s*([+-]?[\d.]+)\s*(?:,\s*([+-]?[\d.]+%?)\s*)?\)$/.exec(text);
              const space = /^rgba?\(\s*([+-]?[\d.]+)\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)\s*(?:\/\s*([+-]?[\d.]+%?)\s*)?\)$/.exec(text);
              const match = comma || space;
              if (!match) return null;
              const channel = (raw) => {
                const number = Number(raw);
                if (!Number.isFinite(number)) return null;
                return Math.min(255, Math.max(0, number));
              };
              const red = channel(match[1]);
              const green = channel(match[2]);
              const blue = channel(match[3]);
              if (red === null || green === null || blue === null) return null;
              let alpha = 1;
              if (match[4] !== undefined) {
                const token = match[4];
                alpha = token.endsWith('%') ? Number(token.slice(0, -1)) / 100 : Number(token);
              }
              if (!Number.isFinite(alpha)) return null;
              return {r: red, g: green, b: blue, a: Math.min(1, Math.max(0, alpha))};
            }
            function over(src, dst) {
              const outA = src.a + dst.a * (1 - src.a);
              if (outA <= 0) return {r: 255, g: 255, b: 255, a: 1};
              const mix = (srcChannel, dstChannel) => (srcChannel * src.a + dstChannel * dst.a * (1 - src.a)) / outA;
              return {r: mix(src.r, dst.r), g: mix(src.g, dst.g), b: mix(src.b, dst.b), a: outA};
            }
            function rgb(color) {
              const channel = (value) => Math.max(0, Math.min(255, Math.round(value)));
              return `rgb(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)})`;
            }
            // Canvas sem cor opaca compõe sobre branco. Imagem ou gradiente não vira preto.
            function effective(el) {
              const layers = [];
              let node = el;
              while (node && node.nodeType === 1) {
                const background = getComputedStyle(node);
                if (background.backgroundImage && background.backgroundImage !== 'none') return null;
                const color = parseColor(background.backgroundColor);
                if (!color) return null;
                if (color.a > 0) layers.push(color);
                if (color.a >= 0.999) break;
                node = node.parentElement;
              }
              let acc = {r: 255, g: 255, b: 255, a: 1};
              for (let index = layers.length - 1; index >= 0; index -= 1) acc = over(layers[index], acc);
              return rgb(acc);
            }
            function hasText(el) {
              const nodes = el.childNodes;
              for (let index = 0; index < nodes.length; index += 1) {
                const node = nodes[index];
                if (node.nodeType === 3 && node.textContent && node.textContent.trim().length > 0) return true;
              }
              return false;
            }
            const out = [];
            const seen = new Set();
            const root = document.body;
            if (!root) return out;
            const nodes = [root, ...root.querySelectorAll('*')];
            for (const el of nodes) {
              if (!el || out.length >= 500) break;
              const style = getComputedStyle(el);
              const opacity = Number(style.opacity);
              if (style.display === 'none' || style.visibility !== 'visible' || (Number.isFinite(opacity) && opacity === 0)) continue;
              const rect = el.getBoundingClientRect();
              if (rect.width < 1 || rect.height < 1) continue;
              const record = {
                selector: el.tagName.toLowerCase(),
                color: style.color,
                borderColor: style.borderTopColor,
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                lineHeight: style.lineHeight,
                letterSpacing: style.letterSpacing,
                margin: style.margin,
                padding: style.padding,
                gap: style.gap,
                borderRadius: style.borderRadius,
                boxShadow: style.boxShadow,
                transitionDuration: style.transitionDuration,
                width: `${Math.round(rect.width)}px`,
                height: `${Math.round(rect.height)}px`,
              };
              if (hasText(el)) {
                const background = effective(el);
                if (background) record.backgroundColor = background;
                else record.contrastNote = 'nao-medido';
              } else if (!(style.backgroundImage && style.backgroundImage !== 'none')) {
                const own = parseColor(style.backgroundColor);
                if (own && own.a >= 0.999) record.backgroundColor = rgb(own);
              }
              const key = JSON.stringify(record);
              if (seen.has(key)) continue;
              seen.add(key);
              out.push(record);
            }
            return out;
          });
          computed.push({route: cell.route, viewport: cell.viewport, theme: cell.theme, state: cell.state, samples});
          try {
            const results = await new AxeBuilder({page}).withTags(AXE_TAGS).analyze();
            const violations = Array.isArray(results?.violations) ? results.violations.length : 0;
            axeFindings += violations;
            axeFinished += 1;
            axeReports.push({
              file: `${cell.route} ${cell.viewport} ${cell.theme} ${cell.state}`,
              route: cell.route,
              viewport: cell.viewport,
              theme: cell.theme,
              state: cell.state,
              json: results,
            });
          } catch (error) {
            axeFailures.push(`DESIGN_AXE_FAILED ${cell.route} ${cell.viewport} ${cell.theme} ${cell.state} ${shortError(error)}`);
          }
        } catch (error) {
          axeFailures.push(`DESIGN_AXE_FAILED ${cell.route} ${cell.viewport} ${cell.theme} ${cell.state} ${shortError(error)}`);
          note(`captura falhou ${cell.route} ${cell.viewport} ${cell.state}`);
        }
      }
    } catch (error) {
      axeFailures.push(`DESIGN_AXE_FAILED ${shortError(error)}`);
    } finally {
      await browser.close().catch(() => undefined);
      anonContext = null;
      authContext = null;
    }
  }
  let pa11yFindings = 0;
  let pa11yCells = 0;
  const pa11yFailures = [];
  const pa11yBin = '/opt/design-tools/node_modules/.bin/pa11y';
  const pa11yConfig = '/tmp/pa11y.json';
  for (const route of plan.routes) {
    for (const viewport of plan.viewports) {
      let cellDone = true;
      for (const runner of ['axe', 'htmlcs']) {
        const label = `${route.route} ${viewport} ${runner}`;
        try {
          writeFileSync(pa11yConfig, JSON.stringify({
            chromeLaunchConfig: {
              executablePath: chrome ?? undefined,
              args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            },
            viewport: {width: viewport, height: viewportHeight(viewport)},
          }));
          const url = routeUrl(target.origin, route.route);
          const run = spawnSync(pa11yBin, [url, '--reporter', 'json', '--timeout', '25000', '--runner', runner, '--config', pa11yConfig], {
            encoding: 'utf8', timeout: 60000, cwd: '/tmp', env: process.env, shell: false, maxBuffer: 8 * 1024 * 1024,
          });
          const judged = classifyPa11yRun(run.status, run.stdout);
          if (!judged.ok) {
            cellDone = false;
            pa11yFailures.push(`DESIGN_PA11Y_FAILED ${label} ${judged.detail}`);
            continue;
          }
          pa11yFindings += judged.issues.length;
          pa11yReports.push({file: label, route: route.route, viewport, runner, json: judged.issues});
        } catch (error) {
          cellDone = false;
          pa11yFailures.push(`DESIGN_PA11Y_FAILED ${label} ${shortError(error)}`);
        }
      }
      if (cellDone) pa11yCells += 1;
    }
  }


  let lhFindings = 0;
  let mobileDone = 0;
  let desktopDone = 0;
  const lhFailures = [];
  try {
    const lighthouse = (await import('lighthouse')).default;
    const chromeLauncher = await import('chrome-launcher');
    const launch = chromeLauncher.launch ?? chromeLauncher.default?.launch;
    if (typeof launch !== 'function' || typeof lighthouse !== 'function') throw new Error('lighthouse indisponível');
    for (const route of plan.routes) {
      for (const formFactor of ['mobile', 'desktop']) {
        const mobile = formFactor === 'mobile';
        let chromeSession;
        try {
          chromeSession = await launch({
            chromePath: chrome ?? undefined,
            chromeFlags: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
          });
          const url = routeUrl(target.origin, route.route);
          const result = await lighthouse(url, {
            port: chromeSession.port,
            output: 'json',
            logLevel: 'error',
            onlyCategories: ['accessibility', 'best-practices', 'performance', 'seo'],
            // O atraso plantado do laboratório está no servidor. A simulação padrão
            // reescreve esse tempo; a medida observada é a que o exame guarda.
            throttlingMethod: 'provided',
            formFactor,
            screenEmulation: mobile
              ? {mobile: true, width: 375, height: 812, deviceScaleFactor: 2, disabled: false}
              : {mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false},
          });
          const lhr = slimLighthouse(result?.lhr ?? null);
          if (!lhr) {
            lhFailures.push(`DESIGN_LIGHTHOUSE_FAILED ${route.route} ${formFactor} sem LHR`);
            continue;
          }
          if (mobile) mobileDone += 1;
          else desktopDone += 1;
          const perf = lhr.categories?.performance?.score;
          const cls = lhr.audits?.['cumulative-layout-shift']?.numericValue;
          const lcp = lhr.audits?.['largest-contentful-paint']?.numericValue;
          if ((typeof perf === 'number' && perf < 0.5) || (typeof cls === 'number' && cls > 0.25) || (typeof lcp === 'number' && lcp > 4000)) lhFindings += 1;
          lighthouseReports.push({file: `${route.route} ${formFactor}`, route: route.route, formFactor, lhr});
        } catch (error) {
          lhFailures.push(`DESIGN_LIGHTHOUSE_FAILED ${route.route} ${formFactor} ${shortError(error)}`);
        } finally {
          if (chromeSession) await chromeSession.kill().catch(() => undefined);
        }
      }
    }
  } catch (error) {
    lhFailures.push(`DESIGN_LIGHTHOUSE_FAILED ${shortError(error)}`);
  }


  const css = [];
  listCss('/repository', 0, css);
  let styleFindings = 0;
  let lintedBlocks = 0;
  const styleFailures = [];
  try {
    const stylelintMod = await import('stylelint');
    const stylelint = stylelintMod.default ?? stylelintMod;
    if (typeof stylelint?.lint !== 'function') throw new Error('stylelint indisponível');
    if (css.length > 0) {
      try {
        const result = await stylelint.lint({files: css, config: plan.stylelint, cwd: '/tmp'});
        const results = Array.isArray(result?.results) ? result.results : [];
        styleFindings += warningCount(results);
        stylelintReports.push({file: 'repository', report: {results: results.map(plainStylelintResult)}});
      } catch (error) {
        styleFailures.push(`DESIGN_STYLELINT_FAILED repositório ${shortError(error)}`);
      }
    }
    const pageResults = [];
    for (let index = 0; index < pageStyles.length; index += 1) {
      try {
        const result = await stylelint.lint({
          code: pageStyles[index],
          codeFilename: `/tmp/exam-style-${index}.css`,
          config: plan.stylelint,
          cwd: '/tmp',
        });
        const results = Array.isArray(result?.results) ? result.results : [];
        styleFindings += warningCount(results);
        pageResults.push(...results.map(plainStylelintResult));
        lintedBlocks += 1;
      } catch (error) {
        styleFailures.push(`DESIGN_STYLELINT_FAILED bloco ${index} ${shortError(error)}`);
      }
    }
    if (pageResults.length > 0) stylelintReports.push({file: 'pagina', report: {results: pageResults}});
  } catch (error) {
    styleFailures.push(`DESIGN_STYLELINT_FAILED ${shortError(error)}`);
  }


  const analyzerFailures = [];
  let analyzerCount = 0;
  try {
    const imported = await import('@projectwallace/css-analyzer');
    const analyze = imported.analyze ?? imported.default?.analyze;
    if (typeof analyze !== 'function') throw new Error('analyze ausente');
    for (const file of css) {
      try {
        const text = readFileSync(file, 'utf8').slice(0, 200_000);
        analyzerReports.push({file, source: 'repositorio', report: analyze(text)});
        analyzerCount += 1;
      } catch (error) {
        analyzerFailures.push(`DESIGN_CSS_ANALYZER_FAILED ${shortError(error)}`);
      }
    }
    for (const block of computed) {
      try {
        const lines = [];
        for (const sample of block.samples) {
          const decls = [];
          if (sample.color) decls.push(`color:${sample.color}`);
          if (sample.backgroundColor) decls.push(`background-color:${sample.backgroundColor}`);
          if (sample.fontFamily) decls.push(`font-family:${sample.fontFamily}`);
          if (sample.fontSize) decls.push(`font-size:${sample.fontSize}`);
          if (sample.margin) decls.push(`margin:${sample.margin}`);
          if (sample.padding) decls.push(`padding:${sample.padding}`);
          if (sample.gap && sample.gap !== 'normal') decls.push(`gap:${sample.gap}`);
          if (sample.borderRadius) decls.push(`border-radius:${sample.borderRadius}`);
          if (sample.boxShadow && sample.boxShadow !== 'none') decls.push(`box-shadow:${sample.boxShadow}`);
          if (decls.length === 0) continue;
          lines.push(`${sample.selector || 'el'}{${decls.join(';')}}`);
          if (lines.length >= 400) break;
        }
        if (lines.length === 0) continue;
        const file = `computado ${block.route} ${block.viewport} ${block.theme} ${block.state}`;
        analyzerReports.push({file, source: 'computado', report: analyze(lines.join('\n'))});
        analyzerCount += 1;
      } catch (error) {
        analyzerFailures.push(`DESIGN_CSS_ANALYZER_FAILED ${shortError(error)}`);
      }
    }
  } catch (error) {
    analyzerFailures.push(`DESIGN_CSS_ANALYZER_FAILED ${shortError(error)}`);
  }
  coverage.push(...coverageRows({
    versions: {
      axe: packageVersion('axe-core'),
      pa11y: packageVersion('pa11y'),
      lighthouse: packageVersion('lighthouse'),
      stylelint: packageVersion('stylelint'),
      analyzer: packageVersion('@projectwallace/css-analyzer'),
    },
    executed: {
      axe: `${axeFinished} células`,
      pa11y: `${pa11yCells} células rota×viewport`,
      lighthouse: `${mobileDone} mobile, ${desktopDone} desktop`,
      stylelint: `${css.length} arquivos do repositório, ${lintedBlocks} blocos de página`,
      analyzer: `${analyzerCount} folhas`,
    },
    findings: {
      axe: axeFindings,
      pa11y: pa11yFindings,
      lighthouse: lhFindings,
      stylelint: styleFindings,
    },
    failures: {
      axe: axeFailures,
      pa11y: pa11yFailures,
      lighthouse: lhFailures,
      stylelint: styleFailures,
      analyzer: analyzerFailures,
    },
  }));

  const required = ['axe-core', 'pa11y', 'lighthouse', 'stylelint', 'css-analyzer'];
  for (const tool of required) {
    if (!coverage.some(item => item.tool === tool)) coverage.push(row(tool, 'desconhecida', '0', 0, 'DESIGN_TOOL_MISSING'));
  }

  const body = {
    schema: 'design-achados-brutos-1',
    target: target.origin,
    findings,
    unavailable,
    reports: {
      axe: axeReports,
      pa11y: pa11yReports,
      lighthouse: lighthouseReports,
      stylelint: stylelintReports,
      cssAnalyzer: analyzerReports,
    },
    computed,
    screenshots,
    coverage,
    notes,
  };
  const temporary = '/output/achados-brutos.json.tmp';
  const destination = '/output/achados-brutos.json';
  writeFileSync(temporary, `${safeJson(body)}\n`);
  renameSync(temporary, destination);
}

function launchedAsEntry() {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return import.meta.url === pathToFileURL(argvPath).href;
  } catch {
    return true;
  }
}

if (launchedAsEntry()) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
