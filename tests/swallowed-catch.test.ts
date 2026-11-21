import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';

/** Files left out while another front rewrites them. Each entry needs a reason. */
const EXCLUDED: Record<string, string> = {
  'verification-modules.ts': 'em refatoração na rodada 2',
  'native-execution-supervisor.ts': 'em refatoração na rodada 2',
};

/** Blanks comments, string and template text and regex bodies, keeping offsets and newlines. */
function maskCode(src: string): string {
  const out = src.split('');
  const n = src.length;
  const templateDepths: number[] = [];
  let i = 0, depth = 0, last = '';
  const blank = (a: number, b: number) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  const readTemplate = () => {
    while (i < n) {
      const c = src[i]!;
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '`') { i++; return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; templateDepths.push(depth); depth++; return; }
      blank(i, i + 1); i++;
    }
  };
  while (i < n) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      blank(i + 1, j); i = j + 1; last = 'x'; continue;
    }
    if (c === '`') { i++; readTemplate(); last = 'x'; continue; }
    if (c === '/') {
      const keyword = /(?:return|typeof|case|in|of|void|delete|throw)\s*$/.test(src.slice(Math.max(0, i - 12), i));
      if (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last) || keyword) {
        let j = i + 1, inClass = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) break;
          j++;
        }
        blank(i + 1, j); i = j + 1; last = 'x'; continue;
      }
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (templateDepths.length && templateDepths[templateDepths.length - 1] === depth) { templateDepths.pop(); i++; readTemplate(); last = 'x'; continue; }
    }
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return out.join('');
}

const COMMENT = /\/\/|\/\*/;

/** Lines of empty catch blocks and of .catch(() => {} | undefined | void 0) with no justifying comment. */
function unjustifiedCatches(src: string): number[] {
  const masked = maskCode(src);
  const lineOf = (offset: number) => src.slice(0, offset).split('\n').length;
  const found: number[] = [];
  const block = /\bcatch\s*(?:\([^)]*\))?\s*\{/g;
  for (let m; (m = block.exec(masked));) {
    if (masked[m.index - 1] === '.') continue;
    const open = m.index + m[0].length - 1;
    let level = 0, close = open;
    for (; close < masked.length; close++) {
      if (masked[close] === '{') level++;
      else if (masked[close] === '}' && --level === 0) break;
    }
    if (masked.slice(open + 1, close).trim() === '' && !COMMENT.test(src.slice(open + 1, close))) found.push(lineOf(m.index));
  }
  // A handler has no block of its own: a comment inside it, on its line or on the line just above justifies it.
  const lines = src.split('\n');
  const promise = /\.catch\(\s*(?:async\s*)?\(\s*\)\s*=>\s*(?:\{\s*\}|undefined\b|void\s+0\b)\s*\)/g;
  for (let m; (m = promise.exec(masked));) {
    const line = lineOf(m.index);
    const near = src.slice(m.index, m.index + m[0].length) + '\n' + lines[line - 1] + '\n' + (lines[line - 2] ?? '');
    if (!COMMENT.test(near)) found.push(line);
  }
  return found.sort((a, b) => a - b);
}

test('o detector acha catch vazio e .catch sem motivo, e aceita os justificados', () => {
  assert.deepEqual(unjustifiedCatches('try{a()}catch{}\n'), [1]);
  assert.deepEqual(unjustifiedCatches('try{a()}catch(error){ }\n'), [1]);
  assert.deepEqual(unjustifiedCatches('x;\nawait p.catch(()=>{});\n'), [2]);
  assert.deepEqual(unjustifiedCatches('await p.catch(() => undefined);\n'), [1]);
  assert.deepEqual(unjustifiedCatches('void p.catch(async () => void 0);\n'), [1]);
  assert.deepEqual(unjustifiedCatches('try{a()}catch{/* motivo */}\nawait p.catch(()=>{/* motivo */});\nawait q.catch(() => undefined /* motivo */);\n'), []);
  assert.deepEqual(unjustifiedCatches('try{a()}catch{\n // motivo\n}\n'), []);
  assert.deepEqual(unjustifiedCatches('// motivo\nawait p.catch(()=>{});\nawait q.catch(()=>{}); // motivo\n'), []);
  assert.deepEqual(unjustifiedCatches('// motivo\nx;\nawait p.catch(()=>{});\n'), [3]);
  assert.deepEqual(unjustifiedCatches('// motivo\ntry{a()}catch{}\n'), [2]);
  assert.deepEqual(unjustifiedCatches('try{a()}catch{return null;}\np.catch(()=>null);\np.catch(e=>log(e));\n'), []);
  assert.deepEqual(unjustifiedCatches('const s = "catch{}"; const t = `${x} .catch(()=>{})`; // catch{}\n'), []);
  assert.deepEqual(unjustifiedCatches('const r = /catch{}/; try{a()}catch{}\n'), [1]);
});

test('src/*.ts não tem catch que engole erro sem justificativa', () => {
  const root = join(import.meta.dirname, '..', 'src');
  for (const name of Object.keys(EXCLUDED)) assert.ok(existsSync(join(root, name)), `exclusão sem arquivo: ${name}`);
  for (const [name, reason] of Object.entries(EXCLUDED)) assert.ok(reason.trim(), `exclusão sem motivo: ${name}`);
  const offenders: string[] = [];
  for (const name of readdirSync(root).filter(file => file.endsWith('.ts')).sort()) {
    if (name in EXCLUDED) continue;
    for (const line of unjustifiedCatches(readFileSync(join(root, name), 'utf8'))) offenders.push(`src/${name}:${line}`);
  }
  assert.deepEqual(offenders, [], 'trate o erro ou diga no próprio bloco por que o silêncio é correto:\n' + offenders.join('\n'));
});
