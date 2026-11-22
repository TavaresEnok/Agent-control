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

/**
 * A sessão abriu quando o servidor gravou um cookie novo, ou mudou um existente, depois do envio,
 * e o campo de senha saiu da tela. O cookie do laboratório continua valendo sozinho.
 */
function sessionOpened(before, cookies, passwordStillVisible) {
  if (cookies.some(cookie => cookie.name === 'ac_lab_session' && cookie.value === 'aberta')) return true;
  if (passwordStillVisible) return false;
  return cookies.some(cookie => before.get(`${cookie.domain} ${cookie.path} ${cookie.name}`) !== cookie.value);
}

async function passwordVisible(page) {
  try {
    return await page.locator(login.passwordSelector).first().isVisible({timeout: 500});
  } catch {
    return false;
  }
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
  await page.click(login.submitSelector);
  const deadline = Date.now() + 30000;
  let open = false;
  while (Date.now() < deadline) {
    if (sessionOpened(before, await context.cookies(), await passwordVisible(page))) {
      open = true;
      break;
    }
    await page.waitForTimeout(250);
  }
  if (!open) process.exit(1);
  const body = JSON.stringify(await context.storageState());
  if (body.includes(login.password)) process.exit(2);
  writeFileSync('/output/state.json', body, {mode: 0o600});
  chmodSync('/output/state.json', 0o600);
} finally {
  await browser.close();
}
