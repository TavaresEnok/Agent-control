/**
 * Exame real da imagem ac-design.
 * Não importa nem executa código do repositório. Lê CSS como texto e abre só DESIGN_TARGET_URL.
 * O plano chega em /output/pedido.json, gravado pelo host antes do `docker run`.
 */
import {spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const HOST = /^(?:127\.0\.0\.1|localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local)$/;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'];
const VIEWPORTS = new Set([375, 768, 1440]);

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

function safeName(route, viewport, theme, state) {
  const slug = route.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'raiz';
  return `${slug}-${viewport}-${theme}-${state}.png`.slice(0, 140);
}

function readPlan(origin) {
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync('/output/pedido.json', 'utf8'));
  } catch {
    parsed = null;
  }
  const routes = [];
  const source = parsed && Array.isArray(parsed.routes) ? parsed.routes : [{route: '/', themes: ['claro'], states: ['padrao']}];
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const route = typeof item.route === 'string' && item.route.startsWith('/') ? item.route.slice(0, 200) : null;
    if (!route || route.includes('..') || route.includes('\\') || route.includes('//')) continue;
    const themes = Array.isArray(item.themes) ? item.themes.filter(theme => theme === 'claro' || theme === 'escuro') : ['claro'];
    const states = Array.isArray(item.states) ? item.states.filter(state => /^(?:padrao|vazio|carregando|erro|logado)$/.test(state)) : ['padrao'];
    routes.push({
      route,
      themes: themes.length > 0 ? [...new Set(themes)] : ['claro'],
      states: states.length > 0 ? [...new Set(states)] : ['padrao'],
    });
    if (routes.length >= 40) break;
  }
  if (routes.length === 0) routes.push({route: '/', themes: ['claro'], states: ['padrao']});
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

