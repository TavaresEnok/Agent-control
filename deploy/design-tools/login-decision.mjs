/**
 * Decisão pura do login dentro da imagem: o script lê a página e o contexto, e esta função decide.
 * Fica separada para os testes do host exercitarem os casos sem navegador.
 */

export function cookieMap(cookies) {
  return new Map(cookies.map(cookie => [`${cookie.domain} ${cookie.path} ${cookie.name}`, cookie.value]));
}

export function cookieChanged(before, cookies) {
  return cookies.some(cookie => before.get(`${cookie.domain} ${cookie.path} ${cookie.name}`) !== cookie.value);
}

export function samePage(a, b) {
  return a.origin === b.origin && loginRoute(a) === loginRoute(b);
}

export function loginRoute(url) {
  const path = url.pathname.replace(/\/+$/u, '') || '/';
  const query = search => {
    const params = new URLSearchParams(search);
    // O destino após o login pode variar sem mudar a tela de autenticação.
    for (const key of ['return', 'returnTo', 'returnUrl', 'redirect', 'redirectTo', 'next', 'volta', 'voltar']) params.delete(key);
    params.sort();
    const value = params.toString();
    return value ? '?' + value : '';
  };
  const [fragment, fragmentQuery] = url.hash.split(/\?(.*)/su);
  return path + query(url.search) + (/^#!?\//u.test(fragment)
    ? fragment.replace(/\/+$/u, '') + query(fragmentQuery)
    : '');
}

/** Executado em cada documento visível por Playwright e Puppeteer. */
export function loginFormVisible() {
  const visible = field => field.getClientRects().length > 0 && getComputedStyle(field).visibility === 'visible';
  const signIn = /\b(?:entrar|login|log\s?in|sign[ -]?in|reauth(?:enticate|entication)?|reautentica\w*|autenticar|iniciar sess[aã]o)\b/iu;
  const managePassword = /\b(?:trocar|alterar|redefinir|change|reset|update|new)\b/iu;
  const formLabel = field => {
    const container = field.form ?? field.closest('[role="form"], main') ?? document.body;
    return [
      ...(field.form?.getAttribute('action') ? [field.form.getAttribute('action')] : []),
      ...[...container.querySelectorAll('h1, h2, button, input[type="submit"]')].filter(visible)
        .map(element => element.textContent || element.value || element.getAttribute('aria-label') || ''),
    ].join(' ');
  };
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
  if (passwords.some(password => {
    if (password.autocomplete === 'new-password') return false;
    const fields = password.form ? [...password.form.elements] : [...document.querySelectorAll('input')];
    const inputs = fields.filter(field => field instanceof HTMLInputElement && visible(field));
    if (inputs.filter(field => field.type === 'password').length > 1) return false;
    const label = formLabel(password);
    return signIn.test(label) || (!managePassword.test(label) && (password.form !== null
      || password.autocomplete === 'current-password'
      || inputs.some(field => ['username', 'email'].includes(field.autocomplete)
        || (!field.readOnly && ['text', 'email', 'tel'].includes(field.type)))));
  })) return true;
  return [...document.querySelectorAll('input[autocomplete="one-time-code"]')]
    .some(field => visible(field) && signIn.test(formLabel(field)));
}

export async function pageShowsLogin(page, origin, path) {
  if (new URL(page.url()).origin !== origin || loginRoute(new URL(page.url())) === path) return true;
  const check = async frame => {
    if (await frame.evaluate(loginFormVisible)) return true;
    for (const child of frame.childFrames()) {
      const element = await child.frameElement();
      try {
        if (await element.isVisible() && await check(child)) return true;
      } finally {
        await element.dispose();
      }
    }
    return false;
  };
  return check(page.mainFrame());
}

/** A resposta pode chegar durante ações ou auditorias, depois de goto. */
export function watchNavigationFailure(page, matchesStatus = status => status === 401) {
  let rejected = false;
  const listener = response => {
    const request = response.request();
    if (matchesStatus(response.status()) && request.isNavigationRequest() && request.frame() === page.mainFrame()) rejected = true;
  };
  page.on('response', listener);
  return {failed: () => rejected, stop: () => page.off('response', listener)};
}

