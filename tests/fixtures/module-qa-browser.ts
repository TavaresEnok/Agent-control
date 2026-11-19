import assert from 'node:assert/strict';
import {chmodSync, cpSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const source = fileURLToPath(new URL('./module-qa-browser/', import.meta.url));

// PNGs sintéticos fixos, 800×600. O controle é todo #2468ac. A variante contém
// um retângulo #c02020 de x=30 a 39 e y=40 a 59. Nenhum foi capturado do navegador.
export const referencePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAyAAAAJYAQMAAACguBAzAAAABlBMVEUkaKzAICCo4Pb0AAAAUUlEQVR42u3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8G+y4AAFJyw/RAAAAAElFTkSuQmCC', 'base64',
);
export const changedPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAyAAAAJYAQMAAACguBAzAAAABlBMVEUkaKzAICCo4Pb0AAAAXklEQVR42u3NQQ0AAAgEoNvsn1lT+NBBARIAAADgkmqJRCKRSCQfEwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABg3wBCVRQpHQcwtwAAAABJRU5ErkJggg==', 'base64',
);

export const imageRenderer = `mcr.microsoft.com/playwright@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579/${process.arch}`;
export const hostRenderer = `host/${process.platform}/${process.arch}`;

export function referenceMetadata(renderer: string) {
  return {
    schema: 1, width: 800, height: 600, deviceScaleFactor: 1, playwright: '1.65.1', chromium: '159.0.8154.6', renderer,
    presentation: 'chromium-headless-css-light-reduced-motion-pt-BR-UTC-v1',
  };
}

export function stageBrowserFixture(renderer: string) {
  const directory = mkdtempSync(join(tmpdir(), 'qa-browser-fixture-'));
  cpSync(source, directory, {recursive: true});
  chmodSync(directory, 0o755);
  for (const name of ['visual-controle.html', 'visual-defeito.html']) {
    const base = join(directory, 'public', `${name}.qa-visual`);
    writeFileSync(`${base}.png`, referencePng);
    writeFileSync(`${base}.json`, JSON.stringify(referenceMetadata(renderer)));
  }
  return directory;
}

export type BrowserOutput = {
  coverage: {tool: string; status: string; detail: string}[];
  findings: {tool: string; rule: string; file: string; line: number; evidence: string}[];
};

export function assertBrowserFixture(report: BrowserOutput) {
  const row = (tool: string) => {
    const result = report.coverage.find(item => item.tool === tool);
    assert.ok(result, tool);
    return result;
  };
  const contrast = report.findings.filter(finding => finding.rule === 'QA-AXE-COLOR-CONTRAST');
  assert.equal(contrast.length, 1);
  assert.equal(contrast[0]?.tool, 'axe-core');
  assert.equal(contrast[0]?.file, 'public/defeito.html');
  assert.equal(contrast[0]?.line, 11);
  assert.match(contrast[0]?.evidence ?? '', /id="total".*contraste 2\.32:1/);
  for (const file of ['controle.html', 'defeito.html', 'visual-controle.html', 'visual-defeito.html']) {
    assert.equal(row(`qa-navegador:public/${file}`).status, 'ok');
  }
  assert.equal(row('qa-contraste:public/controle.html').status, 'ok');
  assert.match(row('qa-contraste:public/controle.html').detail, /0 violações/);
  assert.equal(row('qa-contraste:public/defeito.html').status, 'ok');
  assert.match(row('qa-regressao-visual:public/defeito.html').detail, /sem referência versionada/);
  assert.equal(row('qa-regressao-visual:public/visual-controle.html').status, 'ok');
  assert.match(row('qa-regressao-visual:public/visual-controle.html').detail, /0\/480000 pixels/);
  assert.equal(row('qa-regressao-visual:public/visual-defeito.html').status, 'ok');
  assert.match(row('qa-regressao-visual:public/visual-defeito.html').detail, /200\/480000 pixels/);
  const visual = report.findings.filter(finding => finding.rule === 'QA-REGRESSAO-VISUAL');
  assert.equal(visual.length, 1);
  assert.equal(visual[0]?.file, 'public/visual-defeito.html');
  assert.match(visual[0]?.evidence ?? '', /200\/480000 pixels.*30,40–39,59/);
  assert.deepEqual(report.findings.filter(finding => /controle\.html$/.test(finding.file)), []);
}
