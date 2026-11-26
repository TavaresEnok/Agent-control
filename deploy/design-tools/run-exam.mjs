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
import {prepareTrust} from './trust.mjs';

const HOST = /^(?:127\.0\.0\.1|localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local)$/;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'];
const VIEWPORTS = new Set([375, 768, 1440]);
const STATE_NAMES = new Set(['padrao', 'vazio', 'carregando', 'erro', 'logado']);
const SHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,140}\.png$/;
const LOGIN_STATE = '/login/state.json';
const PROBE_TIMEOUT_MS = 5000;
const RENDER_CELL_MAX = 400;
const TAB_STEPS_MAX = 40;
const CONTROL_MAX = 20;
// Teto de tempo por célula para o passo de hover e foco, e por rota para o Tab.
const STATES_BUDGET_MS = 15000;
const TAB_BUDGET_MS = 20000;
const DEV_OVERLAY = 'vite-error-overlay, #webpack-dev-server-client-overlay';

/**
 * Sobra de texto na tela. O padrão vai como texto e vira RegExp dentro da página.
 * 'NÃO', 'R$ 10,00' e 'nullable' não casam. 'null' e 'TODO' ficam de fora: dão ruído demais.
 */
export const RESIDUE_PATTERNS = [
  {kind: 'lorem', source: '\\blorem ipsum\\b', flags: 'i'},
  {kind: 'modelo', source: '\\{\\{\\s*[\\w.$-]+\\s*\\}\\}', flags: ''},
  {kind: 'interpolacao', source: '\\$\\{[\\w.]+\\}', flags: ''},
  {kind: 'objeto', source: '\\[object (?:Object|Promise)\\]', flags: ''},
  {kind: 'valor', source: '(?:^|[^\\w])(?:undefined|NaN|Invalid Date)(?!\\w)', flags: ''},
  {kind: 'codificacao', source: '\\u00C3[\\u00A0-\\u00BF]|\\u00E2\\u20AC[\\u0098-\\u009D\\u2122\\u0153\\u201C\\u201D]|\\uFFFD', flags: ''},
];

/** Primeiro tipo de sobra que casa com o texto, ou null. */
export function residueKind(text, patterns = RESIDUE_PATTERNS) {
  const value = String(text ?? '');
  for (const pattern of patterns) {
    if (new RegExp(pattern.source, pattern.flags).test(value)) return pattern.kind;
  }
  return null;
}

/*
 * Funções da página. Cada uma é declarada sozinha e vai para o navegador por inPage().
 * Não usam variável de fora: o texto da função é o que roda lá dentro.
 */
