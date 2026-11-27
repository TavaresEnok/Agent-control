/** Grava o storageState do laboratório. A senha não sai no stdout e não entra no arquivo. */
import {chmodSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {prepareTrust} from './trust.mjs';
import {bodyLeaksPassword, submitLogin} from './login-decision.mjs';

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
  const context = await browser.newContext({serviceWorkers: 'block'});
  const page = await context.newPage();
  // A página de login pedida, no mesmo host; sem caminho, a raiz.
  await page.goto(login.url, {waitUntil: 'domcontentloaded', timeout: 30000});
  if (new URL(page.url()).origin !== origin) process.exit(1);
  await page.fill(login.usernameSelector, login.username);
  await page.fill(login.passwordSelector, login.password);
  const body = JSON.stringify(await submitLogin(page, context, login, origin));
  if (bodyLeaksPassword(body, login.username, login.password)) process.exit(2);
  writeFileSync('/output/state.json', body, {mode: 0o600});
  chmodSync('/output/state.json', 0o600);
} catch {
  process.exitCode = 1;
} finally {
  await browser.close();
}
