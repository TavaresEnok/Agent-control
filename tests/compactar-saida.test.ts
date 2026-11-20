import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactarSaida, encurtarCaminhos, agruparLinhasRepetidas, processarSaidaTestes } from '../scripts/compactar-saida.mjs';

describe('compactar-saida', () => {
  it('encurta caminhos absolutos longos preservando nomes e linhas', () => {
    const raw = `
src/api.ts(609,52): error TS7006: Parameter 'run' implicitly has an 'any' type.
/home/app/projects/ac-wt/econ-t4/src/planning.ts:11:96: Error: something failed
/home/app/projects/agent-control/src/server.ts:42:10: Error in server
file:///home/app/projects/agent-control/node_modules/tsx/dist/esm/index.mjs:2:3744
    `.trim();

    const result = encurtarCaminhos(raw, '/home/app/projects/ac-wt/econ-t4');
    assert.match(result, /\.\/src\/planning\.ts:11:96/);
    assert.match(result, /\.\/src\/server\.ts:42:10/);
    assert.match(result, /src\/api\.ts\(609,52\)/);
  });

  it('agrupa linhas consecutivas repetidas', () => {
    const lines = [
      'log line 1',
      'repeated warning',
      'repeated warning',
      'repeated warning',
      'log line 2',
      'another line'
    ];

    const result = agruparLinhasRepetidas(lines);
    assert.deepEqual(result, [
      'log line 1',
      'repeated warning [repetida 3x]',
      'log line 2',
      'another line'
    ]);
  });

  it('guarda apenas o resumo em testes que passaram', () => {
    const passingTestOutput = `
✔ credential-bearing origins require TLS outside loopback in both configuration and relay (6.396232ms)
✔ second test passed (2.1ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1199.885977
    `.trim();

    const res = processarSaidaTestes(passingTestOutput);
    assert.ok(res !== null);
    assert.equal(res.falhou, false);
    const compactado = compactarSaida(passingTestOutput);
    assert.match(compactado, /ℹ pass 2/);
    assert.match(compactado, /ℹ tests 2/);
    assert.ok(!compactado.includes('…'));
  });

  it('mostra a falha inteira em testes que falharam', () => {
    const failingTestOutput = `
node:internal/modules/run_main:107
    triggerUncaughtException(
    ^
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/app/projects/ac-wt/econ-t4/upstream/cezar/packages/cezar/dist/workflows/types.js' imported from /home/app/projects/ac-wt/econ-t4/src/planning.ts
    at finalizeResolution (node:internal/modules/esm/resolve:272:11)
    at moduleResolve (node:internal/modules/esm/resolve:879:10)
    at defaultResolve (node:internal/modules/esm/resolve:1006:11)
    at nextResolve (node:internal/modules/esm/hooks:785:28)
✖ tests/usage.test.ts (687.136892ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
✖ failing tests:
test at tests/usage.test.ts:1:1
✖ tests/usage.test.ts (687.136892ms)
  'test failed'
    `.trim();

    const res = processarSaidaTestes(failingTestOutput);
    assert.ok(res !== null);
    assert.equal(res.falhou, true);

    const compactado = compactarSaida(failingTestOutput, { maxLinhas: 50 });
    // Mensagem de erro e arquivo:linha devem permanecer visíveis
    assert.match(compactado, /Error \[ERR_MODULE_NOT_FOUND\]/);
    assert.match(compactado, /tests\/usage\.test\.ts/);
    assert.match(compactado, /src\/planning\.ts/);
  });

  it('limita linhas com aviso de omissão quando excede maxLinhas', () => {
    const longOutput = Array.from({ length: 100 }, (_, i) => `item #${i + 1}`).join('\n');
    const compactado = compactarSaida(longOutput, { maxLinhas: 30 });
    const linhas = compactado.split('\n');

    assert.equal(linhas.length, 30);
    assert.ok(linhas.some(l => l.includes('linhas omitidas')));
    assert.match(linhas[0], /item #1/);
    assert.match(linhas[linhas.length - 1], /item #100/);
  });
  it('preserva uma falha longa mesmo com limite pequeno', () => {
    const raw = ['not ok 1 - exemplo', ...Array.from({length: 90}, (_, i) => `frame ${i}`), '# tests 1', '# pass 0', '# fail 1'].join('\n');
    assert.equal(compactarSaida(raw, { maxLinhas: 2 }), raw);
  });

  it('trata TAP de sucesso e valida o limite', () => {
    const raw = 'ok 1 - exemplo\n# tests 1\n# pass 1\n# fail 0';
    assert.equal(compactarSaida(raw), '# tests 1\n# pass 1\n# fail 0');
    assert.throws(() => compactarSaida('texto', { maxLinhas: 1 }));
    assert.equal(compactarSaida('a\nb\nc', { maxLinhas: 2 }).split('\n').length, 2);
  });
});
