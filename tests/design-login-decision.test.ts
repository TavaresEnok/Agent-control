import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {assertInternalDesignNetwork} from '../src/design-trust.ts';
import {claimDesignContainer, closeDesignContainers, releaseDesignContainer, resetDesignContainersForTest, setDesignContainerRemoverForTest} from '../src/design-containers.ts';
// @ts-expect-error módulo da imagem, em JavaScript puro
import {bodyLeaksPassword, cookieChanged, cookieMap, loginOpened, samePage} from '../deploy/design-tools/login-decision.mjs';

const base = {labOpen: false, hiddenReads: 0, left: false, changed: false, secondStep: false, successRequired: false, successVisible: false};

test('login real: abre com campo oculto em leituras seguidas, cookie novo e saída da página', () => {
  assert.equal(loginOpened({...base, hiddenReads: 2, left: true, changed: true}), true);
  assert.equal(loginOpened({...base, hiddenReads: 1, left: true, changed: true}), false, 'uma leitura só não basta');
  assert.equal(loginOpened({...base, hiddenReads: 3, left: true, changed: false}), false, 'sem cookie nem storage novo');
});

test('SPA na mesma URL precisa do campo oculto por mais tempo', () => {
  assert.equal(loginOpened({...base, hiddenReads: 2, changed: true}), false);
  assert.equal(loginOpened({...base, hiddenReads: 4, changed: true}), true);
});

test('segundo fator na tela nunca conta como sessão aberta', () => {
  assert.equal(loginOpened({...base, hiddenReads: 5, left: true, changed: true, secondStep: true}), false);
  assert.equal(loginOpened({...base, successRequired: true, successVisible: true, secondStep: true}), false);
});

test('com successSelector, só o seletor visível abre: a página de bloqueio com cookie de flash não passa', () => {
  const blocked = {...base, hiddenReads: 4, left: true, changed: true, successRequired: true, successVisible: false};
  assert.equal(loginOpened(blocked), false);
  assert.equal(loginOpened({...blocked, successVisible: true}), true);
});

test('o cookie do laboratório continua valendo sozinho', () => {
  assert.equal(loginOpened({...base, labOpen: true}), true);
});

test('cookie mudado ou novo é detectado; páginas iguais ignoram a barra final', () => {
  const before = cookieMap([{domain: 'a.local', path: '/', name: '__Host-csrf', value: 'x'}]);
  assert.equal(cookieChanged(before, [{domain: 'a.local', path: '/', name: '__Host-csrf', value: 'x'}]), false);
  assert.equal(cookieChanged(before, [{domain: 'a.local', path: '/', name: '__Host-session', value: 's'}]), true);
  assert.equal(samePage(new URL('https://a.local/entrar/'), new URL('https://a.local/entrar')), true);
  assert.equal(samePage(new URL('https://a.local/painel'), new URL('https://a.local/entrar')), false);
});

test('a senha é achada crua, curta, escapada no JSON, codificada e em base64', () => {
  const user = 'admin@example.test';
  for (const password of ['abc', 'abc"12\\3', 'p@ss word+1', 'senha-longa-123']) {
    // O valor gravado; o JSON do storageState escapa aspas e barras da forma crua.
    const forms = [
      password,
      encodeURIComponent(password),
      new URLSearchParams({p: password}).toString().slice(2),
      Buffer.from(`${user}:${password}`).toString('base64url'),
    ];
    for (const form of forms) {
      const body = JSON.stringify({origins: [{localStorage: [{name: 't', value: `x${form}y`}]}]});
      assert.equal(bodyLeaksPassword(body, user, password), true, `${password} como ${form}`);
    }
  }
  assert.equal(bodyLeaksPassword(JSON.stringify({cookies: [{name: 's', value: 'opaco'}]}), user, 'senha-longa-123'), false);
});

test('depois do fechamento, um contêiner criado tarde ainda é removido', async () => {
  resetDesignContainersForTest();
  const removed: string[] = [];
  setDesignContainerRemoverForTest(async name => { removed.push(name); });
  const early = claimDesignContainer();
  await closeDesignContainers();
  assert.deepEqual(removed, [early]);
  // O run() em segundo plano termina depois da limpeza: a liberação remove de novo, pelo nome.
  await releaseDesignContainer(early);
  assert.deepEqual(removed, [early, early]);
  assert.throws(() => claimDesignContainer(), /DESIGN_SESSION_CLOSED/);
  resetDesignContainersForTest();
});

test('o --ca exige a rede de homologação interna', async () => {
  const refused = (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_TRUST_CA_NETWORK';
  await assertInternalDesignNetwork(async () => 'true\n');
  await assert.rejects(assertInternalDesignNetwork(async () => 'false\n'), refused);
  await assert.rejects(assertInternalDesignNetwork(async () => { throw new Error('no such network'); }), refused);
});

test('a limpeza tira o sticky das pastas próprias, apaga tudo e não segue link', async () => {
  const {chmod, mkdir, mkdtemp, writeFile, symlink, stat} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {designScratchRoot, removeDesignScratch} = await import('../src/design-containers.ts');
  const outside = await mkdtemp(join(tmpdir(), 'design-fora-'));
  await writeFile(join(outside, 'manter.txt'), 'x');
  const root = await mkdtemp(join(tmpdir(), 'design-login-'));
  await mkdir(join(root, 'out'));
  await chmod(join(root, 'out'), 0o1777);
  await writeFile(join(root, 'out', 'state.json'), '{}');
  await symlink(outside, join(root, 'out', 'link'));
  // O estado do caminho da imagem (out/state.json) e o do host (state.json) acham a mesma raiz.
  assert.equal(await designScratchRoot(join(root, 'out', 'state.json')), root);
  assert.equal(await designScratchRoot(join(root, 'state.json')), root);
  // Fora de uma pasta design-* filha do tmp, nada é apagado.
  assert.equal(await designScratchRoot(join(outside, 'manter.txt')), undefined);
  assert.equal(await removeDesignScratch(tmpdir()), false);
  assert.equal(await removeDesignScratch(outside), false);
  assert.equal(await removeDesignScratch(join(root, 'out')), false, 'só a raiz, nunca uma subpasta');
  assert.equal((await stat(join(outside, 'manter.txt'))).isFile(), true);
  assert.equal(await removeDesignScratch(root), true);
  await assert.rejects(stat(root));
  assert.equal((await stat(join(outside, 'manter.txt'))).isFile(), true);
  const {rm} = await import('node:fs/promises');
  await rm(outside, {recursive: true, force: true});
});
