import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {isDesignTokensPath, parseDesignProjectConfig} from '../src/design-project-config.ts';

function isConfigRefusal(error: unknown): boolean {
  return error instanceof Refusal && error.code === 'DESIGN_CONFIG_INVALID';
}

test('tokens e sinaisGenericos entram no config', () => {
  const config = parseDesignProjectConfig(JSON.stringify({routes: {'/': {}}, tokens: 'design/tokens.json', sinaisGenericos: false}));
  assert.equal(config.tokens, 'design/tokens.json');
  assert.equal(config.genericSignals, false);
  assert.ok(config.routes['/']);
  assert.equal(parseDesignProjectConfig(JSON.stringify({routes: {}, tokens: 'src/tokens.css'})).tokens, 'src/tokens.css');
});

test('sem as chaves novas o config fica igual', () => {
  const config = parseDesignProjectConfig(JSON.stringify({routes: {'/': {dark: true}}}));
  assert.deepEqual(config, {routes: {'/': {dark: true, bareStates: [], reaches: [], loginState: false}}});
  assert.equal(config.genericSignals, undefined);
  assert.deepEqual(parseDesignProjectConfig(undefined), {routes: {}});
});

test('config só com tokens não precisa de routes', () => {
  assert.deepEqual(parseDesignProjectConfig(JSON.stringify({tokens: 'tokens.json'})), {routes: {}, tokens: 'tokens.json'});
  assert.throws(() => parseDesignProjectConfig('{}'), isConfigRefusal);
});

test('caminho de tokens inseguro ou de outro tipo é recusado', () => {
  for (const tokens of ['/etc/tokens.json', '../tokens.json', 'a/../b.json', 'a\\b.json', 'C:/t.json', 'tokens.yaml', 'tokens', '', `${'a'.repeat(300)}.css`, 'a\u0000.json']) {
    assert.equal(isDesignTokensPath(tokens), false, tokens);
    assert.throws(() => parseDesignProjectConfig(JSON.stringify({routes: {}, tokens})), isConfigRefusal, tokens);
  }
  assert.throws(() => parseDesignProjectConfig(JSON.stringify({routes: {}, tokens: 3})), isConfigRefusal);
  assert.throws(() => parseDesignProjectConfig(JSON.stringify({routes: {}, sinaisGenericos: 'sim'})), isConfigRefusal);
  assert.equal(isDesignTokensPath('design/marca.tokens.json'), true);
});
