import {createInterface} from 'node:readline';
import ts from 'typescript';

const VERSION = '5.9.3';
const SYNTAX = 'arquivos com sintaxe não analisável';
const LIMIT_GAP = 'leituras de expressão incompletas (limite)';
const DECLARATION = 'declaradores fora do rastreamento';
const UNKNOWN_VALUE = 'resultados de chamadas indiretas com possível origem';
const UNKNOWN_DESTINATION = 'chamadas com possível origem e destino sem vínculo estático';
const MUTATION = 'mutações de propriedades sem vínculo estático';
const BRANCH = 'reatribuições em fluxo condicional ou repetido';
const LOG_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'exception']);
const HTTP_METHODS = new Set(['post', 'put', 'patch', 'request']);
const SQL_METHODS = new Set(['query', 'execute']);
const ARRAY_MUTATORS = new Set(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift']);
const RECEIVERS = new Map([
  ...['logger', 'logging', 'console', 'log'].map(name => [name, ['LOG', LOG_METHODS]]),
  ...['axios', 'requests', 'httpx', 'httpxClient'].map(name => [name, ['NETWORK', HTTP_METHODS]]),
  ...['db', 'pool', 'client', 'connection', 'conn', 'cursor'].map(name => [name, ['SQL', SQL_METHODS]]),
  ['localStorage', ['STORAGE', new Set(['setItem'])]],
]);
const UNKNOWN = {unknown: true};
const LOCAL = {};
const KINDS = {'.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.jsx': ts.ScriptKind.JSX,
  '.ts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX};

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) {
    node = node.expression;
  }
  return node;
}

function literal(node) {
  node = unwrap(node);
  return node && ts.isStringLiteralLike(node) && !node.containsInvalidEscape ? node.text : null;
}

function key(node) {
  if (ts.isComputedPropertyName(node)) return literal(node.expression);
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ? node.text : null;
}

function member(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return literal(node.argumentExpression) ??
    (ts.isNumericLiteral(node.argumentExpression) ? node.argumentExpression.text : null);
  return null;
}