/** A sessão abre com a confirmação pedida ou com estado novo após o formulário sumir. */
export function loginOpened(observed) {
  if (observed.rejected || observed.secondStep) return false;
  if (observed.labOpen) return true;
  if (observed.successRequired) return observed.successVisible === true;
  if (!observed.changed || observed.hiddenReads < 2) return false;
  return observed.left || observed.hiddenReads >= 4;
}

async function sessionEntries(page) {
  return page.evaluate(() => Object.entries(window.sessionStorage));
}

/** Usado nos dois lugares que submetem credenciais, antes de qualquer captura. */
export async function submitLogin(page, context, login, origin) {
  const loginPage = new URL(page.url());
  const before = await context.storageState({indexedDB: true});
  const sessionBefore = JSON.stringify(await sessionEntries(page));
  const cookiesBefore = cookieMap(before.cookies);
  const navigation = watchNavigationFailure(page, status => status >= 400);
  try {
    await page.click(login.submitSelector);
    const deadline = Date.now() + 15000;
    let hiddenReads = 0;
    while (Date.now() < deadline) {
      if (navigation.failed() || new URL(page.url()).origin !== origin) break;
      const href = page.url();
      // Uma navegação em andamento pode destruir o documento durante a leitura.
      const observed = await (async () => {
        const field = page.locator(login.passwordSelector).first();
        if (await field.isVisible() || await pageShowsLogin(page, origin)) return;
        const state = await context.storageState({indexedDB: true});
        const sessionStorage = await sessionEntries(page);
        const successRequired = typeof login.successSelector === 'string';
        const successVisible = successRequired && await page.locator(login.successSelector).first().isVisible();
        if (page.url() === href) return {state, sessionStorage, successRequired, successVisible};
      })().catch(() => undefined);
      hiddenReads = observed ? hiddenReads + 1 : 0;
      if (observed) {
        const {state, sessionStorage, successRequired, successVisible} = observed;
        const left = !samePage(new URL(href), loginPage);
        if (loginOpened({
          rejected: navigation.failed(),
          labOpen: state.cookies.some(cookie => cookie.name === 'ac_lab_session' && cookie.value === 'aberta'),
          hiddenReads,
          left,
          changed: cookieChanged(cookiesBefore, state.cookies)
            || JSON.stringify(state.origins) !== JSON.stringify(before.origins)
            || JSON.stringify(sessionStorage) !== sessionBefore,
          successRequired,
          successVisible,
        })) return {...state, designLogin: {path: left ? loginRoute(loginPage) : undefined, sessionStorage}};
      }
      await page.waitForTimeout(250);
    }
    throw new Error('DESIGN_CAPTURE_LOGIN_FAILED');
  } finally {
    navigation.stop();
  }
}

/** Formas em que a senha costuma aparecer gravada num cookie, no localStorage ou no JSON do storageState. */
export function passwordForms(username, password) {
  const forms = new Set([
    password,
    JSON.stringify(password).slice(1, -1),
    encodeURIComponent(password),
    new URLSearchParams({p: password}).toString().slice(2),
    Buffer.from(password).toString('base64'),
    Buffer.from(password).toString('base64url'),
  ]);
  if (typeof username === 'string') {
    forms.add(Buffer.from(`${username}:${password}`).toString('base64'));
    forms.add(Buffer.from(`${username}:${password}`).toString('base64url'));
  }
  // A senha crua sempre entra, mesmo curta. As formas derivadas só quando têm tamanho para não casar por acaso.
  return [...forms].filter(form => form === password || form.length >= 4);
}

/** O corpo do storageState contém a senha em alguma forma conhecida. */
export function bodyLeaksPassword(body, username, password) {
  return passwordForms(username, password).some(form => body.includes(form));
}