export function parseColor(value) {
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

export function over(src, dst) {
  const outA = src.a + dst.a * (1 - src.a);
  if (outA <= 0) return {r: 255, g: 255, b: 255, a: 1};
  const mix = (srcChannel, dstChannel) => (srcChannel * src.a + dstChannel * dst.a * (1 - src.a)) / outA;
  return {r: mix(src.r, dst.r), g: mix(src.g, dst.g), b: mix(src.b, dst.b), a: outA};
}

export function rgb(color) {
  const channel = (value) => Math.max(0, Math.min(255, Math.round(value)));
  return `rgb(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)})`;
}

// Canvas sem cor opaca compõe sobre branco. Imagem ou gradiente não vira preto: devolve null.
export function effectiveColor(el) {
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
  return acc;
}

export function effective(el) {
  const color = effectiveColor(el);
  return color ? rgb(color) : null;
}

export function contrastRatio(foreground, background) {
  const channel = (value) => {
    const unit = Math.max(0, Math.min(255, value)) / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (color) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  const one = luminance(foreground);
  const two = luminance(background);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

export function hasText(el) {
  const nodes = el.childNodes;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.nodeType === 3 && node.textContent && node.textContent.trim().length > 0) return true;
  }
  return false;
}

/** Tag, #id e a primeira classe. Texto da página: só serve de trecho. */
export function selectorOf(el) {
  if (!el || el.nodeType !== 1) return '';
  let out = el.tagName.toLowerCase();
  if (el.id) out += `#${el.id}`;
  const classes = String(el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
  if (classes.length > 0) out += `.${classes[0]}`;
  return out.replace(/\s+/g, ' ').slice(0, 120);
}

export function shown(el) {
  if (!el || el.nodeType !== 1 || !el.isConnected) return false;
  const style = getComputedStyle(el);
  const opacity = Number(style.opacity);
  if (style.display === 'none' || style.visibility !== 'visible' || (Number.isFinite(opacity) && opacity === 0)) return false;
  const rect = el.getBoundingClientRect();
  return rect.width >= 1 && rect.height >= 1;
}

/** Texto de exemplo com no máximo `max` letras, sem espaço sobrando. */
export function snippetOf(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Monta o texto que roda na página: as funções de apoio e depois a chamada com o argumento em JSON. */
export function inPage(fn, helpers, arg) {
  const support = helpers.map(helper => helper.toString()).join('\n');
  return `(() => {\n${support}\nreturn (${fn.toString()})(${JSON.stringify(arg ?? null)});\n})()`;
}

const SAMPLE_HELPERS = [parseColor, over, rgb, effectiveColor, effective, hasText];
const RENDER_HELPERS = [selectorOf, shown, snippetOf];
const CONTROL_HELPERS = [parseColor, over, effectiveColor, contrastRatio, selectorOf, shown, snippetOf];
const FOCUS_HELPERS = [selectorOf];
const MOTION_HELPERS = [selectorOf];

/** Estilo calculado de até 500 elementos. Link dentro de frase leva inText. */
export function sampleProbe() {
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
    // Link no meio do texto: a regra de alvo de toque não vale para ele.
    if (record.selector === 'a' && style.display === 'inline' && el.parentElement && hasText(el.parentElement)) record.inText = true;
    const key = JSON.stringify(record);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

/** Leitura da tela renderizada. Não muda a página. */
export function renderProbe(options) {
  const out = {};
  const width = window.innerWidth;
  const root = document.documentElement;
  const body = document.body;
  if (!root || !body) return out;
  const all = Array.from(body.querySelectorAll('*')).slice(0, 6000);
  const clips = (value) => value === 'hidden' || value === 'clip';
  const scrolls = (value) => value === 'auto' || value === 'scroll' || clips(value);
  // Fixo ou deslocado de lado de propósito: menu fora da tela, gaveta, aviso. Não conta como transbordo.
  const parked = (style) => {
    if (style.position === 'fixed') return true;
    const shift = String(style.translate || 'none');
    if (shift !== 'none' && Math.abs(Number.parseFloat(shift)) >= 1) return true;
    const matrix = /^matrix(3d)?\((.*)\)$/.exec(String(style.transform || 'none'));
    if (!matrix) return false;
    const values = matrix[2].split(',').map(Number);
    const x = matrix[1] ? values[12] : values[4];
    return Number.isFinite(x) && Math.abs(x) >= 1;
  };
  if (options.overflow) {
    const clip = clips(getComputedStyle(root).overflowX) || clips(getComputedStyle(body).overflowX);
    const offenders = [];
    const listed = [];
    for (const el of all) {
      if (offenders.length >= 3) break;
      if (listed.some(item => item.contains(el))) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || rect.right <= width + 1) continue;
      if (parked(getComputedStyle(el))) continue;
      let contained = false;
      for (let node = el.parentElement; node && node !== body && node !== root; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (scrolls(style.overflowX) || parked(style)) {
          contained = true;
          break;
        }
      }
      if (contained || !shown(el)) continue;
      listed.push(el);
      offenders.push({sel: selectorOf(el), right: Math.round(rect.right)});
    }
    // Com html e body escondidos, o body vira a caixa de rolagem e guarda a sobra.
    const scrollWidth = clip ? Math.max(root.scrollWidth, body.scrollWidth) : root.scrollWidth;
    out.overflow = {px: Math.max(0, Math.round(scrollWidth - root.clientWidth)), clip, offenders};
  }
  if (options.clipped) {
    const clipped = [];
    for (const el of all) {
      if (clipped.length >= 10) break;
      const own = Array.from(el.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent || '').join(' ');
      if (own.trim().length === 0) continue;
      const style = getComputedStyle(el);
      if (!clips(style.overflowX) || style.textOverflow === 'ellipsis') continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      const rect = el.getBoundingClientRect();
      const hiddenPattern = style.position === 'absolute' && (rect.width <= 1 || rect.height <= 1 || style.clip.startsWith('rect(0') || style.clipPath.startsWith('inset(50%'));
      if (hiddenPattern || !shown(el)) continue;
      const px = el.scrollWidth - el.clientWidth;
      if (px < 2) continue;
      clipped.push({sel: selectorOf(el), text40: snippetOf(own, 40), px: Math.round(px)});
    }
    out.clipped = clipped;
  }
  if (options.images) {
    const images = [];
    const timing = typeof performance.getEntriesByType === 'function' ? performance.getEntriesByType('resource') : [];
    for (const img of Array.from(document.images)) {
      if (images.length >= 10) break;
      if (!img.complete || img.naturalWidth !== 0 || !img.currentSrc) continue;
      let url;
      try {
        url = new URL(img.currentSrc, location.href);
      } catch {
        continue;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      // SVG sem tamanho próprio pode ter naturalWidth 0. Só conta com resposta de erro.
      if (/\.svg$/i.test(url.pathname)) {
        const entry = timing.find(item => item.name === url.href);
        if (!entry || !(entry.responseStatus >= 400)) continue;
      }
      images.push({path: snippetOf(url.pathname, 120)});
    }
    out.images = images;
  }
  if (options.inputs) {
    const inputs = [];
    const textual = new Set(['text', 'email', 'tel', 'url', 'search', 'password', 'number']);
    for (const el of Array.from(body.querySelectorAll('input, select, textarea'))) {
      if (inputs.length >= 20) break;
      const tag = el.tagName.toLowerCase();
      const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : tag;
      if (tag === 'input' && !textual.has(type)) continue;
      if (!shown(el)) continue;
      const fontPx = Number.parseFloat(getComputedStyle(el).fontSize);
      if (!Number.isFinite(fontPx) || fontPx <= 0) continue;
      inputs.push({sel: selectorOf(el), type, fontPx: Math.round(fontPx * 100) / 100});
    }
    out.inputs = inputs;
  }
  if (options.residue) {
    const residue = [];
    const patterns = [];
    for (const item of options.patterns || []) {
      try {
        patterns.push({kind: item.kind, re: new RegExp(item.source, item.flags)});
      } catch {
        /* padrão inválido fica de fora */
      }
    }
    const skip = 'script, style, code, pre, textarea, input, noscript, [contenteditable], [contenteditable=""], [contenteditable="true"]';
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let visited = 0;
    for (let node = walker.nextNode(); node && residue.length < 10 && visited < 20000; node = walker.nextNode()) {
      visited += 1;
      const text = node.textContent || '';
      if (text.trim().length === 0) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest(skip) || !shown(parent)) continue;
      for (const pattern of patterns) {
        const match = pattern.re.exec(text);
        if (!match) continue;
        const start = Math.max(0, match.index - 10);
        residue.push({kind: pattern.kind, text40: snippetOf(text.slice(start, start + 40), 40), sel: selectorOf(parent)});
        break;
      }
    }
    out.residue = residue;
  }
  if (options.charts) {
    const charts = [];
    const named = (el) => {
      if (!el) return false;
      const label = (el.getAttribute('aria-label') || '').trim() || (el.getAttribute('title') || '').trim();
      if (label.length > 0) return true;
      const by = (el.getAttribute('aria-labelledby') || '').trim();
      if (by.length > 0 && by.split(/\s+/).some(id => (document.getElementById(id)?.textContent || '').trim().length > 0)) return true;
      if (el.tagName.toLowerCase() === 'svg') {
        const title = el.querySelector(':scope > title');
        if (title && (title.textContent || '').trim().length > 0) return true;
      }
      return false;
    };
    const found = Array.from(body.querySelectorAll('canvas, svg.recharts-surface, svg.highcharts-root, svg.apexcharts-svg, [_echarts_instance_] canvas'));
    for (const el of found) {
      if (charts.length >= 10) break;
      if (!shown(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 80) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      if (el.tagName.toLowerCase() === 'canvas' && (el.textContent || '').trim().length > 0) continue;
      const figure = el.closest('figure');
      const holder = el.closest('[role="img"], [role="figure"]');
      const echarts = el.closest('[_echarts_instance_]');
      if (named(el) || named(figure) || named(holder) || named(echarts)) continue;
      if (figure && figure.querySelector('figcaption')) continue;
      const box = figure || el.closest('section') || el.parentElement;
      if (box && box.querySelector('table')) continue;
      charts.push({sel: selectorOf(el), w: Math.round(rect.width), h: Math.round(rect.height)});
    }
    out.charts = charts;
  }
  if (options.title) out.title = snippetOf(document.title, 120);
  return out;
}

/** Passo que muda a página: tira transição, marca até 20 controles com texto. Devolve quantos. */
export function markControls(max) {
  const css = '*,*::before,*::after{transition:none!important;animation:none!important}';
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }
  const query = 'a[href], button, [role="button"], input[type="submit"], input[type="button"], input[type="reset"], summary, [role="tab"], [role="menuitem"]';
  let count = 0;
  for (const el of Array.from(document.querySelectorAll(query))) {
    if (count >= max) break;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !shown(el)) continue;
    const text = el.tagName.toLowerCase() === 'input' ? String(el.value || '') : String(el.innerText || '');
    if (text.trim().length === 0) continue;
    el.setAttribute('data-ac-sonda', String(count));
    count += 1;
  }
  return count;
}

/** Cor do texto do controle sobre o fundo efetivo, no estado em que ele está agora. */
export function readControl(index) {
  const el = document.querySelector(`[data-ac-sonda="${index}"]`);
  if (!el || !shown(el)) return null;
  const style = getComputedStyle(el);
  const background = effectiveColor(el);
  const text = parseColor(style.color);
  if (!background || !text) return null;
  const foreground = over(text, background);
  const size = Number.parseFloat(style.fontSize);
  const weight = Number.parseInt(style.fontWeight, 10);
  const large = size >= 24 || (size >= 18.66 && weight >= 700);
  const label = el.tagName.toLowerCase() === 'input' ? String(el.value || '') : String(el.innerText || '');
  return {
    key: `${Math.round(foreground.r)},${Math.round(foreground.g)},${Math.round(foreground.b)}/${Math.round(background.r)},${Math.round(background.g)},${Math.round(background.b)}`,
    ratio: contrastRatio(foreground, background),
    need: large ? 3 : 4.5,
    label40: snippetOf(label, 40) || selectorOf(el),
  };
}

/** Um passo do Tab: o elemento com foco, o contorno e quanto dele está sob algo fixo. */
export function focusRead(index) {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return {body: true};
  const store = window;
  if (index === 0 || !store.__acTabFirst) store.__acTabFirst = el;
  else if (store.__acTabFirst === el) return {repeat: true};
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const width = window.innerWidth;
  const height = window.innerHeight;
  const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
  let covered = 0;
  if (visible) {
    const clampX = (value) => Math.max(0, Math.min(width - 1, value));
    const clampY = (value) => Math.max(0, Math.min(height - 1, value));
    const points = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + 1, rect.top + 1],
      [rect.right - 1, rect.top + 1],
      [rect.left + 1, rect.bottom - 1],
      [rect.right - 1, rect.bottom - 1],
    ];
    let hits = 0;
    for (const [x, y] of points) {
      const hit = document.elementFromPoint(clampX(x), clampY(y));
      if (!hit || hit === el || el.contains(hit)) continue;
      let pinned = null;
      for (let node = hit; node && node.nodeType === 1; node = node.parentElement) {
        const position = getComputedStyle(node).position;
        if (position === 'fixed' || position === 'sticky') {
          pinned = node;
          break;
        }
      }
      if (pinned && pinned !== el && !pinned.contains(el)) hits += 1;
    }
    covered = hits / points.length;
  }
  return {
    step: {
      selector: selectorOf(el),
      index,
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      boxShadow: style.boxShadow,
      visible,
      covered,
      x: Math.round(rect.left),
      y: Math.round(rect.top + window.scrollY),
    },
  };
}

