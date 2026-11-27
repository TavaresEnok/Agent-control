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

// O locator CSS do Playwright atravessa shadow roots abertos. A avaliação recebe
// só elementos visíveis, inclusive quando o formulário está dentro de um componente.
function loginFormVisible(elements) {
  const signIn = /\b(?:entrar|login|log\s?in|sign[ -]?in|reauth(?:enticate|entication)?|reautentica\w*|autenticar|iniciar sess[aã]o)\b/iu;
  const managePassword = /\b(?:trocar|alterar|redefinir|change|reset|update|new)\b/iu;
  const prompt = /^(?:(?:entrar|login|log in|sign[ -]?in|iniciar sess[aã]o)(?:$| (?:com|with|para|to)\b)|(?:faça (?:o )?login|entre para continuar|autentica[çc][ãa]o (?:necessária|obrigatória)|(?:please |you must )(?:log in|sign in)|(?:login|sign[ -]?in|authentication) required)\b)/iu;
  const label = element => (element.innerText || element.value || element.getAttribute('aria-label') || '').trim();
  if (elements.some(element => element.matches('h1, h2, [role="heading"], [role="alert"], p') && prompt.test(label(element)))) return true;
  const inputs = elements.filter(element => element.matches('input[type="password"], input[autocomplete="one-time-code"]'));
  return inputs.some(field => {
    const container = field.form ?? field.closest('[role="form"], main') ?? field.getRootNode();
    const controls = elements.filter(element => container.contains(element));
    const formLabel = [field.form?.getAttribute('action'), ...controls.filter(element =>
      element.matches('h1, h2, [role="heading"], button, input[type="submit"]')).map(label)].join(' ');
    if (field.autocomplete === 'one-time-code') return signIn.test(formLabel);
    if (field.type !== 'password' || field.autocomplete === 'new-password') return false;
    if (controls.filter(element => element.type === 'password').length > 1) return false;
    return signIn.test(formLabel) || (!managePassword.test(formLabel) && (field.form !== null
      || field.autocomplete === 'current-password'
      || controls.some(element => element instanceof HTMLInputElement && (['username', 'email'].includes(element.autocomplete)
        || (!element.readOnly && ['text', 'email', 'tel'].includes(element.type))))));
  });
}

export async function pageShowsLogin(page, origin, login = {}) {
  const url = new URL(page.url());
  if (url.origin !== origin) return true;
  const visible = (frame, selector) => frame.locator(selector).filter({visible: true}).count();
  const check = async frame => {
    // Reconhece também o próprio formulário configurado com controles personalizados.
    if (login.usernameSelector && login.submitSelector && await visible(frame, login.usernameSelector)
        && await visible(frame, login.submitSelector)) return true;
    const controls = frame.locator('input, h1, h2, [role="heading"], [role="alert"], p, button');
    if (await controls.filter({visible: true}).evaluateAll(loginFormVisible)) return true;
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
  if (await check(page.mainFrame())) return true;
  if (!login.path && !login.sessionMarkers) return false; // Ainda observando o envio inicial.
  const originalRoute = loginRoute(url) === login.path;
  if (login.successSelector && await visible(page, login.successSelector)) return false;
  // A mesma rota pode servir dois documentos. Na rota original,
  // exigimos a confirmação configurada ou conteúdo renderizado no lugar do formulário.
  if (originalRoute && (login.successSelector || !await page.getByText(/\S/u).filter({visible: true}).count())) return true;
  // Sem seletor de sucesso, exija também estado criado ou alterado pelo login.
  // O valor pode girar entre rotas. Só os nomes dos marcadores entram nos metadados.
  const markers = login.sessionMarkers;
  if (!markers) return originalRoute; // Compatibilidade com estados anteriores ao registro dos marcadores.
  if (markers.cookies.length && (await page.context().cookies()).some(cookie =>
    markers.cookies.includes(cookieKey(cookie)))) return false;
  return !await page.evaluate(async markers =>
    markers.session.some(key => sessionStorage.getItem(key) !== null)
    || markers.local.some(key => localStorage.getItem(key) !== null)
    || (markers.databases.length > 0 && (await indexedDB.databases()).some(db => markers.databases.includes(db.name))), markers);
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

function changedNames(before, after) {
  const previous = new Map(before);
  return after.filter(([key, value]) => previous.get(key) !== value).map(([key]) => key);
}

function sessionMarkers(before, state, origin, sessionBefore, sessionAfter) {
  const storage = snapshot => snapshot.origins.find(entry => entry.origin === origin) ?? {};
  const local = snapshot => (storage(snapshot).localStorage ?? []).map(entry => [entry.name, entry.value]);
  const databases = snapshot => (storage(snapshot).indexedDB ?? []).map(db => [db.name, JSON.stringify(db)]);
  return {
    cookies: changedNames([...cookieMap(before.cookies)], [...cookieMap(state.cookies)]),
    local: changedNames(local(before), local(state)),
    session: changedNames(sessionBefore, sessionAfter),
    databases: changedNames(databases(before), databases(state)),
  };
}

/** Usado nos dois lugares que submetem credenciais, antes de qualquer captura. */
export async function submitLogin(page, context, login, origin) {
  const loginPage = new URL(page.url());
  const selectors = {usernameSelector: login.usernameSelector, submitSelector: login.submitSelector, successSelector: login.successSelector};
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
        const field = page.locator(login.passwordSelector).first();
        if (await field.isVisible() || await pageShowsLogin(page, origin, selectors)) return;
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
          sessionMarkers: sessionMarkers(before, state, origin, sessionBefore, sessionStorage),
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
