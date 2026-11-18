import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadDesignChecklist} from '../src/design-checklist.ts';

const SOURCES = ['NIELSEN', 'UX-LAW', 'WCAG-2.2', 'TOKENS', 'STATES', 'UX-WRITING', 'SMALL-SCREEN'] as const;

test('lista de design cobre fontes, números e leis', () => {
  const items = loadDesignChecklist();
  assert.ok(items.length >= 40);
  assert.ok(items.length <= 80);
  assert.equal(new Set(items.map(entry => entry.id)).size, items.length);
  const sources = new Set(items.map(entry => entry.source));
  for (const source of SOURCES) assert.ok(sources.has(source), source);
  assert.equal(items.filter(entry => entry.source === 'NIELSEN').length, 10);
  assert.ok(items.filter(entry => entry.source === 'UX-LAW').length >= 10);
  for (const entry of items) assert.match(entry.id, /^DESIGN-[A-Z0-9-]{3,80}$/);
  const blob = items.map(entry => `${entry.title}\n${entry.prompt}`).join('\n');
  assert.match(blob, /não/);
  assert.match(blob, /tela/);
  const contrast = items.find(entry => entry.id === 'DESIGN-WCAG-143-CONTRASTE');
  const target = items.find(entry => entry.id === 'DESIGN-WCAG-258-ALVO-24');
  const reflow = items.find(entry => entry.id === 'DESIGN-WCAG-1410-REFLOW');
  const focus = items.find(entry => entry.id === 'DESIGN-WCAG-247-FOCO-VISIVEL');
  assert.ok(contrast?.prompt.includes('4.5:1'));
  assert.ok(contrast?.prompt.includes('24px'));
  assert.ok(target?.prompt.includes('24px'));
  assert.ok(reflow?.prompt.includes('320'));
  assert.ok(reflow?.prompt.includes('375'));
  assert.match(focus?.prompt ?? '', /foco visível/i);
  for (const name of ['Fitts', 'Hick', 'Miller', 'Jakob', 'Tesler', 'Doherty', 'Von Restorff', 'Postel']) {
    assert.ok(items.some(entry => entry.source === 'UX-LAW' && `${entry.title} ${entry.prompt}`.includes(name)), name);
  }
  assert.ok(items.some(entry => entry.source === 'UX-LAW' && /estética/i.test(`${entry.title} ${entry.prompt}`)));
  assert.ok(items.some(entry => entry.source === 'UX-LAW' && /pico-fim/i.test(`${entry.title} ${entry.prompt}`)));
  for (const state of ['vazio', 'carregando', 'erro', 'sucesso', 'desabilitado']) {
    assert.ok(items.some(entry => entry.source === 'STATES' && entry.title.toLowerCase().includes(state)), state);
  }
  const grays = items.find(entry => entry.id === 'DESIGN-TOKENS-CINZAS');
  const spacing = items.find(entry => entry.id === 'DESIGN-TOKENS-ESPACAMENTO');
  assert.ok(grays?.prompt.includes('Oito ou mais'));
  assert.match(spacing?.prompt ?? '', /4px/);
  assert.ok(items.some(entry => entry.source === 'UX-WRITING' && entry.prompt.includes('Nenhum item')));
  assert.ok(items.some(entry => entry.source === 'SMALL-SCREEN' && entry.prompt.includes('768') && entry.prompt.includes('1440')));
  assert.deepEqual(loadDesignChecklist().map(entry => entry.id), items.map(entry => entry.id));
});
