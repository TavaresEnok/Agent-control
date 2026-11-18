/** Grava o storageState do laboratório. A senha não sai no stdout e não entra no arquivo. */
import {chmodSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

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
const browser = await playwright.chromium.launch({
  executablePath: chrome ?? undefined,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const origin = new URL(login.url).origin;
  await page.goto(`${origin}/`, {waitUntil: 'domcontentloaded', timeout: 30000});
  await page.fill(login.usernameSelector, login.username);
  await page.fill(login.passwordSelector, login.password);
  await page.click(login.submitSelector);
  const deadline = Date.now() + 30000;
  let open = false;
  while (Date.now() < deadline) {
    const cookies = await context.cookies();
    if (cookies.some(cookie => cookie.name === 'ac_lab_session' && cookie.value === 'aberta')) {
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
