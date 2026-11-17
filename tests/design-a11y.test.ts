import assert from 'node:assert/strict';
import {test} from 'node:test';
import {axeToFindings, pa11yToFindings, staticHtmlFindings} from '../src/design-a11y.ts';
import {DESIGN_PLANTED_RULES} from '../src/design-types.ts';

const low = '<p style="color: #8a8a8a; background-color: #f4f4f4; font-size: 16px;">Texto cinza</p>';
const named = '<button type="button">Salvar</button>';
const empty = '<button type="button"></button>';

test('contraste baixo gera a regra plantada', () => {
  const findings = staticHtmlFindings('tela.html', low);
  assert.equal(findings.some(item => item.rule === DESIGN_PLANTED_RULES.contrast && item.severity === 'alta'), true);
});

test('botao com texto nao gera achado de nome', () => {
  const findings = staticHtmlFindings('tela.html', named);
  assert.equal(findings.some(item => item.rule === DESIGN_PLANTED_RULES.unlabeledButton), false);
});

test('botao vazio gera a regra plantada', () => {
  const findings = staticHtmlFindings('tela.html', empty);
  assert.equal(findings.some(item => item.rule === DESIGN_PLANTED_RULES.unlabeledButton && item.severity === 'alta' && item.tool === 'html'), true);
  assert.equal(staticHtmlFindings('tela.html', '<button></button>').some(item => item.rule === DESIGN_PLANTED_RULES.unlabeledButton && item.severity === 'alta'), true);
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

test('nome vazio e botao sem prova continuam achado alto', () => {
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
    assert.equal(findings[0]?.severity, 'alta', html);
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

test('axe color-contrast vira a regra plantada', () => {
  const findings = axeToFindings('tela.html', {
    violations: [{id: 'color-contrast', impact: 'serious', help: 'Contraste', nodes: [{html: '<p>Texto</p>'}]}],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, DESIGN_PLANTED_RULES.contrast);
  assert.equal(findings[0]?.severity, 'alta');
  assert.equal(findings[0]?.tool, 'axe');
});

test('pa11y de contraste vira a regra plantada', () => {
  const findings = pa11yToFindings('tela.html', [{code: 'WCAG2AA.Principle1.Guideline1_4.1_4_3', message: 'contrast', context: '<p>'}]);
  assert.equal(findings[0]?.rule, DESIGN_PLANTED_RULES.contrast);
  assert.equal(findings[0]?.tool, 'pa11y');
});