/** Animação infinita que segue rodando com movimento reduzido, em alvo de pelo menos 48x48. */
export function motionProbe() {
  const running = [];
  const seen = new Set();
  const list = typeof document.getAnimations === 'function' ? document.getAnimations() : [];
  for (const animation of list) {
    if (running.length >= 5) break;
    if (animation.playState !== 'running' || !animation.effect || typeof animation.effect.getTiming !== 'function') continue;
    if (animation.effect.getTiming().iterations !== Infinity) continue;
    const target = animation.effect.target;
    if (!target || target.nodeType !== 1 || seen.has(target)) continue;
    seen.add(target);
    if (target.closest('[role="progressbar"], [aria-busy="true"]')) continue;
    let busy = false;
    for (let node = target, depth = 0; node && node.nodeType === 1 && depth < 4; node = node.parentElement, depth += 1) {
      if (/spin|load|skeleton|progress/i.test(String(node.getAttribute('class') || ''))) {
        busy = true;
        break;
      }
    }
    if (busy) continue;
    const rect = target.getBoundingClientRect();
    if (rect.width < 48 || rect.height < 48) continue;
    running.push({sel: selectorOf(target), w: Math.round(rect.width), h: Math.round(rect.height)});
  }
  return {running};
}

/** Tela de erro do servidor de desenvolvimento. O diálogo do Next fica na sombra do portal. */
export function overlayProbe(query) {
  if (document.querySelector(query)) return true;
  const portal = document.querySelector('nextjs-portal');
  if (!portal) return false;
  return Boolean(portal.querySelector('[data-nextjs-dialog]') || (portal.shadowRoot && portal.shadowRoot.querySelector('[data-nextjs-dialog]')));
}

