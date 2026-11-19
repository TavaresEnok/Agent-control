import {createInterface} from 'node:readline';
import ts from 'typescript';

const VERSION = '5.9.3';
const SYNTAX = 'arquivos com sintaxe não analisável';
const LIMIT_GAP = 'leituras de expressão incompletas (limite)';
const DECLARATION = 'declaradores fora do rastreamento';
const UNKNOWN_VALUE = 'resultados de chamadas indiretas com possível origem';
const LOG_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'exception']);
const HTTP_METHODS = new Set(['post', 'put', 'patch', 'request']);
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

function destination(node) {
  if (ts.isIdentifier(node)) {
    if (node.text === 'fetch') return 'NETWORK';
    if (node.text === 'print') return 'LOG';
    return null;
  }
  const method = member(node);
  if (method === 'query' || method === 'execute') return 'SQL';
  const receiver = node.expression && unwrap(node.expression);
  if (!receiver || !ts.isIdentifier(receiver)) return null;
  if (['logger', 'logging', 'console', 'log'].includes(receiver.text) && LOG_METHODS.has(method)) return 'LOG';
  if (['axios', 'requests', 'httpx', 'httpxClient'].includes(receiver.text) && HTTP_METHODS.has(method)) return 'NETWORK';
  if (receiver.text === 'localStorage' && method === 'setItem') return 'STORAGE';
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
  const origin = (value) => value?.line ?? null;
  const scalar = (at) => at === null ? null : {line: at};
  const first = (values) => {
    for (const value of values) {
      if (origin(value) !== null) return origin(value);
    }
    return null;
  };
  let frames = [new Map()];
  const find = (symbol) => {
    for (let index = frames.length - 1; index >= 0; index--) {
      if (frames[index].has(symbol)) return frames[index].get(symbol);
    }
    return undefined;
  };
  const active = () => frames[frames.length - 1];
  const fits = (node) => {
    if (node.end - node.getStart(file) <= limit) return true;
    gap(LIMIT_GAP);
    return false;
  };

  function read(node, symbol = checker.getSymbolAtLocation(node)) {
    const value = symbol && find(symbol);
    if (value !== undefined) return value;
    if (symbol?.valueDeclaration && ts.isParameter(symbol.valueDeclaration)) return null;
    return field.test(node.text) ? scalar(line(node)) : null;
  }

  function object(node) {
    const keys = new Map();
    let spreadOrigin = null;
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = value(property.expression);
        if (spread?.keys) {
          if (keys.size + spread.keys.size > limit) {
            gap(LIMIT_GAP);
            return {unknown: true};
          }
          for (const [name, data] of spread.keys) keys.set(name, data);
        } else {
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
          keys.set(name, data ?? (fieldLabel ? scalar(line(property.name)) : null));
        } else {
          spreadOrigin ??= origin(data);
        }
      }
    }
    return {keys, line: first(keys.values()) ?? spreadOrigin};
  }

  function value(input) {
    const node = unwrap(input);
    if (!node) return null;
    if (ts.isIdentifier(node)) return read(node);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = member(node);
      if (name === null) return null;
      const receiver = value(node.expression);
      if (receiver?.keys?.has(name)) return receiver.keys.get(name);
      if (receiver?.items && /^\d+$/.test(name)) return receiver.items[Number(name)] ?? null;
      return field.test(name) ? scalar(line(ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression)) : null;
    }
    if (ts.isTemplateExpression(node)) {
      return scalar(first(node.templateSpans.map(span => value(span.expression))));
    }
    if (ts.isObjectLiteralExpression(node)) return object(node);
    if (ts.isArrayLiteralExpression(node)) {
      const items = [];
      for (const element of node.elements) {
        const item = value(ts.isSpreadElement(element) ? element.expression : element);
        if (ts.isSpreadElement(element) && !item?.items) return {unknown: true};
        if (ts.isSpreadElement(element)) {
          // Keep alias expansion bounded even if nested spreads multiply the array size.
          if (items.length + item.items.length > limit) {
            gap(LIMIT_GAP);
            return {unknown: true};
          }
          items.push(...item.items);
        } else {
          items.push(item);
        }
      }
      return {items, line: first(items)};
    }
    if (ts.isConditionalExpression(node)) {
      return scalar(origin(value(node.whenTrue)) ?? origin(value(node.whenFalse)));
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return value(node.right);
      if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
        return scalar(origin(value(node.left)) ?? origin(value(node.right)));
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const stringConversion = ts.isIdentifier(callee) && callee.text === 'String';
      const serialize = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'JSON' && callee.name.text === 'stringify';
      if (stringConversion || serialize) return scalar(origin(value(node.arguments[0])));
      if (!destination(callee) && originFromArguments(node.arguments) !== null) gap(UNKNOWN_VALUE);
      return {unknown: true};
    }
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return {callable: true};
    return null;
  }

  function originFromArguments(args) {
    return first(args.map(arg => value(ts.isSpreadElement(arg) ? arg.expression : arg)));
  }

  function parameters(argument) {
    const data = value(argument);
    const slotLimit = 256;
    if (data?.items) return {
      items: data.items.slice(0, slotLimit).map(origin),
    };
    if (data?.keys) return {
      keys: Object.fromEntries([...data.keys].slice(0, slotLimit).map(([name, item]) => [name, origin(item)])),
    };
    return null;
  }

  function inspectCall(node) {
    const kind = destination(unwrap(node.expression));
    if (kind === null) return;
    const cut = node.arguments.pos + limit;
    const args = node.arguments.filter(argument => argument.end <= cut);
    if (node.end - 1 > cut) gap(LIMIT_GAP);
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

  function bind(target, expression, declaration = false) {
    if (!ts.isIdentifier(target)) {
      if (declaration) gap(DECLARATION);
      return;
    }
    const symbol = checker.getSymbolAtLocation(target);
    if (!symbol) return;
    let data = expression && fits(expression) ? value(expression) : null;
    // A named field initialized with a literal remains a field clue, including synthetic CPF fixtures.
    if (declaration && data === null && expression && field.test(target.text) &&
        (ts.isStringLiteralLike(unwrap(expression)) || ts.isNumericLiteral(unwrap(expression)))) {
      data = scalar(line(target));
    }
    active().set(symbol, data);
  }

  function walk(node) {
    if (ts.isTypeNode(node)) return;
    if (ts.isFunctionLike(node) && node.body) {
      // Writes from a function body must not mutate the enclosing analysis.
      frames.push(new Map());
      for (const parameter of node.parameters) {
        if (parameter.initializer) walk(parameter.initializer);
        bind(parameter.name, parameter.initializer, true);
      }
      walk(node.body);
      frames.pop();
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) walk(node.initializer);
      bind(node.name, node.initializer, true);
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      walk(node.left);
      walk(node.right);
      bind(node.left, node.right);
      return;
    }
    if (ts.isCallExpression(node)) inspectCall(node);
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
