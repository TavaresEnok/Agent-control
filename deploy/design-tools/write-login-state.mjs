/** Grava o storageState do laboratório. A senha não sai no stdout e não entra no arquivo. */
import {chmodSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {prepareTrust} from './trust.mjs';
import {bodyLeaksPassword, cookieChanged, cookieMap, loginOpened, samePage} from './login-decision.mjs';

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

/** localStorage e sessionStorage da página, para reconhecer SPA que guarda o token fora de cookie. */
async function storageSnapshot(page) {
  try {
    return await page.evaluate(() => JSON.stringify([Object.entries(localStorage).sort(), Object.entries(sessionStorage).sort()]));
  } catch {
    return null;
  }
}

/** Segundo fator ou outra senha na tela: o login não terminou. */
async function selectorVisible(page, selector) {
  try {
    return await page.locator(selector).first().isVisible();
  } catch {
    return false;
  }
}

async function secondStepVisible(page) {
  try {
    const step = page.locator('input[type=password], input[autocomplete="one-time-code"]');
    const total = await step.count();
    for (let index = 0; index < total; index += 1) {
      if (await step.nth(index).isVisible()) return true;
    }
    return false;
  } catch {
    return true;
  }
}

const login = JSON.parse(readFileSync('/login/login.json', 'utf8'));
const playwright = await import('playwright');
const chrome = findChrome();
const origin = new URL(login.url).origin;
try {
  await prepareTrust(origin);
} catch {
  process.exit(3);
}
const browser = await playwright.chromium.launch({
  executablePath: chrome ?? undefined,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
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
  const storageBefore = await storageSnapshot(page);
  const loginPage = new URL(page.url());
  await page.click(login.submitSelector);
  const deadline = Date.now() + 30000;
  let open = false;
  let hiddenReads = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const cookies = await context.cookies();
    const labOpen = cookies.some(cookie => cookie.name === 'ac_lab_session' && cookie.value === 'aberta');
    const state = await passwordState(page);
    hiddenReads = state === 'oculto' ? hiddenReads + 1 : 0;
    let left = false;
    try {
      left = !samePage(new URL(page.url()), loginPage);
    } catch {
      left = false;
    }
    const storageNow = hiddenReads >= 2 ? await storageSnapshot(page) : null;
    const successRequired = typeof login.successSelector === 'string';
    if (loginOpened({
      labOpen,
      hiddenReads,
      left,
      changed: cookieChanged(before, cookies) || (storageNow !== null && storageBefore !== null && storageNow !== storageBefore),
      secondStep: labOpen ? false : await secondStepVisible(page),
      successRequired,
      successVisible: successRequired ? await selectorVisible(page, login.successSelector) : false,
    })) {
      open = true;
      break;
    }
  }
  if (!open) process.exit(1);
  const body = JSON.stringify(await context.storageState());
  if (bodyLeaksPassword(body, login.username, login.password)) process.exit(2);
  writeFileSync('/output/state.json', body, {mode: 0o600});
  chmodSync('/output/state.json', 0o600);
} finally {
  await browser.close();
}
