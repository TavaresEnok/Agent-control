/**
 * Decisão pura do login dentro da imagem: o script lê a página e o contexto, e esta função decide.
 * Fica separada para os testes do host exercitarem os casos sem navegador.
 */

function cookieKey(cookie) {
  return `${cookie.domain} ${cookie.path} ${cookie.name}`;
}

export function cookieMap(cookies) {
  return new Map(cookies.map(cookie => [cookieKey(cookie), cookie.value]));
}

export function cookieChanged(before, cookies) {
  return cookies.some(cookie => before.get(cookieKey(cookie)) !== cookie.value);
}

export function samePage(a, b) {
  return a.origin === b.origin && loginRoute(a) === loginRoute(b);
}

export function loginRoute(url) {
  const path = url.pathname.replace(/\/+$/u, '') || '/';
  const fragment = url.hash.split('?')[0];
  return path + (fragment.startsWith('#/') ? fragment.replace(/\/+$/u, '') : '');
}

/** Caminho do login comparável com loginRoute(): sem barra final, com o fragmento "#/" quando houver. */
export function loginPath(login, origin) {
  return typeof login?.path === 'string' ? loginRoute(new URL(login.path, origin)) : undefined;
}

/**
 * A tela de login e as rotas declaradas públicas abrem sem sessão. A raiz fica de fora,
 * porque muitos sistemas mostram o login e o painel no mesmo "/".
 */
export function publicRoute(requestedUrl, login, declared = false) {
  if (declared === true) return true;
  const requested = new URL(requestedUrl);
  const path = loginPath(login, requested.origin);
  return path !== undefined && path !== '/' && loginRoute(requested) === path;
}

/**
 * O Playwright conta como visível o elemento com opacity:0 ou dentro de [inert].
 * Roda na página: sobe pelos ancestrais, atravessando Shadow DOM aberto.
 */
export function effectivelyShown(element) {
  for (let node = element; node;) {
    if (node.nodeType === 1) {
      if (node.hasAttribute('inert')) return false;
      const opacity = Number(getComputedStyle(node).opacity);
      if (Number.isFinite(opacity) && opacity === 0) return false;
    }
    const root = node.getRootNode?.();
    node = node.parentElement ?? (root && root !== node && root.host ? root.host : null);
  }
  return true;
}

const VISIBLE_CHECK_MAX = 20;

async function visible(frame, selector) {
  const shown = frame.locator(selector).filter({visible: true});
  const count = Math.min(await shown.count(), VISIBLE_CHECK_MAX);
  for (let index = 0; index < count; index++) {
    // Timeout curto: durante uma navegação o elemento some, e a espera padrão do locator passaria do prazo do login.
    if (await shown.nth(index).evaluate(effectivelyShown, undefined, {timeout: 1000}).catch(() => false)) return true;
  }
  return false;
}

// Os locators do Playwright atravessam Shadow DOM aberto, inclusive para seletores de texto.
async function formVisible(frame, selectors) {
  if ((await Promise.all(selectors.map(selector => visible(frame, selector)))).every(Boolean)) return true;
  for (const child of frame.childFrames()) {
    const element = await child.frameElement();
    try {
      if (await element.isVisible() && await element.evaluate(effectivelyShown).catch(() => false) && await formVisible(child, selectors)) return true;
    } finally {
      await element.dispose();
    }
  }
  return false;
}

export async function pageShowsLogin(page, requestedUrl, login) {
  const final = new URL(page.url());
  const requested = new URL(requestedUrl);
  if (final.origin !== requested.origin) return true;
  // A própria tela de login, pedida de propósito, não é sessão perdida.
  if (publicRoute(requestedUrl, login)) return false;
  const finalRoute = loginRoute(final);
  const path = loginPath(login, final.origin);
  if (finalRoute === path && loginRoute(requested) !== path) return true;
  const selectors = [login.usernameSelector, login.passwordSelector, login.submitSelector].filter(Boolean);
  if (selectors.length && await formVisible(page.mainFrame(), selectors)) return true;
  return Boolean(login.successSelector && login.successRoutes?.includes(finalRoute)
    && !await visible(page, login.successSelector));
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
  if (observed.successRequired) return observed.successVisible === true;
  if (!observed.changed || observed.hiddenReads < 2) return false;
  return observed.left || observed.hiddenReads >= 4;
}

async function sessionEntries(page) {
  return page.evaluate(() => Object.entries(window.sessionStorage));
}

/** Usado nos dois lugares que submetem credenciais, antes de qualquer captura. */
export async function submitLogin(page, context, login, origin, loginUrl) {
  const loginPage = new URL(loginUrl);
  const selectors = {
    usernameSelector: login.usernameSelector,
    passwordSelector: login.passwordSelector,
    submitSelector: login.submitSelector,
    successSelector: login.successSelector,
    successRoutes: login.successRoutes?.map(route => loginRoute(new URL(route, origin))),
  };
  const before = await context.storageState({indexedDB: true});
  const sessionBefore = await sessionEntries(page);
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
        if (await visible(page, login.passwordSelector) || await formVisible(page.mainFrame(), [login.usernameSelector, login.submitSelector])) return;
        // Durante a entrada, outra senha ou um código pendente ainda exige autenticação.
        if (await formVisible(page.mainFrame(), ['input[type=password], input[autocomplete="one-time-code"]'])) return;
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
          hiddenReads,
          left,
          changed: cookieChanged(cookiesBefore, state.cookies)
            || JSON.stringify(state.origins) !== JSON.stringify(before.origins)
            || JSON.stringify(sessionStorage) !== JSON.stringify(sessionBefore),
          successRequired,
          successVisible,
        })) return {...state, designLogin: {
          ...selectors, path: loginRoute(loginPage), sessionStorage,
        }};
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