function analyze(text, suffix, fieldPattern, limit) {
  const gaps = new Map();
  const hits = [];
  const sql = [];
  const gap = (reason) => gaps.set(reason, (gaps.get(reason) ?? 0) + 1);
  const result = () => ({hits, sql, gaps: [...gaps]});
  const name = 'input' + suffix;
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, KINDS[suffix]);
  if (file.parseDiagnostics.length) {
    gap(SYNTAX);
    return result();
  }

  // The compiler can bind the supplied tree only. There is no project, library or module resolution.
  const program = ts.createProgram([name], {allowJs: true, noLib: true, noResolve: true, types: []}, {
    getSourceFile: (path) => path === name ? file : undefined,
    fileExists: (path) => path === name,
    readFile: (path) => path === name ? text : undefined,
    getDefaultLibFileName: () => '',
    getCurrentDirectory: () => '',
    getCanonicalFileName: (path) => path,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    writeFile: () => { throw new Error('emissão desativada'); },
  });
  const checker = program.getTypeChecker();
  const field = new RegExp(fieldPattern, 'i');
  const line = (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const scalar = (at) => at === null ? null : {line: at};
  function first(values, seen = new Set()) {
    for (const value of values) {
      const at = origin(value, seen);
      if (at !== null) return at;
    }
    return null;
  }
  const newFrame = () => ({bindings: new Map(), objects: new Map(), writes: new Set()});
  const frames = [newFrame()];
  const external = new Map();
  const find = (table, key) => {
    for (let index = frames.length - 1; index >= 0; index--) {
      if (frames[index][table].has(key)) return frames[index][table].get(key);
    }
    return undefined;
  };
  const active = () => frames[frames.length - 1];
  const state = (data) => find('objects', data) ?? data;
  function origin(data, seen = new Set()) {
    if (!data || seen.has(data)) return null;
    seen.add(data);
    const current = state(data);
    return current.line ?? (current.keys && first(current.keys.values(), seen)) ??
      (current.items && first(current.items, seen)) ?? null;
  }
  const fits = (node) => {
    if (node.end - node.getStart(file) <= limit) return true;
    gap(LIMIT_GAP);
    return false;
  };

  function namespace([kind, methods]) {
    return {keys: new Map([...methods].map(method => [method, {kind}]))};
  }

  function imported(symbol) {
    const declaration = symbol?.declarations?.[0];
    if (!declaration) return undefined;
    let clause = declaration;
    if (ts.isImportSpecifier(clause)) clause = clause.parent.parent;
    if (ts.isNamespaceImport(clause)) clause = clause.parent;
    if (!ts.isImportClause(clause)) return undefined;
    if (clause.isTypeOnly || declaration.isTypeOnly) return UNKNOWN;
    const module = literal(clause.parent.moduleSpecifier);
    const exported = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : null;
    if (module === 'axios' && (exported === null || exported === 'default')) return namespace(RECEIVERS.get('axios'));
    if (module === 'node:console' || module === 'console') {
      if (exported === null || exported === 'default') return namespace(RECEIVERS.get('console'));
      if (LOG_METHODS.has(exported)) return {kind: 'LOG'};
    }
    return UNKNOWN;
  }

  function read(node, symbol = checker.getSymbolAtLocation(node)) {
    const name = node.text;
    const binding = find('bindings', symbol ?? name);
    if (binding !== undefined) return binding;
    if (field.test(name) && !symbol?.valueDeclaration) return scalar(line(node));
    if (external.has(symbol ?? name)) return external.get(symbol ?? name);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    let data = imported(symbol);
    if (data === undefined && (!symbol || (declaration &&
      (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient)))) {
      if (RECEIVERS.has(name)) data = namespace(RECEIVERS.get(name));
      if (name === 'fetch') data = {kind: 'NETWORK'};
      if (name === 'print') data = {kind: 'LOG'};
      if (name === 'String') data = {serialize: true};
      if (name === 'JSON') data = {keys: new Map([['stringify', {serialize: true}]])};
    }
    data ??= declaration && ts.isFunctionDeclaration(declaration) ? LOCAL : {unknown: true, keys: new Map()};
    external.set(symbol ?? name, data);
    return data;
  }

  function object(node) {
    const keys = new Map();
    let spreadOrigin = null;
    let unknown = false;
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = state(value(property.expression));
        if (spread?.keys) {
          if (spread.unknown) {
            gap('expansões de objetos sem vínculo estático');
            keys.clear();
            unknown = true;
          }
          if (keys.size + spread.keys.size > limit) {
            gap(LIMIT_GAP);
            return UNKNOWN;
          }
          for (const [name, data] of spread.keys) keys.set(name, data);
        } else {
          if (spread?.unknown) {
            gap('expansões de objetos sem vínculo estático');
            keys.clear();
            unknown = true;
          }
          spreadOrigin ??= origin(spread);
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        keys.set(property.name.text, read(property.name, checker.getShorthandAssignmentValueSymbol(property)));
      } else if (ts.isPropertyAssignment(property)) {
        const name = key(property.name);
        const data = value(property.initializer);
        if (name !== null) {
          const input = unwrap(property.initializer);
          const fieldLabel = field.test(name) && ts.isIdentifier(input) && !checker.getSymbolAtLocation(input);
          keys.set(name, fieldLabel && data?.unknown ? scalar(line(property.name)) : data);
        } else {
          gap('chaves de objetos sem vínculo estático');
          keys.clear();
          unknown = true;
        }
      } else if (ts.isMethodDeclaration(property) || ts.isAccessor(property)) {
        const name = key(property.name);
        if (name !== null) keys.set(name, ts.isMethodDeclaration(property) ? LOCAL : UNKNOWN);
        else {
          gap('chaves de objetos sem vínculo estático');
          keys.clear();
          unknown = true;
        }
      }
    }
    return {keys, line: spreadOrigin, unknown};
  }

  function value(input) {
    const node = unwrap(input);
    if (!node) return null;
    if (ts.isIdentifier(node)) return read(node);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = member(node);
      const receiver = state(value(node.expression));
      if (name === null) {
        if (receiver?.items || receiver?.keys?.size) gap('leituras de propriedades sem chave estática');
        return UNKNOWN;
      }
      if (receiver?.keys?.has(name)) return receiver.keys.get(name);
      if (receiver?.items && arrayIndex(name) !== null) return receiver.items[arrayIndex(name)] ?? null;
      if ((!receiver?.keys || receiver.unknown) && field.test(name) && !receiver?.invalidated) {
        return scalar(line(ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression));
      }
      return receiver?.unknown ? UNKNOWN : null;
    }
    if (ts.isTemplateExpression(node)) {
      return scalar(first(node.templateSpans.map(span => value(span.expression))));
    }
    if (ts.isObjectLiteralExpression(node)) return object(node);
    if (ts.isArrayLiteralExpression(node)) {
      const items = [];
      for (const element of node.elements) {
        const item = value(ts.isSpreadElement(element) ? element.expression : element);
        if (ts.isSpreadElement(element)) {
          const expanded = state(item)?.items;
          if (!expanded) {
            gap('expansões de sequências sem vínculo estático');
            return UNKNOWN;
          }
          // Keep alias expansion bounded even if nested spreads multiply the array size.
          if (items.length + expanded.length > limit) {
            gap(LIMIT_GAP);
            return UNKNOWN;
          }
          items.push(...expanded);
        } else {
          items.push(item);
        }
      }
      return {items};
    }
    if (ts.isConditionalExpression(node)) {
      return scalar(origin(value(node.whenTrue)) ?? origin(value(node.whenFalse))) ?? UNKNOWN;
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return value(node.right);
      if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
        return scalar(origin(value(node.left)) ?? origin(value(node.right))) ??
          (node.operatorToken.kind === ts.SyntaxKind.PlusToken ? null : UNKNOWN);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = value(node.expression);
      if (callee?.serialize) return scalar(origin(value(node.arguments[0])));
      if (!callee?.kind && originFromArguments(node.arguments) !== null) gap(UNKNOWN_VALUE);
      return {keys: new Map(), unknown: true};
    }
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isClassExpression(node)) return LOCAL;
    if (ts.isNewExpression(node)) return {keys: new Map(), unknown: true};
    if (node.kind === ts.SyntaxKind.ThisKeyword) return UNKNOWN;
    return null;
  }

  function originFromArguments(args) {
    return first(args.map(arg => {
      const spread = ts.isSpreadElement(arg);
      const data = value(spread ? arg.expression : arg);
      if (spread && !state(data)?.items) {
        gap('argumentos com expansão sem vínculo estático');
        return null;
      }
      return data;
    }));
  }

  function parameters(argument) {
    const data = state(value(argument));
    const slotLimit = 256;
    if (data?.items) return {
      items: Array.from(data.items.slice(0, slotLimit), item => origin(item)),
    };
    if (data?.keys) return {
      keys: Object.fromEntries([...data.keys].slice(0, slotLimit).map(([name, item]) => [name, origin(item)])),
    };
    return null;
  }

  function inspectCall(node, callee) {
    const kind = callee?.kind;
    if (!kind && !callee?.unknown) return;
    const cut = node.arguments.pos + limit;
    const args = node.arguments.filter(argument => argument.end <= cut);
    if (node.end - 1 > cut) gap(LIMIT_GAP);
    if (!kind) {
      if (originFromArguments(args) !== null) gap(UNKNOWN_DESTINATION);
      return;
    }
    const destinationLine = line(node);
    if (kind === 'SQL') {
      sql.push([destinationLine, literal(args[0]), parameters(args[1])]);
      return;
    }
    if (kind === 'STORAGE' && args.slice(0, 2).some(ts.isSpreadElement)) {
      gap('argumentos de armazenamento com expansão');
      return;
    }
    const at = kind === 'STORAGE' ? origin(value(args[1])) : originFromArguments(args);
    if (at !== null) hits.push([destinationLine, kind, at]);
  }

  function arrayIndex(name) {
    return /^(0|[1-9]\d*)$/.test(name) ? Number(name) : null;
  }

  function invalidate(reference) {
    active().objects.set(reference, {keys: new Map(), unknown: true, invalidated: true});
  }

  function invalidateCallArguments(args) {
    for (const node of args) {
      const argument = unwrap(node);
      if (ts.isIdentifier(argument) || ts.isPropertyAccessExpression(argument) || ts.isElementAccessExpression(argument)) {
        const reference = value(argument);
        const data = state(reference);
        if (data?.items || data?.keys?.size || (data?.keys && !data.unknown)) {
          gap(MUTATION);
          invalidate(reference);
        }
      }
    }
  }

  function mutate(target, data, deleting = false) {
    const reference = value(target.expression);
    const current = state(reference);
    const name = member(target);
    const index = current?.items && name !== null ? arrayIndex(name) : null;
    if ((!current?.keys && !current?.items) || name === null ||
      (current?.items && (name === 'length' || (index !== null && index >= limit))) || name === '__proto__') {
      gap(MUTATION);
      if (current?.keys || current?.items) invalidate(reference);
      return;
    }
    let next = active().objects.get(reference);
    if (!next) {
      next = {...current, keys: new Map(current.keys), items: current.items?.slice()};
      active().objects.set(reference, next);
    }
    if (index !== null) {
      if (deleting) delete next.items[index];
      else next.items[index] = data;
    } else if (deleting && !current.unknown) {
      next.keys.delete(name);
    } else {
      next.keys.set(name, deleting ? UNKNOWN : data);
    }
  }

  function bind(target, expression, declaration = false, assigned = undefined) {
    target = unwrap(target);
    let data = assigned !== undefined ? assigned : expression && fits(expression) ? value(expression) : null;
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      mutate(target, data);
      return;
    }
    if (!ts.isIdentifier(target)) {
      gap(DECLARATION);
      return;
    }
    const symbol = checker.getSymbolAtLocation(target) ?? target.text;
    // A named field initialized with a literal remains a field clue, including synthetic CPF fixtures.
    if (declaration && data === null && expression && field.test(target.text) &&
        (ts.isStringLiteralLike(unwrap(expression)) || ts.isNumericLiteral(unwrap(expression)))) {
      data = scalar(line(target));
    }
    active().bindings.set(symbol, data);
    if (!declaration) active().writes.add(symbol);
  }

  function walkBranches(branches) {
    const writes = new Set();
    const objects = new Set();
    for (const node of branches) {
      if (!node) continue;
      frames.push(newFrame());
      walk(node);
      const frame = frames.pop();
      for (const symbol of frame.writes) writes.add(symbol);
      for (const reference of frame.objects.keys()) objects.add(reference);
    }
    if (writes.size || objects.size) gap(BRANCH);
    for (const symbol of writes) {
      active().bindings.set(symbol, UNKNOWN);
      active().writes.add(symbol);
    }
    for (const reference of objects) invalidate(reference);
  }

  function walk(node) {
    if (ts.isTypeNode(node)) return;
    if (ts.isFunctionLike(node) && node.body) {
      // Writes from a function body must not mutate the enclosing analysis.
      frames.push(newFrame());
      for (const parameter of node.parameters) {
        if (parameter.initializer) walk(parameter.initializer);
        // A parameter can override its default. A literal property write still binds within this body.
        bind(parameter.name, null, true, {keys: new Map(), unknown: true});
      }
      walk(node.body);
      frames.pop();
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      if (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) return;
      if (node.initializer) walk(node.initializer);
      bind(node.name, node.initializer, true);
      return;
    }
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      walk(node.expression ?? node.condition);
      walkBranches(ts.isIfStatement(node) ? [node.thenStatement, node.elseStatement] : [node.whenTrue, node.whenFalse]);
      return;
    }
    if (ts.isIterationStatement(node, false) || ts.isTryStatement(node) || ts.isSwitchStatement(node)) {
      const children = [];
      ts.forEachChild(node, child => { children.push(child); });
      walkBranches(children);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      walk(node.left);
      if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken].includes(operator)) {
        walkBranches([node.right]);
      } else {
        walk(node.right);
        if (operator === ts.SyntaxKind.EqualsToken) bind(node.left, node.right);
        else if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) {
          gap(MUTATION);
          bind(node.left, null, false, UNKNOWN);
        }
      }
      return;
    }
    if (ts.isDeleteExpression(node)) {
      walk(node.expression);
      const target = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) mutate(target, null, true);
      return;
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      walk(node.operand);
      gap(MUTATION);
      bind(node.operand, null, false, UNKNOWN);
      return;
    }
    if (ts.isCallExpression(node)) {
      walk(node.expression);
      const callee = value(node.expression);
      for (const argument of node.arguments) walk(argument);
      inspectCall(node, callee);
      if (callee?.unknown) invalidateCallArguments(node.arguments);
      const target = unwrap(node.expression);
      if (!callee && (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
        ARRAY_MUTATORS.has(member(target))) {
        const reference = value(target.expression);
        if (state(reference)?.items) {
          gap(MUTATION);
          invalidate(reference);
        }
      }
      return;
    }
    ts.forEachChild(node, walk);
  }

  walk(file);
  return result();
}

if (ts.version !== VERSION) throw new Error('versão inesperada do parser');
const input = createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const record of input) {
  const arguments_ = JSON.parse(record);
  try {
    process.stdout.write(JSON.stringify(analyze(...arguments_)) + '\n');
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    process.stdout.write(JSON.stringify({hits: [], sql: [], gaps: [['limite estrutural do parser excedido', 1]]}) + '\n');
  }
}
