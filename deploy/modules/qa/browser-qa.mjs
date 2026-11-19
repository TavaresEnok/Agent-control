import {lstatSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {parse, serialize} from 'parse5';
import {chromium} from 'playwright-core';
import {compareVisualPng, compatibleReference, staticPngSize} from './visual-reference.mjs';

const require = createRequire(import.meta.url);
const pwPackage = require.resolve('playwright-core/package.json');
const playwright = require(pwPackage).version;
const browserVersion = require(join(dirname(pwPackage), 'browsers.json')).browsers
  .find(item => item.name === 'chromium-headless-shell').browserVersion;
const {baseImage} = require('./qa-tools.lock.json');
const origin = 'https://qa-snapshot.invalid';
const viewport = {width: 800, height: 600};
const presentation = {
  viewport, screen: viewport, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce',
  locale: 'pt-BR', timezoneId: 'UTC', isMobile: false, hasTouch: false, forcedColors: 'none',
};
const screenshot = {type: 'png', scale: 'css', animations: 'disabled', caret: 'hide', fullPage: false};
const csp = [
  "default-src 'none'", "script-src 'none'", "base-uri 'self'", "form-action 'none'",
  "style-src http: https: 'unsafe-inline'", 'img-src http: https:', "font-src 'none'",
].join('; ');
const maxPages = 12;
const pageMs = 5500;
const totalMs = 25000;
const maxFileBytes = 1024 * 1024;
const maxPageNodes = 6000;
const maxContrastFindings = 40;
const axeRule = 'color-contrast';

function visualProfile(inImage) {
  return {
    schema: 1, ...viewport, deviceScaleFactor: presentation.deviceScaleFactor, playwright, chromium: browserVersion,
    renderer: inImage ? `${baseImage.name}@${baseImage.digest}/${process.arch}` : `host/${process.platform}/${process.arch}`,
    presentation: 'chromium-headless-css-light-reduced-motion-pt-BR-UTC-v1',
  };
}

function prepareDocument(rawHtml) {
  if (rawHtml.split('<', maxPageNodes + 1).length > maxPageNodes) throw new Error('QA_BROWSER_HTML_NODES');
  const document = parse(rawHtml, {sourceCodeLocationInfo: true});
  const locations = new Map();
  let embedded = 0;
  let visited = 0;

  function visit(parent, parentPath = '', depth = 0) {
    if (depth > 100) throw new Error('QA_BROWSER_HTML_DEPTH');
    let childIndex = 0;
    parent.childNodes = parent.childNodes.filter(node => {
      if (++visited > maxPageNodes) throw new Error('QA_BROWSER_HTML_NODES');
      if (!node.tagName) return true;
      const attr = name => node.attrs.find(item => item.name === name)?.value.toLowerCase().trim();
      const tag = node.tagName.toLowerCase();
      if (['iframe', 'frame', 'object', 'embed', 'portal', 'video', 'audio'].includes(tag)) {
        embedded++;
        return false;
      }
      if (tag === 'script' || (tag === 'meta' && attr('http-equiv') !== undefined) ||
          (tag === 'link' && !attr('rel')?.split(/\s+/).includes('stylesheet'))) return false;
      const path = `${parentPath}/${childIndex++}`;
      const line = node.sourceCodeLocation?.startLine;
      if (line) locations.set(path, {tag, line});
      if (node.childNodes?.length) visit(node, path, depth + 1);
      return true;
    });
  }

  visit(document);
  return {html: serialize(document), locations, embedded};
}

function snapshotFile(workspace, files, file) {
  if (!files.has(file)) return;
  const path = join(workspace, file);
  const stat = lstatSync(path, {throwIfNoEntry: false});
  if (stat?.isFile() && stat.size <= maxFileBytes) return readFileSync(path);
}

function urlFor(file) {
  return `${origin}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

function localResource(url) {
  const parsed = new URL(url);
  if (parsed.origin !== origin || parsed.username || parsed.password) return;
  const parts = parsed.pathname.slice(1).split('/').map(decodeURIComponent);
  if (parts.some(part => !part || part === '.' || part === '..' || /[/\\\u0000]/.test(part))) return;
  return parts.join('/');
}

async function routeSnapshot(page, {workspace, files, file, html}) {
  const documentUrl = urlFor(file);
  let requests = 0;
  let totalBytes = 0;
  let images = 0;
  let imagePixels = 0;
  let blocked = 0;
  const abort = route => {
    blocked++;
    return route.abort('blockedbyclient');
  };

  page.on('console', message => {
    if (message.type() === 'error' && /Content Security Policy.*(?:style|img|font)-src/.test(message.text())) blocked++;
  });
  await page.route('**/*', async route => {
    const request = route.request();
    if (++requests > 48 || request.method() !== 'GET') return abort(route);
    const type = request.resourceType();
    const url = request.url();
    if (type === 'document' && requests === 1 && url === documentUrl) {
      return route.fulfill({body: html, contentType: 'text/html; charset=utf-8',
        headers: {'content-security-policy': csp, 'x-dns-prefetch-control': 'off', 'x-content-type-options': 'nosniff'}});
    }

    let resource;
    try {
      resource = localResource(url);
    } catch {
      return abort(route);
    }
    if (!resource) return abort(route);
    let contentType;
    if (type === 'stylesheet' && /\.css$/i.test(resource)) contentType = 'text/css; charset=utf-8';
    if (type === 'image' && /\.png$/i.test(resource) && !/\.qa-visual\.png$/i.test(resource)) contentType = 'image/png';
    if (!contentType) return abort(route);
    const body = snapshotFile(workspace, files, resource);
    if (!body || totalBytes + body.length > 4 * maxFileBytes) return abort(route);
    if (type === 'image') {
      const size = staticPngSize(body);
      if (!size || images >= 16 || imagePixels + size.width * size.height > 4000000) return abort(route);
      images++;
      imagePixels += size.width * size.height;
    }
    totalBytes += body.length;
    return route.fulfill({body, contentType, headers: {'x-content-type-options': 'nosniff'}});
  });
  return {documentUrl, blockedCount: () => blocked};
}

async function measureContrast(page, source) {
  return page.evaluate(async ({source, rule, limit}) => {
    // Playwright executa apenas esta fonte confiável, via CDP. A CSP bloqueia scripts e handlers do documento.
    window.eval(source);
    const result = await window.axe.run(document, {
      runOnly: {type: 'rule', values: [rule]}, iframes: false, resultTypes: ['violations', 'incomplete'],
    });
    const violation = result.violations[0];
    const nodes = (violation?.nodes ?? []).slice(0, limit).map(node => {
      const selector = node.target.length === 1 && node.target[0];
      let element;
      try {
        if (typeof selector === 'string') element = document.querySelector(selector);
      } catch { /* seletores sem correspondência recebem a localização do documento */ }
      const indexes = [];
      const tag = element?.localName;
      for (let current = element; current; current = current.parentElement) {
        indexes.unshift(Array.prototype.indexOf.call(current.parentNode.children, current));
      }
      return {path: `/${indexes.join('/')}`, tag, html: node.html.slice(0, 180),
        ratio: node.any.find(check => Number.isFinite(check.data?.contrastRatio))?.data.contrastRatio};
    });
    return {nodes, total: violation?.nodes.length ?? 0, evaluated: Boolean(violation || result.passes.length),
      incomplete: result.incomplete[0]?.nodes.length ?? 0, impact: violation?.impact, help: violation?.help};
  }, {source, rule: axeRule, limit: maxContrastFindings});
}

function withDeadline(ms, work) {
  let timeout;
  return Promise.race([
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('QA_BROWSER_DEADLINE')), ms); }),
    Promise.resolve().then(work),
  ]).finally(() => clearTimeout(timeout));
}

function findReference(workspace, files, file, profile) {
  const expected = snapshotFile(workspace, files, `${file}.qa-visual.png`);
  const metadata = snapshotFile(workspace, files, `${file}.qa-visual.json`);
  if (!metadata || !expected) return;
  const size = staticPngSize(expected);
  if (size?.width === viewport.width && size.height === viewport.height &&
      compatibleReference(JSON.parse(metadata.toString('utf8')), profile)) return expected;
}

async function comparePage(page, {workspace, files, file, profile, timeout}) {
  const incompatible = {status: 'skipped', detail: 'referência PNG e metadados incompletos ou incompatíveis com a viewport e a configuração'};
  let expected;
  try {
    expected = findReference(workspace, files, file, profile);
  } catch {
    return incompatible;
  }
  if (!expected) return incompatible;
  const actual = await page.screenshot({...screenshot, timeout}).catch(() => undefined);
  if (!actual) return {status: 'skipped', detail: 'captura PNG indisponível'};
  try {
    const diff = compareVisualPng(expected, actual, viewport);
    return {status: 'ok', detail: `${diff.changed}/${diff.total} pixels RGBA diferentes na viewport ${viewport.width}×${viewport.height}`, diff};
  } catch {
    return {status: 'skipped', detail: 'PNG da referência ou da captura inválido ou fora dos limites'};
  }
}

export async function runBrowserQa({workspace, copiedFiles, htmlFiles, inImage, allowed, axe, row, key, unmeasured, incomplete}) {
  const name = 'qa-navegador';
  const extraRows = [];
  const findings = [];
  const files = new Set(copiedFiles);
  const profile = visualProfile(inImage);
  let version = unmeasured;
  const fileRow = (prefix, file, status, detail, toolVersion = version) => {
    extraRows.push(row(key(prefix, file), toolVersion, status, `${file} / ${detail}`));
  };
  const regress = (file, status, detail) => fileRow('qa-regressao-visual', file, status, detail);
  const hasReference = file => files.has(`${file}.qa-visual.json`) || files.has(`${file}.qa-visual.png`);
  const missingReference = incomplete ? 'referência ausente no snapshot parcial' : 'sem referência versionada no snapshot';
  const skipComparison = (file, reason) => regress(file, 'skipped', hasReference(file) ? reason : missingReference);
  const skipPage = (file, reason) => {
    fileRow(name, file, 'skipped', reason);
    fileRow('qa-contraste', file, 'skipped', reason);
    skipComparison(file, `renderização indisponível: ${reason}`);
  };

  const selected = htmlFiles.slice(0, maxPages);
  const unavailable = reason => {
    selected.forEach(file => skipPage(file, reason));
    return {coverageRow: row(name, version, 'skipped', `${reason}; 0/${htmlFiles.length} páginas renderizadas`), extraRows, findings};
  };
  if (!allowed) return unavailable('isolamento offline do contêiner indisponível');

  let browser;
  try {
    browser = await chromium.launch({headless: true, timeout: 5000, args: [
      '--host-resolver-rules=MAP * ~NOTFOUND', '--proxy-server=direct://', '--disable-quic',
      '--force-color-profile=srgb', '--no-pings',
    ], env: {PATH: process.env.PATH, HOME: tmpdir(), TMPDIR: tmpdir(), LANG: 'C.UTF-8', TZ: 'UTC'}});
  } catch (error) {
    const reason = String(error).includes("Executable doesn't exist")
      ? `Chromium ${browserVersion} indisponível (Playwright ${playwright})`
      : `Chromium ${browserVersion} não iniciou (Playwright ${playwright})`;
    return unavailable(reason);
  }

  const deadline = Date.now() + totalMs;
  let rendered = 0;
  let partial = 0;
  let cleanupFailed = false;
  try {
    if (browser.version() !== browserVersion) return unavailable(`Chromium incompatível com Playwright ${playwright}`);
    version = browser.version();
    for (const file of selected) {
      const remaining = Math.min(pageMs, deadline - Date.now());
      if (cleanupFailed || remaining <= 0) {
        skipPage(file, cleanupFailed ? 'Chromium indisponível após falha ao encerrar a página anterior' : 'prazo total de renderização atingido');
        continue;
      }
      let context;
      let cancelled = false;
      try {
        const result = await withDeadline(remaining, async () => {
          const raw = snapshotFile(workspace, files, file);
          if (!raw) throw new Error('QA_BROWSER_HTML_MISSING');
          const prepared = prepareDocument(raw.toString('utf8'));
          context = await browser.newContext({...presentation, offline: true, serviceWorkers: 'block'});
          if (cancelled) return context.close();
          const page = await context.newPage();
          const {documentUrl, blockedCount} = await routeSnapshot(page, {workspace, files, file, html: prepared.html});
          const response = await page.goto(documentUrl, {waitUntil: 'load', timeout: remaining});
          if (!response?.ok() || page.url() !== documentUrl) throw new Error('QA_BROWSER_RENDER');
          const missing = await page.evaluate(() => {
            const images = Array.from(document.images).filter(img => img.currentSrc && (!img.complete || !img.naturalWidth));
            const stylesheets = Array.from(document.querySelectorAll('link[rel~="stylesheet" i]'))
              .filter(link => !link.disabled && !link.sheet);
            return images.length + stylesheets.length;
          });
          const blocked = blockedCount() + missing;
          const limited = blocked > 0 || prepared.embedded > 0;
          const contrast = limited ? undefined : await measureContrast(page, axe.source).catch(() => undefined);
          let visual = {status: 'skipped', detail: missingReference};
          if (hasReference(file)) {
            visual = limited ? {status: 'skipped', detail: 'renderização parcial por recursos ou conteúdo incorporado'}
              : await comparePage(page, {workspace, files, file, profile, timeout: remaining});
          }
          return {prepared, blocked, limited, contrast, visual};
        });

        rendered++;
        const {prepared, blocked, limited, contrast, visual} = result;
        if (limited) partial++;
        fileRow(name, file, limited ? 'skipped' : 'ok', limited
          ? `renderização parcial: ${blocked} bloqueios ou recursos indisponíveis e ${prepared.embedded} elementos incorporados fora do escopo`
          : 'HTML e CSS locais renderizados em Chromium offline, com scripts da página desativados');
        const measured = contrast?.evaluated && !contrast.incomplete && contrast.total <= maxContrastFindings;
        fileRow('qa-contraste', file, measured ? 'ok' : 'skipped', contrast?.evaluated || contrast?.incomplete
          ? `${contrast.total} violações, ${contrast.incomplete} nós inconclusivos (até ${maxContrastFindings} achados por página)`
          : limited ? 'contraste sem medição por renderização parcial'
            : contrast ? 'nenhum texto elegível para a regra color-contrast' : 'regra color-contrast indisponível na renderização', axe.version);
        for (const node of contrast?.nodes ?? []) {
          const location = prepared.locations.get(node.path);
          const line = location?.tag === node.tag ? location?.line ?? 1 : 1;
          findings.push({tool: 'axe-core', rule: 'QA-AXE-COLOR-CONTRAST', file, line,
            severity: ['serious', 'critical'].includes(contrast.impact) ? 'alta' : contrast.impact === 'moderate' ? 'media' : 'baixa',
            message: `Violacao de acessibilidade axe-core (${axeRule}): ${contrast.help}`,
            evidence: `elemento ${node.html} em ${file}:${line}${node.ratio === undefined ? '' : `, contraste ${node.ratio}:1`}`});
        }
        regress(file, visual.status, visual.detail);
        if (visual.diff?.changed) {
          findings.push({tool: 'qa-regressao-visual', rule: 'QA-REGRESSAO-VISUAL', file, line: 1, severity: 'media',
            message: 'Renderização diferente da referência visual versionada',
            evidence: `${visual.detail}, área x,y ${visual.diff.bounds}, referência ${file}.qa-visual.png`});
        }
      } catch (error) {
        const reason = /QA_BROWSER_HTML_(?:DEPTH|NODES)/.test(String(error)) ? 'HTML excede o limite de nós ou profundidade'
          : /QA_BROWSER_DEADLINE|Timeout/i.test(String(error)) ? 'prazo de renderização atingido' : 'falha ao renderizar o HTML';
        skipPage(file, reason);
      } finally {
        cancelled = true;
        if (context) await withDeadline(1000, () => context.close()).catch(() => { cleanupFailed = true; });
      }
    }
  } finally {
    await browser.close();
  }

  return {coverageRow: row(name, version, rendered > partial ? 'ok' : 'skipped',
    `${rendered - partial}/${htmlFiles.length} páginas renderizadas por inteiro no escopo, ${partial} parciais, ${selected.length - rendered} indisponíveis, ${htmlFiles.length - selected.length} fora do limite de ${maxPages}; Playwright ${playwright}, axe-core ${axe.version}, Chromium offline`),
  extraRows, findings};
}
