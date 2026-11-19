/** CPU sampling of one deliberately restricted, autonomous JavaScript function.
 * The profiler, VM, and evidence channel are controlled by the observer.
 */
import {spawn} from 'node:child_process';
import {realpathSync, readFileSync, statSync} from 'node:fs';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from './cpu-parser/node_modules/acorn/dist/acorn.mjs';

const MAX_SOURCE = 128 * 1024;
const PROFILE_URL = 'cpu-snapshot.js';
const operators = new Set(['+', '-', '*', '/', '%', '**', '<<', '>>', '>>>', '|', '&', '^', '<', '<=', '>', '>=', '===', '!==', '==', '!=', '&&', '||', '=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '>>>=', '|=', '&=', '^=']);

function extract(source, requested) {
  const comments = [];
  const tree = parse(source, {ecmaVersion: 2022, sourceType: 'module', locations: true, onComment: comments});
  const declarations = tree.body.map(n => n.type === 'ExportNamedDeclaration' ? n.declaration : n);
  const matches = declarations.filter(n => n?.type === 'FunctionDeclaration' && n.id?.name === requested);
  if (matches.length !== 1) throw new Error('função declarada no topo ausente ou ambígua');
  const fn = matches[0];
  if (!fn.body || fn.params.length || fn.generator || fn.async) throw new Error('função deve ser síncrona, sem parâmetros e com corpo');
  if (comments.some(c => c.start >= fn.start && c.end <= fn.end && /[#@]\s*source(?:Mapping)?URL\s*=/.test(c.value))) throw new Error('diretiva de origem não permitida');
  const names = new Set();
  let count = 0;
  function scan(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type && ++count > 2500) throw new Error('função excede limite de nós');
    if (n.type === 'VariableDeclarator') {
      if (n.id.type !== 'Identifier' || !n.init || n.id.name === 'performance' || n.id.name === requested || names.has(n.id.name)) throw new Error('declaração local não suportada');
      names.add(n.id.name);
    }
    for (const [key, value] of Object.entries(n)) {
      if (key === 'loc') continue;
      if (Array.isArray(value)) value.forEach(scan);
      else if (value && typeof value === 'object') scan(value);
    }
  }
  scan(fn.body);
  function validate(n) {
    if (!n) return;
    switch (n.type) {
      case 'BlockStatement': return n.body.forEach(validate);
      case 'VariableDeclaration':
        if (!['let', 'const'].includes(n.kind)) throw new Error('use let ou const');
        return n.declarations.forEach(validate);
      case 'VariableDeclarator': return validate(n.init);
      case 'ExpressionStatement': return validate(n.expression);
      case 'ReturnStatement': return validate(n.argument);
      case 'IfStatement': validate(n.test); validate(n.consequent); return validate(n.alternate);
      case 'WhileStatement': case 'DoWhileStatement': validate(n.test); return validate(n.body);
      case 'ForStatement': validate(n.init); validate(n.test); validate(n.update); return validate(n.body);
      case 'BreakStatement': case 'ContinueStatement': if (n.label) throw new Error('rótulo não suportado'); return;
      case 'Literal': if ((typeof n.value === 'number' && Number.isFinite(n.value)) || typeof n.value === 'boolean') return; break;
      case 'Identifier': if (names.has(n.name)) return; throw new Error(`referência não permitida: ${n.name}`);
      case 'BinaryExpression': case 'LogicalExpression': case 'AssignmentExpression':
        if (!operators.has(n.operator)) throw new Error('operador não permitido');
        if (n.type === 'AssignmentExpression' && (n.left.type !== 'Identifier' || !names.has(n.left.name))) throw new Error('destino de atribuição inválido');
        validate(n.left); return validate(n.right);
      case 'UnaryExpression': case 'UpdateExpression':
        if (!['+', '-', '!', '~', '++', '--'].includes(n.operator)) throw new Error('operador unário não permitido');
        if (n.type === 'UpdateExpression' && (n.argument.type !== 'Identifier' || !names.has(n.argument.name))) throw new Error('atualização inválida');
        return validate(n.argument);
      case 'ConditionalExpression': validate(n.test); validate(n.consequent); return validate(n.alternate);
      case 'CallExpression':
        if (!n.optional && n.arguments.length === 0 && n.callee.type === 'MemberExpression' && !n.callee.optional && !n.callee.computed && n.callee.object.type === 'Identifier' && n.callee.object.name === 'performance' && n.callee.property.name === 'now') return;
        break;
      case 'ObjectExpression':
        for (const p of n.properties) {
          if (p.type !== 'Property' || p.kind !== 'init' || p.method || p.shorthand || p.computed || !['Identifier', 'Literal'].includes(p.key.type) || (p.key.name ?? p.key.value) === '__proto__') throw new Error('propriedade não permitida');
          validate(p.value);
        }
        return;
    }
    throw new Error(`sintaxe não permitida: ${n.type}`);
  }
  validate(fn.body);
  return {text: source.slice(fn.start, fn.end), line: fn.loc.start.line, column: fn.loc.start.column};
}

function readSnapshot(root, file) {
  if (typeof root !== 'string' || typeof file !== 'string' || !file || isAbsolute(file) || file.includes('\\') || file.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('caminho inválido');
  const base = realpathSync(root), target = realpathSync(resolve(base, file));
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep).join('/') !== file) throw new Error('arquivo fora do snapshot ou caminho simbólico');
  const stat = statSync(target);
  if (!stat.isFile() || stat.size > MAX_SOURCE) throw new Error('arquivo ausente ou grande demais');
  const data = readFileSync(target);
  if (data.length > MAX_SOURCE) throw new Error('arquivo grande demais');
  return data.toString('utf8');
}

/** Returns measured samples, or explicit partial coverage. Never runs repository entrypoints. */
export async function collectCpuMetrics({snapshotRoot, file, functionName, thresholdMs = 80} = {}) {
  try {
    if (typeof functionName !== 'string' || !/^[A-Za-z_$][\w$]{0,79}$/.test(functionName)) throw new Error('nome de função inválido');
    if (!Number.isFinite(thresholdMs) || thresholdMs < 1 || thresholdMs > 500) throw new Error('limiar inválido');
    const selected = extract(readSnapshot(snapshotRoot, file), functionName);
    const result = await runObserver({...selected, functionName});
    const {profile} = result;
    const nodes = new Map(profile.nodes.map(n => [n.id, n]));
    let selfUs = 0, hits = 0;
    const matchedNodeIds = new Set();
    for (let i = 0; i < profile.samples.length; i++) {
      const frame = nodes.get(profile.samples[i])?.callFrame;
      if (frame?.url === PROFILE_URL && frame.functionName === functionName && frame.lineNumber + 1 === selected.line) {
        hits++; selfUs += profile.timeDeltas[i]; matchedNodeIds.add(profile.samples[i]);
      }
    }
    const ticks = new Map();
    for (const id of matchedNodeIds) for (const tick of nodes.get(id).positionTicks ?? []) {
      if (Number.isInteger(tick.line) && tick.line > 0 && Number.isInteger(tick.ticks) && tick.ticks > 0) ticks.set(tick.line, (ticks.get(tick.line) ?? 0) + tick.ticks);
    }
    const lineTicks = [...ticks].map(([line, ticks]) => ({line, ticks})).sort((a, b) => a.line - b.line);
    const selfMs = selfUs / 1000;
    return {status: 'measured', coverage: 'partial', detail: 'Somente a função autônoma selecionada foi executada; demais códigos e caminhos não foram avaliados.', file, functionName, line: selected.line, column: selected.column + 1, sampleCount: profile.samples.length, selfSamples: hits, lineTicks, selfMs, thresholdMs, hotspot: selfMs >= thresholdMs, profile};
  } catch (error) {
    return {status: 'partial', coverage: 'partial', detail: `CPU não medida: ${error instanceof Error ? error.message : 'erro desconhecido'}`, file, functionName};
  }
}

function runObserver(selected) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=64', '--disable-proto=throw', fileURLToPath(import.meta.url), '--cpu-observer-child'], {stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {PATH: '/usr/bin:/bin', NODE_NO_WARNINGS: '1'}});
    let settled = false;
    const timer = setTimeout(() => finish(new Error('limite externo de tempo excedido')), 3000);
    function finish(error, value) {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill('SIGKILL');
      if (error) reject(error); else resolveResult(value);
    }
    child.on('error', error => finish(error));
    child.on('exit', () => finish(new Error('observador terminou sem perfil')));
    child.on('message', message => {
      if (message?.error) return finish(new Error(message.error));
      const p = message?.profile;
      if (!p || !Array.isArray(p.nodes) || !Array.isArray(p.samples) || !Array.isArray(p.timeDeltas) || p.samples.length !== p.timeDeltas.length || p.samples.length > 10000 || p.timeDeltas.some(d => !Number.isFinite(d) || d < 0)) return finish(new Error('perfil inválido'));
      finish(null, {profile: p});
    });
    child.send(selected, error => { if (error) finish(error); });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--cpu-observer-child') {
  const [{default: inspector}, vm, {performance}] = await Promise.all([import('node:inspector'), import('node:vm'), import('node:perf_hooks')]);
  process.once('message', async selected => {
    const session = new inspector.Session();
    const post = (method, params = {}) => new Promise((ok, fail) => session.post(method, params, (err, value) => err ? fail(err) : ok(value)));
    try {
      session.connect(); await post('Profiler.enable'); await post('Profiler.setSamplingInterval', {interval: 1000}); await post('Profiler.start');
      const clock = Object.freeze(Object.assign(Object.create(null), {now: () => performance.now()}));
      const context = vm.createContext({performance: clock}, {codeGeneration: {strings: false, wasm: false}});
      const code = '\n'.repeat(selected.line - 1) + ' '.repeat(selected.column) + selected.text + `\n${selected.functionName}();`;
      new vm.Script(code, {filename: PROFILE_URL}).runInContext(context, {timeout: 600});
      const {profile} = await post('Profiler.stop'); session.disconnect();
      process.send({profile}, () => process.exit(0));
    } catch (error) { session.disconnect(); process.send({error: String(error.message).slice(0, 300)}, () => process.exit(1)); }
  });
}
