import assert from 'node:assert/strict';
import test from 'node:test';
import {DesignAchado, clampBasisSeverity, clampHighSeverity, designBasis} from '../src/design-types.ts';

test('base da prova: medida manda, o modelo não declara medido', () => {
  assert.equal(designBasis('preferencia', {kind: 'contrast', ratio: 2.1}), 'medido');
  assert.equal(designBasis('medido', undefined), 'hipotese');
  assert.equal(designBasis('preferencia', null), 'preferencia');
  assert.equal(designBasis(undefined, undefined), 'hipotese');
  assert.equal(designBasis('hipotese', {kind: 'contrast', ratio: -1} as never), 'hipotese');
});

test('preferência nunca passa de informativa', () => {
  for (const severity of ['alta', 'media', 'baixa', 'informativa'] as const) {
    assert.equal(clampBasisSeverity(clampHighSeverity(severity, null), 'preferencia'), 'informativa');
  }
  assert.equal(clampBasisSeverity('media', 'hipotese'), 'media');
  assert.equal(clampBasisSeverity('alta', 'medido'), 'alta');
});

test('achado antigo sem base continua válido', () => {
  const old = {
    id: 'ACH-001', title: 'Contraste baixo', severity: 'alta', status: 'confirmado', verifier: null,
    reference: 'WCAG-1-4-3', where: {file: 'src/App.tsx', line: null}, scenario: 'x', proof: 'y',
    suggestion: 'z', acceptance: 'w', sources: ['medida'], secretPreview: null,
  };
  assert.equal(DesignAchado.safeParse(old).success, true);
  assert.equal(DesignAchado.safeParse({...old, basis: 'preferencia'}).success, true);
  assert.equal(DesignAchado.safeParse({...old, basis: 'gosto'}).success, false);
});