function pageUrl(origin, route, state) {
  const url = new URL(route, origin);
  if (url.origin !== origin) refuse('DESIGN_TARGET_ESCAPE');
  if (state !== 'padrao') url.searchParams.set('estado', state);
  return url.href;
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
  if (plan.note) notes.push(plan.note);

  let playwright;
  let AxeBuilder;
  let browser;
  try {
    playwright = await import('playwright');
    const axeMod = await import('@axe-core/playwright');
    AxeBuilder = axeMod.default ?? axeMod.AxeBuilder;
    browser = await playwright.chromium.launch({
      executablePath: chrome ?? undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  } catch (error) {
    coverage.push(row('axe-core', packageVersion('axe-core'), '0 rotas × 0 viewports', 0, `DESIGN_AXE_FAILED ${error instanceof Error ? error.message : 'erro'}`));
    browser = null;
  }

  const cells = [];
  for (const route of plan.routes) {
    for (const theme of route.themes) {
      for (const state of route.states) {
        for (const viewport of plan.viewports) cells.push({route: route.route, theme, state, viewport});
      }
    }
  }

  if (browser) {
    const context = await browser.newContext({serviceWorkers: 'block'});
    const page = await context.newPage();
    let axeFindings = 0;
    let axeFailure = '';
    for (const cell of cells) {
      const fileName = safeName(cell.route, cell.viewport, cell.theme, cell.state);
      try {
        await page.setViewportSize({width: cell.viewport, height: cell.viewport === 375 ? 812 : cell.viewport === 768 ? 1024 : 900});
        await page.emulateMedia({colorScheme: cell.theme === 'escuro' ? 'dark' : 'light'});
        const url = pageUrl(target.origin, cell.route, cell.state);
        await page.goto(url, {waitUntil: 'load', timeout: 20000});
        const shot = join('/output/capturas', fileName);
        await page.screenshot({path: shot, fullPage: true, type: 'png'});
        screenshots.push({fileName, route: cell.route, viewport: cell.viewport, theme: cell.theme, state: cell.state});
        const samples = await page.evaluate(() => {
          const out = [];
          const seen = new Set();
          const nodes = [document.body, ...document.body.querySelectorAll('*')];
          for (const el of nodes) {
            if (!el || out.length >= 500) break;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) continue;
            const record = {
              selector: el.tagName.toLowerCase(),
              color: style.color,
              backgroundColor: style.backgroundColor,
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
          axeReports.push({
            file: `${cell.route} ${cell.viewport} ${cell.theme} ${cell.state}`,
            route: cell.route,
            viewport: cell.viewport,
            theme: cell.theme,
            state: cell.state,
            json: results,
          });
        } catch (error) {
          axeFailure = `DESIGN_AXE_FAILED ${error instanceof Error ? error.message : 'erro'}`;
        }
      } catch (error) {
        axeFailure = `DESIGN_AXE_FAILED ${error instanceof Error ? error.message : 'erro'}`;
        notes.push(`captura falhou ${cell.route} ${cell.viewport}: ${axeFailure}`.slice(0, 300));
      }
    }
    await browser.close();
    coverage.push(row(
      'axe-core',
      packageVersion('axe-core'),
      `${plan.routes.length} rotas × ${plan.viewports.length} viewports × ${new Set(cells.map(cell => cell.theme)).size} temas`,
      axeFindings,
      axeFailure,
    ));
  }

  let pa11yFindings = 0;
  let pa11yFailure = '';
  let pa11yRan = 0;
  const pa11yBin = '/opt/design-tools/node_modules/.bin/pa11y';
  const pa11yConfig = '/tmp/pa11y.json';
  writeFileSync(pa11yConfig, JSON.stringify({
    chromeLaunchConfig: {
      executablePath: chrome ?? undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  }));
  for (const route of plan.routes) {
    for (const runner of ['axe', 'htmlcs']) {
      try {
        const url = pageUrl(target.origin, route.route, 'padrao');
        const run = spawnSync(pa11yBin, [url, '--reporter', 'json', '--timeout', '25000', '--runner', runner, '--config', pa11yConfig], {
          encoding: 'utf8', timeout: 60000, cwd: '/tmp', env: process.env, shell: false, maxBuffer: 8 * 1024 * 1024,
        });
        pa11yRan += 1;
        let json = [];
        try {
          json = JSON.parse(run.stdout || '[]');
        } catch {
          json = [];
          if (run.status !== 0) pa11yFailure = `DESIGN_PA11Y_FAILED status ${run.status} ${(run.stderr || '').slice(0, 180)}`;
        }
        const issues = Array.isArray(json) ? json : [];
        pa11yFindings += issues.length;
        pa11yReports.push({file: `${route.route} ${runner}`, route: route.route, runner, json: issues});
        if (run.status !== 0 && issues.length === 0) {
          pa11yFailure = pa11yFailure || `DESIGN_PA11Y_FAILED status ${run.status} ${(run.stderr || '').slice(0, 180)}`;
        }
      } catch (error) {
        pa11yFailure = `DESIGN_PA11Y_FAILED ${error instanceof Error ? error.message : 'erro'}`;
      }
    }
  }
  coverage.push(row('pa11y', packageVersion('pa11y'), `${pa11yRan} urls × runners axe+htmlcs`, pa11yFindings, pa11yFailure));

  let lhFindings = 0;
  let lhFailure = '';
  let lhRan = 0;
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
          const url = pageUrl(target.origin, route.route, 'padrao');
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
          lhRan += 1;
          const lhr = slimLighthouse(result?.lhr ?? null);
          if (lhr) {
            const perf = lhr.categories?.performance?.score;
            const cls = lhr.audits?.['cumulative-layout-shift']?.numericValue;
            const lcp = lhr.audits?.['largest-contentful-paint']?.numericValue;
            if ((typeof perf === 'number' && perf < 0.5) || (typeof cls === 'number' && cls > 0.25) || (typeof lcp === 'number' && lcp > 4000)) lhFindings += 1;
            lighthouseReports.push({file: `${route.route} ${formFactor}`, route: route.route, formFactor, lhr});
          } else {
            lhFailure = 'DESIGN_LIGHTHOUSE_FAILED sem LHR';
          }
        } catch (error) {
          lhFailure = `DESIGN_LIGHTHOUSE_FAILED ${error instanceof Error ? error.message : 'erro'}`;
        } finally {
          if (chromeSession) await chromeSession.kill().catch(() => undefined);
        }
      }
    }
  } catch (error) {
    lhFailure = `DESIGN_LIGHTHOUSE_FAILED ${error instanceof Error ? error.message : 'erro'}`;
  }
  coverage.push(row('lighthouse', packageVersion('lighthouse'), `${lhRan} corridas mobile+desktop`, lhFindings, lhFailure));

  const css = [];
  listCss('/repository', 0, css);
  let styleFindings = 0;
  let styleFailure = '';
  try {
    const stylelintMod = await import('stylelint');
    const stylelint = stylelintMod.default ?? stylelintMod;
    if (css.length === 0) {
      styleFailure = 'nenhum CSS em /repository';
    } else {
      const result = await stylelint.lint({
        files: css,
        config: plan.stylelint,
        cwd: '/tmp',
      });
      const results = Array.isArray(result?.results) ? result.results : [];
      for (const item of results) styleFindings += Array.isArray(item.warnings) ? item.warnings.length : 0;
      stylelintReports.push({file: 'repository', report: {results: results.map(plainStylelintResult)}});
    }
  } catch (error) {
    styleFailure = `DESIGN_STYLELINT_FAILED ${error instanceof Error ? error.message : 'erro'}`;
  }
  coverage.push(row('stylelint', packageVersion('stylelint'), `${css.length} arquivos css`, styleFindings, styleFailure));

  let analyzerFailure = '';
  let analyzerCount = 0;
  try {
    const imported = await import('@projectwallace/css-analyzer');
    const analyze = imported.analyze ?? imported.default?.analyze;
    if (typeof analyze !== 'function') throw new Error('analyze ausente');
    for (const file of css) {
      const text = readFileSync(file, 'utf8').slice(0, 200_000);
      analyzerReports.push({file, source: 'repositorio', report: analyze(text)});
      analyzerCount += 1;
    }
    for (const block of computed) {
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
      const file = `computado ${block.route} ${block.viewport} ${block.theme}`;
      analyzerReports.push({file, source: 'computado', report: analyze(lines.join('\n'))});
      analyzerCount += 1;
    }
  } catch (error) {
    analyzerFailure = `DESIGN_CSS_ANALYZER_FAILED ${error instanceof Error ? error.message : 'erro'}`;
  }
  coverage.push(row('css-analyzer', packageVersion('@projectwallace/css-analyzer'), `${analyzerCount} folhas`, analyzerReports.length, analyzerFailure));

  const required = ['axe-core', 'pa11y', 'lighthouse', 'stylelint', 'css-analyzer'];
  for (const tool of required) {
    if (!coverage.some(item => item.tool === tool)) coverage.push(row(tool, 'desconhecida', '0', 0, 'DESIGN_TOOL_MISSING'));
  }

  const body = {
    schema: 'design-achados-brutos-1',
    target: target.origin,
    findings: [],
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

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
