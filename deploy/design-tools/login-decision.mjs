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
  const fragment = /^#!?\//u.test(url.hash) ? url.hash.split('?')[0].replace(/\/+$/u, '') : '';
  return path + fragment;
}

/** Executado no documento por Playwright e Puppeteer. */
export function loginFormVisible() {
  const visible = field => field.getClientRects().length > 0 && getComputedStyle(field).visibility === 'visible';
  if ([...document.querySelectorAll('input[autocomplete="one-time-code"]')].some(visible)) return true;
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
  return passwords.some(password => {
    if (password.autocomplete === 'new-password') return false;
    const form = password.form;
    const fields = form ? [...form.elements] : [...document.querySelectorAll('input')];
    const inputs = fields.filter(field => field instanceof HTMLInputElement && visible(field));
    if (inputs.filter(field => field.type === 'password').length > 1) return false;
    return inputs.some(field => ['username', 'email'].includes(field.autocomplete)
      || (!field.readOnly && ['text', 'email', 'tel'].includes(field.type)));
  });
}

/**
 * A sessão abriu?
 * - Laboratório: o cookie ac_lab_session=aberta basta.
 * - Com successSelector no arquivo de login: o seletor visível e nenhum segundo passo na tela.
 * - Sem ele: o campo de senha oculto em leituras seguidas, um cookie ou o storage mudou,
 *   nenhum segundo passo (outra senha ou código) na tela, e a página saiu do login ou
 *   ficou mais tempo sem o campo (SPA na mesma URL). Uma página de erro sem formulário
 *   em outro caminho pode passar nesse caso: o successSelector fecha essa porta.
 */
export function loginOpened(observed) {
  if (observed.labOpen) return true;
  if (observed.secondStep) return false;
  if (observed.successRequired) return observed.successVisible === true;
  if (!observed.changed || observed.hiddenReads < 2) return false;
  return observed.left || observed.hiddenReads >= 4;
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