/** Corrida contra o relógio. Quem perde não fica sem tratamento: race assina as duas promessas. */
/** Teto de uma rodada do Lighthouse, rota por formato. */
export const LIGHTHOUSE_TIMEOUT_MS = 120_000;

export async function bounded(promise, ms = PROBE_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`sem resposta em ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Caminho sem a barra do fim. A raiz fica '/'. */
export function plainPath(value) {
  try {
    const path = new URL(value).pathname.replace(/\/+$/, '');
    return path.length > 0 ? path : '/';
  } catch {
    return '';
  }
}

/** Mesmo origin, outro caminho: a página aberta não é a pedida. */
export function redirectedTo(requested, landed) {
  const from = plainPath(requested);
  const to = plainPath(landed);
  if (from === '' || to === '' || from === to) return null;
  return to.slice(0, 120);
}

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
  if (width === 320) return 568;
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

function readLoginState() {
  let raw;
  try {
    raw = readFileSync(LOGIN_STATE, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const {designLogin = {}, ...storageState} = JSON.parse(raw);
  if (!Array.isArray(storageState.cookies) || !Array.isArray(storageState.origins)) {
    throw new Error('DESIGN_CAPTURE_LOGIN_FAILED');
  }
  return {storageState, designLogin};
}

// Runs before app scripts, only in the declared origin and only for this browser session.
function restoreStorage({origin, local = [], session = []}) {
  if (window.location.origin !== origin) return;
  for (const {name, value} of local) if (localStorage.getItem(name) === null) localStorage.setItem(name, value);
  for (const [key, value] of session) if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, value);
}

async function captureLoginFailed(page, requested, login, {allowNavigation = false} = {}) {
  const landed = new URL(page.url());
  const expected = new URL(requested);
  if (landed.origin !== expected.origin) return true;
  const moved = redirectedTo(requested, landed.href);
  if (moved !== null && !allowNavigation) return true;
  if (login.path !== undefined && plainPath(landed.href) === login.path) return true;
  return page.evaluate(({passwordSelector, submitSelector}) => {
    const visible = (selector, fallback) => {
      let fields;
      try {
        fields = document.querySelectorAll(selector ?? fallback);
      } catch {
        fields = document.querySelectorAll(fallback);
      }
      return Array.from(fields).some(field => field.getClientRects().length > 0
        && getComputedStyle(field).visibility === 'visible');
    };
    return visible('input[autocomplete="one-time-code"]')
      || (visible(passwordSelector, 'input[type="password"]')
        && visible(submitSelector, 'button[type="submit"], input[type="submit"]'));
  }, {passwordSelector: login.passwordSelector, submitSelector: login.submitSelector});
}

async function prepareAuditPage(page, origin, login) {
  const {storageState, designLogin} = login;
  await page.setBypassServiceWorker(true);
  await page.browserContext().setCookie(...storageState.cookies);
  await page.evaluateOnNewDocument(restoreStorage, {
    origin,
    local: storageState.origins.find(item => item.origin === origin)?.localStorage,
    session: designLogin.sessionStorage,
  });
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

export function slimLighthouse(lhr) {
  if (!lhr || typeof lhr !== 'object') return null;
  const categories = {};
  for (const [key, value] of Object.entries(lhr.categories ?? {})) {
    if (!value || typeof value !== 'object') continue;
    categories[key] = {id: key, title: value.title ?? key, score: value.score ?? null};
  }
  const audits = {};
  // viewport e font-size: o host só olha no relatório mobile.
  for (const id of ['cumulative-layout-shift', 'largest-contentful-paint', 'first-contentful-paint', 'total-blocking-time', 'speed-index', 'interactive', 'viewport', 'font-size']) {
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
  // Homologação HTTPS com CA própria: a CA entra no banco NSS do Chrome, com validação normal.
  try {
    await prepareTrust(target.origin);
  } catch {
    // Código próprio: o host diz que a causa é a CA, não uma falha genérica da imagem.
    console.error('DESIGN_TRUST_CA_FAILED');
    process.exit(3);
  }
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
  const markUnavailable = (cell, status, reason) => {
    const code = Number.isInteger(status) && status > 0 ? status : 0;
    unavailable.push({route: cell.route, viewport: cell.viewport, theme: cell.theme, state: cell.state, status: code});
    const why = typeof reason === 'string' && reason.length > 0 ? reason : String(code);
    note(`rota indisponível (${why}) ${cell.route} ${cell.viewport} ${cell.theme} ${cell.state}`);
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

  let login;
  try {
    login = readLoginState();
  } catch {
    console.error('DESIGN_CAPTURE_LOGIN_FAILED');
    process.exit(4);
  }
  const loginRequested = plan.routes.some(route => route.states.some(state => state.auth));
  if (loginRequested && login === null) note('logado não capturado');

  const routeCells = [];
  for (const route of plan.routes) {
    const list = [];
    for (const theme of route.themes) {
      for (const state of route.states) {
        if (state.auth && login === null) continue;
        for (const viewport of plan.viewports) {
          list.push({
            route: route.route,
            theme,
            state: state.name,
            viewport,
            href: state.href,
            actions: state.actions,
          });
        }
      }
    }
    routeCells.push({route: route.route, cells: list});
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

  const renderCells = [];
  const keyboardWalks = [];
  const renderFailures = [];
  const keyboardFailures = [];
  let renderMeasured = 0;
  const cellLabel = (cell) => `${cell.route} ${cell.viewport} ${cell.theme} ${cell.state}`;
  // Cada leitura da página tem 5s. Falha vira linha na cobertura, não derruba a célula.
  const probe = async (page, fn, helpers, arg, failures, label) => {
    try {
      return await bounded(page.evaluate(inPage(fn, helpers, arg)));
    } catch (error) {
      failures.push(`${label} ${shortError(error)}`);
      return null;
    }
  };
  const pushRender = (entry) => {
    const same = renderCells.find(item => item.file === entry.file);
    if (same) {
      Object.assign(same, entry);
      return;
    }
    if (renderCells.length < RENDER_CELL_MAX) renderCells.push(entry);
  };

  // Passo que muda a página. Vem por último na célula; a célula seguinte abre a página de novo.
  const probeStates = async (page, label) => {
    const start = page.url();
    const deadline = Date.now() + STATES_BUDGET_MS;
    const count = await probe(page, markControls, RENDER_HELPERS, CONTROL_MAX, renderFailures, label);
    const out = [];
    if (!Number.isInteger(count) || count <= 0) return out;
    try {
      await page.mouse.move(0, 0);
      for (let index = 0; index < count; index += 1) {
        if (page.url() !== start || Date.now() > deadline) break;
        const rest = await probe(page, readControl, CONTROL_HELPERS, index, renderFailures, label);
        if (!rest) continue;
        const locator = page.locator(`[data-ac-sonda="${index}"]`);
        const judged = [];
        try {
          await locator.hover({timeout: 1000});
          judged.push(['hover', await probe(page, readControl, CONTROL_HELPERS, index, renderFailures, label)]);
        } catch {
          /* controle coberto ou fora de alcance */
        }
        await page.mouse.move(0, 0);
        if (page.url() !== start) break;
        try {
          await locator.focus({timeout: 1000});
          judged.push(['foco', await probe(page, readControl, CONTROL_HELPERS, index, renderFailures, label)]);
          await locator.blur({timeout: 1000});
        } catch {
          /* sem foco */
        }
        for (const [state, read] of judged) {
          // Mesma cor do repouso: o axe já mede. Aqui só entra o estado que muda e reprova.
          if (!read || read.key === rest.key || !(read.ratio < read.need)) continue;
          out.push({label40: read.label40, state, ratio: Math.floor(read.ratio * 100) / 100, need: read.need});
        }
      }
    } catch (error) {
      renderFailures.push(`${label} estados ${shortError(error)}`);
    }
    return out;
  };

  const walkTab = async (page, label) => {
    const steps = [];
    const start = page.url();
    const deadline = Date.now() + TAB_BUDGET_MS;
    let bodyHits = 0;
    for (let press = 0; press < TAB_STEPS_MAX && Date.now() <= deadline; press += 1) {
      await bounded(page.keyboard.press('Tab'));
      if (page.url() !== start) break;
      const read = await probe(page, focusRead, FOCUS_HELPERS, steps.length, keyboardFailures, label);
      if (!read || read.repeat) break;
      if (read.body) {
        bodyHits += 1;
        if (bodyHits >= 2) break;
        continue;
      }
      if (read.step) steps.push(read.step);
    }
    return steps;
  };

  // Abre a rota sem estado, tema claro. Erro, redirecionamento ou tela de erro: não mede.
  const openPlain = async (page, route, viewport) => {
    await page.setViewportSize({width: viewport, height: viewportHeight(viewport)});
    await page.emulateMedia({colorScheme: 'light'});
    const url = routeUrl(target.origin, route);
    const response = await page.goto(url, {waitUntil: 'load', timeout: 20000});
    const status = response && Number.isInteger(response.status()) ? response.status() : 0;
    const landed = new URL(page.url());
    if (status >= 400 || status === 0 || landed.origin !== target.origin) return false;
    if (login !== null && await captureLoginFailed(page, url, login.designLogin)) return false;
    if (redirectedTo(url, landed.href) !== null) return false;
    return await probe(page, overlayProbe, [], DEV_OVERLAY, renderFailures, route) !== true;
  };

  const runRoutePasses = async (page, route) => {
    const narrow = `${route} 320 claro padrao`;
    try {
      if (renderCells.length < RENDER_CELL_MAX && await openPlain(page, route, 320)) {
        const read = await probe(page, renderProbe, RENDER_HELPERS, {overflow: true}, renderFailures, narrow);
        if (read && read.overflow) {
          pushRender({file: narrow, route, viewport: 320, theme: 'claro', state: 'padrao', overflow: read.overflow});
          renderMeasured += 1;
        }
      }
    } catch (error) {
      renderFailures.push(`${narrow} ${shortError(error)}`);
    }
    const wide = `${route} 1440 claro padrao`;
    try {
      if (await openPlain(page, route, 1440)) {
        const steps = await walkTab(page, wide);
        if (steps.length > 0) keyboardWalks.push({file: wide, steps});
      }
    } catch (error) {
      keyboardFailures.push(`${wide} ${shortError(error)}`);
    }
    try {
      await page.emulateMedia({colorScheme: 'light', reducedMotion: 'reduce'});
      if (await openPlain(page, route, 1440)) {
        await page.waitForTimeout(1000);
        const read = await probe(page, motionProbe, MOTION_HELPERS, null, renderFailures, `${wide} movimento`);
        if (read && Array.isArray(read.running)) pushRender({file: wide, route, viewport: 1440, theme: 'claro', state: 'padrao', motion: read});
      }
    } catch (error) {
      renderFailures.push(`${wide} movimento ${shortError(error)}`);
    } finally {
      await page.emulateMedia({reducedMotion: null}).catch(() => undefined);
    }
  };

  const runCell = async (page, cell) => {
    const fileName = routeShotName(cell.route, cell.viewport, cell.theme, cell.state);
    const label = cellLabel(cell);
    try {
      await page.setViewportSize({width: cell.viewport, height: viewportHeight(cell.viewport)});
      await page.emulateMedia({colorScheme: cell.theme === 'escuro' ? 'dark' : 'light'});
      const url = cell.href ?? routeUrl(target.origin, cell.route);
      let response;
      try {
        response = await page.goto(url, {waitUntil: 'load', timeout: 20000});
      } catch {
        markUnavailable(cell, 0);
        return;
      }
      const status = response && Number.isInteger(response.status()) ? response.status() : 0;
      let landed = null;
      try {
        landed = new URL(page.url());
      } catch {
        landed = null;
      }
      if (status >= 400 || status === 0 || !landed || landed.origin !== target.origin) {
        const escaped = login !== null && landed && landed.origin !== target.origin;
        markUnavailable(cell, escaped ? 401 : status >= 400 ? status : 0, escaped ? 'sessão não confirmada na rota' : undefined);
        return;
      }
      const lostSession = async (allowNavigation = false) => {
        if (login === null) return false;
        const lost = await captureLoginFailed(page, url, login.designLogin, {allowNavigation}).catch(() => true);
        if (lost) markUnavailable(cell, 401, 'sessão não confirmada na rota');
        return lost;
      };
      if (await lostSession()) return;
      const moved = redirectedTo(url, landed.href);
      if (moved !== null) note(`rota ${cell.route} redirecionou para ${moved}`);
      const overlay = () => probe(page, overlayProbe, [], DEV_OVERLAY, renderFailures, label);
      if (await overlay() === true) {
        markUnavailable(cell, 0, 'tela de erro do servidor de desenvolvimento');
        return;
      }
      const acted = await runActions(page, cell.actions).catch(() => false);
      const allowNavigation = cell.actions.length > 0;
      if (await lostSession(allowNavigation)) return;
      if (!acted) {
        note(`estado ${cell.state} não capturado`);
        return;
      }
      if (allowNavigation && await overlay() === true) {
        markUnavailable(cell, 0, 'tela de erro do servidor de desenvolvimento');
        return;
      }
      const shot = join('/output/capturas', fileName);
      const png = await page.screenshot({fullPage: true, type: 'png'});
      if (await lostSession(allowNavigation)) return;
      writeFileSync(shot, png);
      if (moved === null) rememberStyles(await readStyleBlocks(page));
      screenshots.push({fileName, route: cell.route, viewport: cell.viewport, theme: cell.theme, state: cell.state});
      const samples = await page.evaluate(inPage(sampleProbe, SAMPLE_HELPERS));
      if (moved === null) computed.push({route: cell.route, viewport: cell.viewport, theme: cell.theme, state: cell.state, samples});
      try {
        const results = await new AxeBuilder({page}).withTags(AXE_TAGS).analyze();
        const violations = Array.isArray(results?.violations) ? results.violations.length : 0;
        axeFindings += violations;
        axeFinished += 1;
        axeReports.push({
          file: label,
          route: cell.route,
          viewport: cell.viewport,
          theme: cell.theme,
          state: cell.state,
          json: results,
        });
      } catch (error) {
        axeFailures.push(`DESIGN_AXE_FAILED ${label} ${shortError(error)}`);
      }
      if (moved !== null || renderCells.length >= RENDER_CELL_MAX) return;
      const wide = cell.viewport === 1440;
      const read = await probe(page, renderProbe, RENDER_HELPERS, {
        overflow: true,
        clipped: true,
        images: true,
        inputs: cell.viewport === 375,
        residue: wide,
        charts: wide,
        title: wide && cell.theme === 'claro' && cell.state === 'padrao',
        patterns: RESIDUE_PATTERNS,
      }, renderFailures, label);
      const entry = {file: label, route: cell.route, viewport: cell.viewport, theme: cell.theme, state: cell.state};
      if (read && typeof read === 'object') {
        Object.assign(entry, read);
        renderMeasured += 1;
      }
      if (wide && cell.state === 'padrao') entry.states = await probeStates(page, label);
      pushRender(entry);
    } catch (error) {
      axeFailures.push(`DESIGN_AXE_FAILED ${label} ${shortError(error)}`);
      note(`captura falhou ${cell.route} ${cell.viewport} ${cell.state}`);
    }
  };

  let axeFinished = 0;
  let axeFindings = 0;
  if (browser) {
    try {
      const context = await browser.newContext({
        serviceWorkers: 'block',
        ...(login === null ? {} : {storageState: login.storageState}),
      });
      if (login?.designLogin.sessionStorage?.length > 0) {
        await context.addInitScript(restoreStorage, {origin: target.origin, session: login.designLogin.sessionStorage});
      }
      const page = await context.newPage();
      for (const group of routeCells) {
        for (const cell of group.cells) await runCell(page, cell);
        // Uma vez por rota, depois das células: 320px, Tab e movimento reduzido.
        if (group.cells.length > 0) await runRoutePasses(page, group.route);
      }
    } catch (error) {
      if (login !== null) {
        console.error('DESIGN_CAPTURE_LOGIN_FAILED');
        process.exitCode = 4;
        return;
      }
      axeFailures.push(`DESIGN_AXE_FAILED ${shortError(error)}`);
    } finally {
      await browser.close().catch(() => undefined);
    }
  } else {
    if (login !== null) {
      console.error('DESIGN_CAPTURE_LOGIN_FAILED');
      process.exitCode = 4;
      return;
    }
    renderFailures.push('DESIGN_RENDER_FAILED sem navegador');
    keyboardFailures.push('DESIGN_KEYBOARD_FAILED sem navegador');
  }
  let pa11yFindings = 0;
  let pa11yCells = 0;
  const pa11yFailures = [];
  const pa11yBin = '/opt/design-tools/node_modules/.bin/pa11y';
  const pa11yConfig = '/tmp/pa11y.json';
  const chromeArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
  let auditBrowser;
  let puppeteer;
  try {
    if (login !== null) puppeteer = (await import('puppeteer')).default;
  } catch {
    // Each authenticated audit reports its own failure without retrying anonymously.
  }
  const runAuthenticatedPa11y = async (url, viewport, runner) => {
    if (auditBrowser === undefined) {
      auditBrowser = await puppeteer.launch({executablePath: chrome ?? undefined, args: chromeArgs});
    }
    const context = await auditBrowser.createBrowserContext();
    try {
      const page = await context.newPage();
      await prepareAuditPage(page, target.origin, login);
      await page.setViewport({width: viewport, height: viewportHeight(viewport)});
      const response = await page.goto(url, {waitUntil: 'load', timeout: 20000});
      if (!response?.ok() || await captureLoginFailed(page, url, login.designLogin)) return null;
      const pa11y = (await import('pa11y')).default;
      const result = await bounded(pa11y(url, {browser: auditBrowser, page, ignoreUrl: true, runners: [runner], timeout: 25000}), 25000);
      return await captureLoginFailed(page, url, login.designLogin) ? null : result.issues;
    } finally {
      await context.close();
    }
  };
  for (const route of plan.routes) {
    for (const viewport of plan.viewports) {
      let cellDone = true;
      for (const runner of ['axe', 'htmlcs']) {
        const label = `${route.route} ${viewport} ${runner}`;
        try {
          const url = routeUrl(target.origin, route.route);
          if (login !== null) {
            const issues = await runAuthenticatedPa11y(url, viewport, runner);
            if (issues === null) {
              cellDone = false;
              pa11yFailures.push(`DESIGN_PA11Y_FAILED ${label} rota indisponível com sessão`);
              continue;
            }
            pa11yFindings += issues.length;
            pa11yReports.push({file: label, route: route.route, viewport, runner, json: issues});
            continue;
          }
          writeFileSync(pa11yConfig, JSON.stringify({
            chromeLaunchConfig: {
              executablePath: chrome ?? undefined,
              args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            },
            viewport: {width: viewport, height: viewportHeight(viewport)},
          }));
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
          pa11yFailures.push(`DESIGN_PA11Y_FAILED ${label} ${login === null ? shortError(error) : 'falha na auditoria com sessão'}`);
        }
      }
      if (cellDone) pa11yCells += 1;
    }
  }

  await auditBrowser?.close().catch(() => undefined);

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
        let auditPage;
        try {
          chromeSession = await launch({
            chromePath: chrome ?? undefined,
            chromeFlags: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
          });
          if (login !== null) {
            const connected = await puppeteer.connect({browserURL: `http://127.0.0.1:${chromeSession.port}`});
            auditPage = await connected.newPage();
            await prepareAuditPage(auditPage, target.origin, login);
          }
          const url = routeUrl(target.origin, route.route);
          // Página com animação infinita ou rede que nunca sossega pode prender o Lighthouse.
          // O teto fecha o Chrome e segue para a próxima rota, com a falha registrada.
          const result = await bounded(lighthouse(url, {
            port: chromeSession.port,
            ...(login === null ? {} : {disableStorageReset: true}),
            output: 'json',
            logLevel: 'error',
            maxWaitForLoad: 30000,
            onlyCategories: ['accessibility', 'best-practices', 'performance', 'seo'],
            // O atraso plantado do laboratório está no servidor. A simulação padrão
            // reescreve esse tempo; a medida observada é a que o exame guarda.
            throttlingMethod: 'provided',
            formFactor,
            screenEmulation: mobile
              ? {mobile: true, width: 375, height: 812, deviceScaleFactor: 2, disabled: false}
              : {mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false},
          }, undefined, auditPage), LIGHTHOUSE_TIMEOUT_MS);
          if (login !== null && await captureLoginFailed(auditPage, url, login.designLogin)) {
            lhFailures.push(`DESIGN_LIGHTHOUSE_FAILED ${route.route} ${formFactor} sessão não confirmada na rota`);
            continue;
          }
          const lhr = slimLighthouse(result?.lhr ?? null);
          if (!lhr || (login !== null && result?.lhr?.runtimeError)) {
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
          lhFailures.push(`DESIGN_LIGHTHOUSE_FAILED ${route.route} ${formFactor} ${login === null ? shortError(error) : 'falha na auditoria com sessão'}`);
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

  // A régua e o teclado não estão entre as obrigatórias do host.
  coverage.push(
    row('régua', packageVersion('playwright'), `${renderMeasured} células`, 0, failureText(renderFailures)),
    row('teclado', packageVersion('playwright'), `${keyboardWalks.length} rotas`, 0, failureText(keyboardFailures)),
  );

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
      render: renderCells,
      keyboard: keyboardWalks,
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
