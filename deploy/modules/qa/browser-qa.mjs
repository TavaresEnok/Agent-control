import {lstatSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {parse} from 'parse5';
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

function visualProfile() {
  return {
    schema: 1, ...viewport, deviceScaleFactor: presentation.deviceScaleFactor, playwright, chromium: browserVersion,
    renderer: `${baseImage.name}@${baseImage.digest}/${process.arch}`,
    presentation: 'chromium-headless-css-light-reduced-motion-pt-BR-UTC-v2',
  };
}

function inspectHtmlBytes(raw) {
  // Os encodings HTML são compatíveis com ASCII para estes tokens, ou UTF-16 com BOM.
  const markup = raw.toString('latin1').replaceAll('\0', '');
  if (markup.split('<', maxPageNodes + 1).length > maxPageNodes) throw new Error('QA_BROWSER_HTML_NODES');
  return /http-equiv/i.test(markup);
}

function sourceLocations(raw, charset) {
  const locations = new Map();
  let html;
  try {
    html = new TextDecoder(charset).decode(raw);
  } catch {
    return locations;
  }
  const document = parse(html, {sourceCodeLocationInfo: true});
  let visited = 0;

  function visit(parent, parentPath = '', depth = 0) {
    if (depth > 100) throw new Error('QA_BROWSER_HTML_DEPTH');
    let childIndex = 0;
    let shadowTemplate = false;
    for (const node of parent.childNodes) {
      if (++visited > maxPageNodes) throw new Error('QA_BROWSER_HTML_NODES');
      if (!node.tagName) continue;
      if (node.tagName === 'template' && node.content) {
        // O mesmo índice no DOM vivo ignora templates HTML, consumidos ou não pelo parser.
        // Se o primeiro template declarativo gerar um ShadowRoot, este será seu caminho.
        const mode = node.attrs.find(item => item.name === 'shadowrootmode')?.value.toLowerCase();
        if (!shadowTemplate && (mode === 'open' || mode === 'closed')) {
          shadowTemplate = true;
          if (mode === 'open') visit(node.content, `${parentPath}/#shadow`, depth + 1);
        }
        continue;
      }
      const path = `${parentPath}/${childIndex++}:${node.tagName}`;
      const line = node.sourceCodeLocation?.startLine;
      if (line) locations.set(path, line);
      if (node.childNodes?.length) visit(node, path, depth + 1);
    }
  }

  visit(document);
  return locations;
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

function htmlResponse(body, policy) {
  return {body, contentType: 'text/html',
    headers: {'content-security-policy': policy, 'x-dns-prefetch-control': 'off', 'x-content-type-options': 'nosniff'}};
}

async function hasMetaRefresh(context, documentUrl, html, timeout) {
  // A prévia com sandbox impede refresh (inclusive imediato), scripts e recursos.
  // A medição usa a política regular para permitir os temporizadores do axe via CDP.
  const page = await context.newPage();
  try {
    let blockedRefresh = false;
    page.on('console', message => {
      if (message.text().includes("Refused to execute the redirect specified via '<meta http-equiv='refresh'")) {
        blockedRefresh = true;
      }
    });
    await page.route('**/*', route => {
      const request = route.request();
      if (request.resourceType() === 'document' && request.url() === documentUrl) {
        return route.fulfill(htmlResponse(html, "sandbox allow-same-origin; default-src 'none'; base-uri 'none'"));
      }
      return route.abort('blockedbyclient');
    });
    const response = await page.goto(documentUrl, {waitUntil: 'load', timeout});
    if (!response?.ok()) throw new Error('QA_BROWSER_RENDER');
    const refreshInDocument = await page.evaluate(() => Boolean(document.querySelector('meta[http-equiv="refresh" i]')));
    return blockedRefresh || refreshInDocument;
  } finally {
    await page.close();
  }
}

async function routeSnapshot(page, {workspace, files, documentUrl, html}) {
  let requests = 0;
  let totalBytes = 0;
  let images = 0;
  let imagePixels = 0;
  let blocked = 0;
  const pngs = new Map();
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
      return route.fulfill(htmlResponse(html, csp));
    }

    let resource;
    try {
      resource = localResource(url);
    } catch {
      return abort(route);
    }
    if (!resource) return abort(route);
    let contentType;
    if (type === 'stylesheet' && /\.css$/i.test(resource)) contentType = 'text/css';
    if (type === 'image' && /\.png$/i.test(resource) && !/\.qa-visual\.png$/i.test(resource)) contentType = 'image/png';
    if (!contentType) return abort(route);
    const body = snapshotFile(workspace, files, resource);
    if (!body || totalBytes + body.length > 4 * maxFileBytes) return abort(route);
    if (type === 'image') {
      const size = staticPngSize(body);
      if (!size || images >= 16 || imagePixels + size.width * size.height > 4000000) return abort(route);
      images++;
      imagePixels += size.width * size.height;
      if (!pngs.has(resource)) pngs.set(resource, {base64: body.toString('base64'), ...size});
    }
    totalBytes += body.length;
    return route.fulfill({body, contentType, headers: {'x-content-type-options': 'nosniff'}});
  });
  return {pngs, blockedCount: () => blocked};
}

