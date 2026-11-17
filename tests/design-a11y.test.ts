import assert from 'node:assert/strict';
import {test} from 'node:test';
import {axeToFindings, pa11yToFindings, staticHtmlFindings} from '../src/design-a11y.ts';
import {DESIGN_PLANTED_RULES, DesignRawFinding} from '../src/design-types.ts';

const low = '<p style="color: #8a8a8a; background-color: #f4f4f4; font-size: 16px;">Texto cinza</p>';
const named = '<button type="button">Salvar</button>';
const empty = '<button type="button"></button>';

test('contraste baixo gera a regra plantada', () => {
  const findings = staticHtmlFindings('tela.html', low);
  const hit = findings.find(item => item.rule === DESIGN_PLANTED_RULES.contrast);
  assert.equal(hit?.severity, 'alta');
  assert.equal(hit?.measure?.kind, 'contrast');
  if (hit?.measure?.kind !== 'contrast') return;
  assert.equal(Number.isFinite(hit.measure.ratio), true);
  assert.ok(hit.measure.ratio < 4.5);
  assert.match(hit.snippet, new RegExp(`contraste ${hit.measure.ratio.toFixed(2).replace('.', '\\.')}:1`));
});

test('botao com texto nao gera achado de nome', () => {
  const findings = staticHtmlFindings('tela.html', named);
  assert.equal(findings.some(item => item.rule === DESIGN_PLANTED_RULES.unlabeledButton), false);
});

test('botao vazio gera a regra plantada', () => {
  const findings = staticHtmlFindings('tela.html', empty);
  assert.equal(findings.some(item => item.rule === DESIGN_PLANTED_RULES.unlabeledButton && item.severity === 'media' && item.tool === 'html'), true);
  assert.equal(staticHtmlFindings('tela.html', '<button></button>').some(item => item.rule === DESIGN_PLANTED_RULES.unlabeledButton && item.severity === 'media'), true);
  assert.equal(findings.some(item => item.severity === 'alta'), false);
});

function unlabeled(html: string) {
  return staticHtmlFindings('tela.tsx', html).filter(item => item.rule === DESIGN_PLANTED_RULES.unlabeledButton);
}

test('expressao JSX de aria-label, aria-labelledby e title conta como nome', () => {
  const namedByExpr = [
    '<button aria-label={`Move ${names[id]}`}></button>',
    '<button aria-label={describe(point)}></button>',
    '<button aria-label={`${expanded ? \'Collapse\' : \'Expand\'} ${project.name}`}></button>',
    '<Button aria-label={`Move ${names[id]}`}><span class="x"></span></Button>',
    '<button aria-label={"texto"}></button>',
    '<button aria-label={\'texto\'}></button>',
    '<button aria-label={cond ? a : b}></button>',
    '<button aria-label={count > 0 ? "Open" : "Close"}></button>',
    '<button aria-label={`a > b`}></button>',
    '<button aria-labelledby={fieldId}></button>',
    '<button title={label}></button>',
    '<button title="Fechar"></button>',
    '<button><img alt="Salvar"></button>',
    '<button><img alt=\'Salvar\' /></button>',
    '<button><img alt={describe(image)} /></button>',
    '<button>{label}</button>',
    '<button>{"Salvar"}</button>',
    '<div role="button" aria-label={describe(point)}></div>',
    '<div className={count > 0 ? "a" : "b"} role="button">OK</div>',
  ];
  for (const html of namedByExpr) assert.deepEqual(unlabeled(html), [], html);
});

test('nome vazio continua achado, sem gravidade alta', () => {
  const unnamed = [
    '<button></button>',
    '<button type="button"></button>',
    '<button aria-label=""></button>',
    '<button aria-label=\'\'></button>',
    '<button aria-label={""}></button>',
    '<button aria-label={\'\'}></button>',
    '<button aria-label={``}></button>',
    '<button aria-label={null}></button>',
    '<button aria-label={undefined}></button>',
    '<button aria-label={false}></button>',
    '<button title=""></button>',
    '<button aria-labelledby={null}></button>',
    '<button className={open > 0 ? "a" : "b"}></button>',
    '<button><img alt=""></button>',
    '<button><span></span></button>',
    '<button>{null}</button>',
    '<button>{""}</button>',
    '<button>{false}</button>',
    '<div role="button"></div>',
    '<div className={count > 0 ? "a" : "b"} role="button"></div>',
  ];
  for (const html of unnamed) {
    const findings = unlabeled(html);
    assert.equal(findings.length, 1, html);
    assert.equal(findings[0]?.severity, 'media', html);
  }
  const mixed = '<button aria-label={describe(point)}></button><button type="button"></button>';
  assert.equal(unlabeled(mixed).length, 1);
});

test('so um componente interno nao vira achado de nome', () => {
  const onlyComponent = [
    '<button type="button"><ProjectRowLabel /></button>',
    '<button type="button"><ProjectRowLabel></ProjectRowLabel></button>',
    '<button aria-label=""><ProjectRowLabel project={project} /></button>',
    '<button><ChevronDownIcon aria-hidden="true" /></button>',
  ];
  for (const html of onlyComponent) assert.deepEqual(staticHtmlFindings('tela.tsx', html), [], html);
});

test('axe color-contrast sem razao numerica nao fica alto', () => {
  const findings = axeToFindings('tela.html', {
    violations: [{id: 'color-contrast', impact: 'serious', help: 'Contraste', nodes: [{html: '<p>Texto</p>'}]}],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, DESIGN_PLANTED_RULES.contrast);
  assert.notEqual(findings[0]?.severity, 'alta');
  assert.equal(findings[0]?.tool, 'axe');
  assert.equal(findings[0]?.measure, undefined);
});

test('axe color-contrast com razao numerica permanece alto', () => {
  const findings = axeToFindings('tela.html', {
    violations: [{
      id: 'color-contrast',
      impact: 'serious',
      help: 'Element has insufficient color contrast of 2.89. Expected contrast ratio of 4.5:1',
      nodes: [{html: '<p>Texto</p>', data: {contrastRatio: 2.89}}],
    }],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'alta');
  assert.deepEqual(findings[0]?.measure, {kind: 'contrast', ratio: 2.89});
});

test('pa11y de contraste so fica alto com razao medida', () => {
  const bare = pa11yToFindings('tela.html', [{code: 'WCAG2AA.Principle1.Guideline1_4.1_4_3', message: 'contrast', context: '<p>'}]);
  assert.equal(bare[0]?.rule, DESIGN_PLANTED_RULES.contrast);
  assert.equal(bare[0]?.tool, 'pa11y');
  assert.notEqual(bare[0]?.severity, 'alta');
  const measured = pa11yToFindings('tela.html', [{
    code: 'WCAG2AA.Principle1.Guideline1_4.1_4_3',
    message: 'Element has insufficient color contrast of 2.73. Expected contrast ratio of 4.5:1',
    context: '<p>',
  }]);
  assert.equal(measured[0]?.severity, 'alta');
  assert.deepEqual(measured[0]?.measure, {kind: 'contrast', ratio: 2.73});
});

test('objeto antigo sem medida continua valido', () => {
  const parsed = DesignRawFinding.parse({
    tool: 'html',
    rule: 'REGRA-ANTIGA',
    cwe: null,
    file: 'src/Velho.tsx',
    line: 1,
    severity: 'alta',
    snippet: 'sem campo novo',
    fingerprint: 'ab'.repeat(32),
  });
  assert.equal(parsed.severity, 'alta');
  assert.equal(parsed.measure, undefined);
});
