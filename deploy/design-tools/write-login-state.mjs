/** Grava o storageState do laboratório. A senha não sai no stdout e não entra no arquivo. */
import {chmodSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {trustFlags} from './trust.mjs';

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

function cookieMap(cookies) {
  return new Map(cookies.map(cookie => [`${cookie.domain} ${cookie.path} ${cookie.name}`, cookie.value]));
}

function cookieChanged(before, cookies) {
  return cookies.some(cookie => before.get(`${cookie.domain} ${cookie.path} ${cookie.name}`) !== cookie.value);
}

/** 'oculto' só quando o campo de senha comprovadamente não está na tela. Erro de leitura não conta. */
async function passwordState(page) {
  try {
    const field = page.locator(login.passwordSelector);
    if (await field.count() === 0) return 'oculto';
    return await field.first().isVisible() ? 'visivel' : 'oculto';
  } catch {
    return 'desconhecido';
  }
}

function samePage(a, b) {
  return a.origin === b.origin && a.pathname.replace(/\/+$/u, '') === b.pathname.replace(/\/+$/u, '');
}

/** Formas em que a senha costuma aparecer gravada num cookie ou no localStorage. */
function passwordForms(username, password) {
  const forms = new Set([password, encodeURIComponent(password), Buffer.from(password).toString('base64')]);
  if (typeof username === 'string') forms.add(Buffer.from(`${username}:${password}`).toString('base64'));
  return [...forms].filter(form => form.length >= 4);
}

const login = JSON.parse(readFileSync('/login/login.json', 'utf8'));
const playwright = await import('playwright');
const chrome = findChrome();
const origin = new URL(login.url).origin;
let trust;
try {
  trust = await trustFlags(origin);
} catch {
  process.exit(3);
}
const browser = await playwright.chromium.launch({
  executablePath: chrome ?? undefined,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', ...trust],
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const start = new URL(login.url);
  // A página de login pedida, no mesmo host; sem caminho, a raiz.
  await page.goto(`${origin}${start.pathname}${start.search}`, {waitUntil: 'domcontentloaded', timeout: 30000});
  await page.fill(login.usernameSelector, login.username);
  await page.fill(login.passwordSelector, login.password);
  const before = cookieMap(await context.cookies());
  const loginPage = new URL(page.url());
  await page.click(login.submitSelector);
  const deadline = Date.now() + 30000;
  let open = false;
  let hiddenReads = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const cookies = await context.cookies();
    // O cookie do laboratório continua valendo sozinho.
    if (cookies.some(cookie => cookie.name === 'ac_lab_session' && cookie.value === 'aberta')) {
      open = true;
      break;
    }
    // Num sistema real: a página saiu do login, o campo de senha sumiu em duas leituras
    // seguidas e o servidor gravou ou trocou um cookie. Senha errada fica na página de login.
    const state = await passwordState(page);
    hiddenReads = state === 'oculto' ? hiddenReads + 1 : 0;
    let left = false;
    try {
      left = !samePage(new URL(page.url()), loginPage);
    } catch {
      left = false;
    }
    // Uma SPA que abre a sessão na mesma URL precisa do campo oculto por mais tempo.
    if (cookieChanged(before, cookies) && hiddenReads >= 2 && (left || hiddenReads >= 4)) {
      open = true;
      break;
    }
  }
  if (!open) process.exit(1);
  const body = JSON.stringify(await context.storageState());
  if (passwordForms(login.username, login.password).some(form => body.includes(form))) process.exit(2);
  writeFileSync('/output/state.json', body, {mode: 0o600});
  chmodSync('/output/state.json', 0o600);
} finally {
  await browser.close();
}