async function inspectRender(page, pngs) {
  return page.evaluate(async images => {
    let missing = 0;
    let embedded = 0;
    const roots = [document];
    for (const root of roots) {
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
        if (element instanceof HTMLImageElement && element.currentSrc && (!element.complete || !element.naturalWidth)) missing++;
        if (element.matches('link[rel~="stylesheet" i]') && !element.disabled && !element.sheet) missing++;
        if (element.matches('iframe, frame, object, embed, portal, video, audio')) embedded++;
      }
    }
    // Inclui PNGs de CSS, que não aparecem como elementos HTMLImageElement.
    for (const {base64, width, height} of images) {
      try {
        const blob = new Blob([Uint8Array.fromBase64(base64)], {type: 'image/png'});
        const bitmap = await createImageBitmap(blob);
        if (bitmap.width !== width || bitmap.height !== height) missing++;
        bitmap.close();
      } catch {
        missing++;
      }
    }
    return {missing, embedded, charset: document.characterSet};
  }, [...pngs.values()]);
}

async function measureContrast(page, source) {
  return page.evaluate(async ({source, rule, limit}) => {
    // Playwright executa apenas esta fonte confiável, via CDP. A CSP bloqueia scripts e handlers do documento.
    window.eval(source);
    const result = await window.axe.run(document, {
      runOnly: {type: 'rule', values: [rule]}, iframes: false, elementRef: true,
      resultTypes: ['violations', 'incomplete'],
    });
    const violation = result.violations[0];
    const nodes = (violation?.nodes ?? []).slice(0, limit).map(node => {
      const path = [];
      for (let nodeElement = node.element; nodeElement; ) {
        let index = 0;
        for (let sibling = nodeElement.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
          if (!(sibling instanceof HTMLTemplateElement)) index++;
        }
        path.unshift(`${index}:${nodeElement.localName}`);
        const parent = nodeElement.parentNode;
        if (parent instanceof ShadowRoot) path.unshift('#shadow');
        nodeElement = parent instanceof ShadowRoot ? parent.host : nodeElement.parentElement;
      }
      return {path: `/${path.join('/')}`, html: node.html.slice(0, 180),
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
  const profile = inImage ? visualProfile() : undefined;
  let version = unmeasured;
  const fileRow = (prefix, file, status, detail, toolVersion = version) => {
    extraRows.push(row(key(prefix, file), toolVersion, status, `${file} / ${detail}`));
  };
  const regress = (file, status, detail) => fileRow('qa-regressao-visual', file, status, detail);
  const hasReference = file => files.has(`${file}.qa-visual.json`) || files.has(`${file}.qa-visual.png`);
  const missingReference = incomplete ? 'referência ausente no snapshot parcial' : 'sem referência versionada no snapshot';
  const skipPage = (file, reason) => {
    fileRow(name, file, 'skipped', reason);
    fileRow('qa-contraste', file, 'skipped', reason);
    regress(file, 'skipped', `renderização indisponível: ${reason}${hasReference(file) ? '' : `; ${missingReference}`}`);
  };

  const selected = htmlFiles.slice(0, maxPages);
  const excluded = htmlFiles.slice(maxPages);
  const excludedDetail = `${excluded.length} fora do limite de ${maxPages}`;
  excluded.forEach(file => skipPage(file, `fora do limite de ${maxPages} páginas`));
  const unavailable = reason => {
    selected.forEach(file => skipPage(file, reason));
    return {coverageRow: row(name, version, 'skipped',
      `${reason}; 0/${htmlFiles.length} páginas renderizadas, ${excludedDetail}`), extraRows, findings};
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
          const checkRefresh = inspectHtmlBytes(raw);
          const documentUrl = urlFor(file);
          context = await browser.newContext({...presentation, offline: true, serviceWorkers: 'block'});
          if (cancelled) return context.close();
          if (checkRefresh && await hasMetaRefresh(context, documentUrl, raw, remaining)) {
            throw new Error('QA_BROWSER_META_REFRESH');
          }
          const page = await context.newPage();
          const {pngs, blockedCount} = await routeSnapshot(page, {workspace, files, documentUrl, html: raw});
          const response = await page.goto(documentUrl, {waitUntil: 'load', timeout: remaining});
          if (!response?.ok() || page.url() !== documentUrl) throw new Error('QA_BROWSER_RENDER');
          const {missing, embedded, charset} = await inspectRender(page, pngs);
          const locations = sourceLocations(raw, charset);
          const blocked = blockedCount() + missing;
          const limited = blocked > 0 || embedded > 0;
          const contrast = limited ? undefined : await measureContrast(page, axe.source).catch(() => undefined);
          let visual = {status: 'skipped', detail: missingReference};
          if (hasReference(file)) {
            if (limited) visual.detail = 'renderização parcial por recursos ou conteúdo incorporado';
            else if (!profile) visual.detail = 'a comparação visual exige o perfil da imagem OCI fixada';
            else visual = await comparePage(page, {workspace, files, file, profile, timeout: remaining});
          }
          return {locations, embedded, blocked, limited, contrast, visual};
        });

        rendered++;
        const {locations, embedded, blocked, limited, contrast, visual} = result;
        if (limited) partial++;
        fileRow(name, file, limited ? 'skipped' : 'ok', limited
          ? `renderização parcial: ${blocked} bloqueios ou recursos indisponíveis e ${embedded} elementos incorporados fora do escopo`
          : 'HTML e CSS locais renderizados em Chromium offline, com scripts da página desativados');
        const measured = contrast?.evaluated && !contrast.incomplete && contrast.total <= maxContrastFindings;
        fileRow('qa-contraste', file, measured ? 'ok' : 'skipped', contrast?.evaluated || contrast?.incomplete
          ? `${contrast.total} violações, ${contrast.incomplete} nós inconclusivos (até ${maxContrastFindings} achados por página)`
          : limited ? 'contraste sem medição por renderização parcial'
            : contrast ? 'nenhum texto elegível para a regra color-contrast' : 'regra color-contrast indisponível na renderização', axe.version);
        for (const node of contrast?.nodes ?? []) {
          const line = locations.get(node.path);
          const origin = line ? `${file}:${line}` : `${file} (linha do elemento indisponível)`;
          findings.push({tool: 'axe-core', rule: 'QA-AXE-COLOR-CONTRAST', file, line: line ?? 1,
            severity: ['serious', 'critical'].includes(contrast.impact) ? 'alta' : contrast.impact === 'moderate' ? 'media' : 'baixa',
            message: `Violacao de acessibilidade axe-core (${axeRule}): ${contrast.help}`,
            evidence: `elemento ${node.html} em ${origin}${node.ratio === undefined ? '' : `, contraste ${node.ratio}:1`}`});
        }
        regress(file, visual.status, visual.detail);
        if (visual.diff?.changed) {
          findings.push({tool: 'qa-regressao-visual', rule: 'QA-REGRESSAO-VISUAL', file, line: 1, severity: 'media',
            message: 'Renderização diferente da referência visual versionada',
            evidence: `${visual.detail}, área x,y ${visual.diff.bounds}, referência ${file}.qa-visual.png`});
        }
      } catch (error) {
        const reason = /QA_BROWSER_HTML_(?:DEPTH|NODES)/.test(String(error)) ? 'HTML excede o limite de nós ou profundidade'
          : String(error).includes('QA_BROWSER_META_REFRESH') ? 'redirecionamento por meta refresh fora do escopo'
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
    `${rendered - partial}/${htmlFiles.length} páginas renderizadas por inteiro no escopo, ${partial} parciais, ${selected.length - rendered} indisponíveis, ${excludedDetail}; Playwright ${playwright}, axe-core ${axe.version}, Chromium offline`),
  extraRows, findings};
}
