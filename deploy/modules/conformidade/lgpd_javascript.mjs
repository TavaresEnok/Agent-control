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
const CAPTURE = 'vínculos externos a funções sem ordem de chamada estática';
const EXPRESSION = 'expressões JavaScript/TypeScript fora do rastreamento';
const LOG_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'exception']);
const HTTP_METHODS = new Set(['post', 'put', 'patch', 'request']);
const SQL_METHODS = new Set(['query', 'execute']);
const RECEIVERS = new Map([
  ...['logger', 'logging', 'console', 'log'].map(name => [name, ['LOG', LOG_METHODS]]),
  ...['axios', 'requests', 'httpx', 'httpxClient'].map(name => [name, ['NETWORK', HTTP_METHODS]]),
  ...['db', 'pool', 'client', 'connection', 'conn', 'cursor'].map(name => [name, ['SQL', SQL_METHODS]]),
  ['localStorage', ['STORAGE', new Set(['setItem'])]],
]);
const UNKNOWN = {unknown: true};
const CAPTURED = {unknown: true, invalidated: true};
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

function isLogical(operator) {
  return operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken ||
    operator === ts.SyntaxKind.AmpersandAmpersandToken;
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
  const modules = new Map();
  const bodies = [];
  const callables = new WeakMap();
  let inFunction = false;
  const find = (table, key) => {
    for (let index = frames.length - 1; index >= (inFunction ? 1 : 0); index--) {
      if (frames[index][table].has(key)) return frames[index][table].get(key);
    }
    return undefined;
  };
  const active = () => frames[frames.length - 1];
  const state = (data) => {
    const current = find('objects', data);
    if (current) return current;
    if (inFunction && frames[0].objects.has(data)) {
      gap(CAPTURE);
      return CAPTURED;
    }
    return data;
  };
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

  function moduleObject(name, namespaceImport) {
    if (!modules.has(name)) {
      const receiver = namespace(RECEIVERS.get(name === 'axios' ? 'axios' : 'console'));
      modules.set(name, {receiver, namespace: {keys: new Map([...receiver.keys, ['default', receiver]])}});
    }
    const entry = modules.get(name);
    return namespaceImport ? entry.namespace : entry.receiver;
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
    const namespaceImport = ts.isNamespaceImport(declaration);
    if (module === 'axios' && (exported === null || exported === 'default')) return moduleObject(module, namespaceImport);
    if (module === 'node:console' || module === 'console') {
      if (exported === null || exported === 'default') return moduleObject('console', namespaceImport);
      if (LOG_METHODS.has(exported)) return {kind: 'LOG'};
    }
    return UNKNOWN;
  }

  function read(node, symbol = checker.getSymbolAtLocation(node)) {
    const name = node.text;
    const binding = find('bindings', symbol ?? name);
    if (binding !== undefined) return binding;
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    const ambient = declaration && (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient);
    if (inFunction && declaration && ts.isVariableDeclaration(declaration) &&
      (declaration.parent.flags & ts.NodeFlags.Const) && frames[0].bindings.has(symbol)) {
      const constant = frames[0].bindings.get(symbol);
      if (!constant?.keys && !constant?.items && !constant?.unknown) return constant;
    }
    if (inFunction && (frames[0].bindings.has(symbol ?? name) ||
      (declaration && !ambient && ts.findAncestor(declaration.parent, ts.isFunctionLike) !== inFunction))) {
      gap(CAPTURE);
      return CAPTURED;
    }
    if (field.test(name) && !symbol?.valueDeclaration) return scalar(line(node));
    if (external.has(symbol ?? name)) return external.get(symbol ?? name);
    let data = imported(symbol);
    if (data === undefined && (!symbol || ambient)) {
      if (RECEIVERS.has(name)) data = namespace(RECEIVERS.get(name));
      if (name === 'fetch') data = {kind: 'NETWORK'};
      if (name === 'print') data = {kind: 'LOG'};
      if (name === 'String') data = {serialize: true};
      if (name === 'JSON') data = {keys: new Map([['stringify', {serialize: true}]])};
    }
    data ??= declaration && ts.isFunctionDeclaration(declaration) ? callable(declaration) : {unknown: true, keys: new Map()};
    external.set(symbol ?? name, data);
    return data;
  }

  function functionOwner(symbol) {
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    return declaration && ts.findAncestor(declaration.parent, ts.isFunctionLike) || undefined;
  }

  function assignmentTargets(input) {
    const node = unwrap(input);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(assignmentTargets);
    if (ts.isObjectLiteralExpression(node)) return node.properties.flatMap(assignmentTargets);
    if (ts.isArrayBindingPattern(node) || ts.isObjectBindingPattern(node)) return node.elements.flatMap(assignmentTargets);
    if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return assignmentTargets(node.expression);
    if (ts.isPropertyAssignment(node)) return assignmentTargets(node.initializer);
    if (ts.isBindingElement(node) || ts.isShorthandPropertyAssignment(node)) return assignmentTargets(node.name);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return assignmentTargets(node.left);
    }
    return ts.isIdentifier(node) || isProperty(node) ? [node] : [];
  }

  function callable(node) {
    if (!node.body || (ts.isBlock(node.body) && !node.body.statements.length &&
      node.parameters.every(parameter => ts.isIdentifier(parameter.name) && !parameter.initializer))) return LOCAL;
    if (callables.has(node)) return callables.get(node);

    const writes = new Set();
    const receivers = new Set();
    const calls = [];
    const aliases = new Map();
    let unresolved = false;
    function recordAlias(target, expression) {
      const symbol = ts.isIdentifier(target) && checker.getSymbolAtLocation(target);
      if (!symbol || functionOwner(symbol) !== node) return;
      if (!aliases.has(symbol)) aliases.set(symbol, []);
      aliases.get(symbol).push(expression);
    }
    function record(input) {
      for (const target of assignmentTargets(input)) {
        let root = target;
        while (isProperty(root)) root = unwrap(root.expression);
        if (!ts.isIdentifier(root)) {
          if (root.kind !== ts.SyntaxKind.ThisKeyword) unresolved = true;
          continue;
        }
        const symbol = ts.isShorthandPropertyAssignment(root.parent) ?
          checker.getShorthandAssignmentValueSymbol(root.parent) : checker.getSymbolAtLocation(root);
        if (root === target) {
          if (functionOwner(symbol) !== node) writes.add(symbol ?? root.text);
        } else receivers.add(root);
      }
    }
    function summarize(child) {
      if (ts.isFunctionLike(child) || ts.isClassLike(child) || ts.isTypeNode(child)) return;
      if (ts.isVariableDeclaration(child) && child.initializer) recordAlias(child.name, child.initializer);
      if (ts.isBinaryExpression(child) && child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        child.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        record(child.left);
        if (child.operatorToken.kind === ts.SyntaxKind.EqualsToken) recordAlias(unwrap(child.left), child.right);
      }
      if (ts.isDeleteExpression(child)) record(child.expression);
      if ((ts.isPrefixUnaryExpression(child) || ts.isPostfixUnaryExpression(child)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(child.operator)) record(child.operand);
      if ((ts.isForOfStatement(child) || ts.isForInStatement(child)) &&
        !ts.isVariableDeclarationList(child.initializer)) record(child.initializer);
      if (ts.isCallExpression(child)) {
        const target = unwrap(child.expression);
        const root = isProperty(target) ? unwrap(target.expression) : target;
        calls.push({target, root, args: child.arguments});
      }
      ts.forEachChild(child, summarize);
    }
    for (const parameter of node.parameters) {
      if (parameter.initializer) summarize(parameter.initializer);
    }
    summarize(node.body);
    const data = {opaqueEffects: true, effects: {writes, receivers, calls, aliases, unresolved}};
    callables.set(node, data);
    return data;
  }

  function applyEffects(callee) {
    const visited = new Set();
    const writes = new Set();
    const receivers = new Set();
    const visible = (symbol) => {
      const owner = functionOwner(symbol);
      return !owner || owner === inFunction;
    };
    // Follow possible local aliases without replaying assignments or picking a branch.
    function visitRoot(input, onReference, onCallable, seen = new Set()) {
      const root = unwrap(input);
      if (ts.isConditionalExpression(root)) {
        visitRoot(root.whenTrue, onReference, onCallable, seen);
        visitRoot(root.whenFalse, onReference, onCallable, seen);
      } else if (ts.isBinaryExpression(root) && isLogical(root.operatorToken.kind)) {
        visitRoot(root.left, onReference, onCallable, seen);
        visitRoot(root.right, onReference, onCallable, seen);
      } else if (isProperty(root)) {
        visitRoot(root.expression, onReference, undefined, seen);
      } else if (ts.isIdentifier(root)) {
        const symbol = checker.getSymbolAtLocation(root) ?? root.text;
        if (visible(symbol)) {
          onReference(read(root), root);
        } else if (!seen.has(symbol)) {
          seen.add(symbol);
          const declaration = symbol.valueDeclaration;
          if (onCallable && declaration && ts.isFunctionDeclaration(declaration)) onCallable(callable(declaration));
          const aliases = callable(functionOwner(symbol)).effects?.aliases.get(symbol) ?? [];
          for (const alias of aliases) visitRoot(alias, onReference, onCallable, seen);
        }
      } else if (onCallable && (ts.isFunctionExpression(root) || ts.isArrowFunction(root))) {
        onCallable(callable(root));
      }
    }
    const affect = (reference) => receivers.add(reference);
    function collect(data) {
      if (!data?.effects || visited.has(data)) return;
      visited.add(data);
      if (data.effects.unresolved) gap(CAPTURE);
      for (const symbol of data.effects.writes) {
        if (visible(symbol)) writes.add(symbol);
      }
      for (const root of data.effects.receivers) visitRoot(root, affect);
      for (const {target, root, args} of data.effects.calls) {
        let resolved = false;
        let opaque = false;
        const visitCallee = (value) => {
          collect(value);
          resolved ||= Boolean(value);
          opaque ||= Boolean(value?.unknown || value?.opaqueEffects);
        };
        if (isProperty(target)) {
          // A local alias can point to any of its candidate receivers.
          visitRoot(root, (reference, identifier) => {
            if (identifier !== root) {
              affect(reference);
              return;
            }
            const property = {reference, name: member(target)};
            const method = readProperty(target, property);
            if (receiverMayChange(identifier, property, method)) affect(reference);
            visitCallee(method);
          });
        } else {
          visitRoot(root, visitCallee, visitCallee);
        }
        if (!resolved || opaque) {
          const visitArgument = (reference) => {
            affect(reference);
            collect(reference);
          };
          for (const arg of args) {
            const input = unwrap(ts.isSpreadElement(arg) ? arg.expression : arg);
            if (ts.isIdentifier(input)) visitRoot(input, visitArgument, collect);
          }
        }
      }
    }
    collect(callee);
    const seen = new Set();
    for (const reference of receivers) invalidateArgument(reference, seen);
    for (const symbol of writes) {
      gap(CAPTURE);
      active().bindings.set(symbol, CAPTURED);
      active().writes.add(symbol);
    }
  }

  function object(node) {
    const keys = new Map();
    let spreadOrigin = null;
    let unknown = false;
    for (const [index, property] of node.properties.entries()) {
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
            for (const rest of node.properties.slice(index + 1)) walk(rest);
            return CAPTURED;
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
        if (ts.isComputedPropertyName(property.name)) value(property.name.expression);
        const name = key(property.name);
        const data = value(property.initializer);
        if (name !== null) {
          const input = unwrap(property.initializer);
          const fieldLabel = field.test(name) && ts.isIdentifier(input) && !checker.getSymbolAtLocation(input);
          keys.set(name, fieldLabel && data?.unknown && !data.invalidated ? scalar(line(property.name)) : data);
        } else {
          gap('chaves de objetos sem vínculo estático');
          keys.clear();
          unknown = true;
        }
      } else if (ts.isMethodDeclaration(property) || ts.isAccessor(property)) {
        if (ts.isComputedPropertyName(property.name)) value(property.name.expression);
        if (property.body) bodies.push(property);
        const name = key(property.name);
        if (name !== null) keys.set(name, ts.isMethodDeclaration(property) ? callable(property) : UNKNOWN);
        else {
          gap('chaves de objetos sem vínculo estático');
          keys.clear();
          unknown = true;
        }
      }
    }
    return {keys, line: spreadOrigin, unknown, invalidated: unknown};
  }

  function value(input, used = true) {
    const node = unwrap(input);
    if (!node) return null;
    if (ts.isIdentifier(node)) return read(node);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return readProperty(node, propertyReference(node));
    }
    if (ts.isTemplateExpression(node)) {
      const origins = node.templateSpans.map(span => origin(value(span.expression)));
      return scalar(origins.find(at => at !== null) ?? null);
    }
    if (ts.isObjectLiteralExpression(node)) return object(node);
    if (ts.isArrayLiteralExpression(node)) {
      const items = [];
      for (const [index, element] of node.elements.entries()) {
        const item = value(ts.isSpreadElement(element) ? element.expression : element);
        if (ts.isSpreadElement(element)) {
          const expanded = state(item)?.items;
          if (!expanded) {
            gap('expansões de sequências sem vínculo estático');
            for (const rest of node.elements.slice(index + 1)) walk(rest);
            return CAPTURED;
          }
          // Keep alias expansion bounded even if nested spreads multiply the array size.
          if (items.length + expanded.length > limit) {
            gap(LIMIT_GAP);
            for (const rest of node.elements.slice(index + 1)) walk(rest);
            return CAPTURED;
          }
          items.push(...expanded);
        } else {
          items.push(item);
        }
      }
      return {items};
    }
    if (ts.isConditionalExpression(node)) {
      value(node.condition);
      const [yes, no] = walkBranches([() => branchValue(value(node.whenTrue)), () => branchValue(value(node.whenFalse))]);
      return joinValues(yes, no);
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) {
        const target = unwrap(node.left);
        const reference = isProperty(target) ? propertyReference(target) : null;
        if (operator === ts.SyntaxKind.EqualsToken) {
          const data = value(node.right);
          bind(target, reference, fits(node.right) ? data : CAPTURED);
          return data;
        }
        gap(MUTATION);
        const assign = () => {
          value(node.right);
          bind(target, reference, CAPTURED);
        };
        if ([ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
          ts.SyntaxKind.QuestionQuestionEqualsToken].includes(operator)) walkBranches([assign]);
        else assign();
        return CAPTURED;
      }
      const left = value(node.left);
      if (isLogical(operator)) {
        const before = branchValue(left);
        const [right] = walkBranches([() => branchValue(value(node.right))]);
        return joinValues(before, right);
      }
      if (operator === ts.SyntaxKind.PlusToken) {
        const at = origin(left);
        const right = origin(value(node.right));
        return scalar(at ?? right);
      }
      const at = origin(left);
      const right = value(node.right);
      if (operator === ts.SyntaxKind.CommaToken) return right;
      if (used && (at !== null || origin(right) !== null || left?.invalidated || right?.invalidated)) gap(EXPRESSION);
      return CAPTURED;
    }
    if (ts.isCallExpression(node)) return call(node, used);
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      bodies.push(node);
      return callable(node);
    }
    if (ts.isDeleteExpression(node)) {
      const target = unwrap(node.expression);
      if (isProperty(target)) mutate(propertyReference(target), null, true);
      else value(target);
      return null;
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      const target = unwrap(node.operand);
      gap(MUTATION);
      bind(target, isProperty(target) ? propertyReference(target) : null, CAPTURED);
      return CAPTURED;
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) return UNKNOWN;
    if (ts.isLiteralExpression(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword,
      ts.SyntaxKind.NullKeyword, ts.SyntaxKind.OmittedExpression].includes(node.kind)) return null;
    if (ts.isPrefixUnaryExpression(node) && ts.isLiteralExpression(unwrap(node.operand))) return null;
    if (ts.isVoidExpression(node)) {
      walk(node.expression);
      return null;
    }
    // An untracked expression can contain writes, but their execution order is unknown here.
    walkBranches([() => ts.forEachChild(node, walk)]);
    if (ts.isClassExpression(node)) return LOCAL;
    if (used) gap(EXPRESSION);
    return ts.isNewExpression(node) ? {keys: new Map(), unknown: true, invalidated: true} : CAPTURED;
  }

  function isProperty(node) {
    return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
  }

  function branchValue(reference) {
    const data = state(reference);
    return {at: origin(data), invalidated: data?.invalidated};
  }

  function joinValues(left, right) {
    if (left.invalidated || right.invalidated) return CAPTURED;
    return scalar(left.at ?? right.at) ?? CAPTURED;
  }

  function propertyReference(node) {
    const reference = value(node.expression);
    if (ts.isElementAccessExpression(node)) value(node.argumentExpression);
    return {reference, name: member(node)};
  }

  function readProperty(node, {reference, name}) {
    const receiver = state(reference);
    if (name === null) {
      if (receiver?.items || receiver?.keys?.size) gap('leituras de propriedades sem chave estática');
      return receiver?.invalidated ? CAPTURED : UNKNOWN;
    }
    if (receiver?.keys?.has(name)) return receiver.keys.get(name);
    if (receiver?.items && arrayIndex(name) !== null) return receiver.items[arrayIndex(name)] ?? null;
    if (field.test(name) && receiver?.unknown) {
      if (!receiver.invalidated) return scalar(line(ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression));
      gap(EXPRESSION);
    }
    return receiver?.invalidated ? CAPTURED : receiver?.unknown ? UNKNOWN : null;
  }

  function originFromArguments(args) {
    return first(args.map(({spread, data}) => {
      if (spread && !data) gap('argumentos com expansão sem vínculo estático');
      return data;
    }));
  }

  function parameters(argument) {
    const data = state(argument);
    const slotLimit = 256;
    if (data?.items) return {
      items: Array.from(data.items.slice(0, slotLimit), item => origin(item)),
    };
    if (data?.keys) return {
      keys: Object.fromEntries([...data.keys].slice(0, slotLimit).map(([name, item]) => [name, origin(item)])),
    };
    return null;
  }

  function inspectCall(node, callee, args, indirectOrigin) {
    const kind = callee?.kind;
    if (!kind && !callee?.unknown) return;
    if (!kind) {
      if (indirectOrigin !== null) gap(UNKNOWN_DESTINATION);
      return;
    }
    const destinationLine = line(node);
    if (kind === 'SQL') {
      sql.push([destinationLine, literal(args[0]?.node), args[1]?.spread ? null : parameters(args[1]?.data)]);
      return;
    }
    if (kind === 'STORAGE' && args.slice(0, 2).some(argument => argument.spread)) {
      gap('argumentos de armazenamento com expansão');
      return;
    }
    const at = kind === 'STORAGE' ? origin(args[1]?.data) : originFromArguments(args);
    if (at !== null) hits.push([destinationLine, kind, at]);
  }

  function receiverMayChange(node, {reference, name}, callee, args = []) {
    if (callee && !callee.unknown && !callee.opaqueEffects) return false;
    const receiver = state(reference);
    if (receiver?.items) {
      // A plain array of untracked literals has no callbacks during join with a literal separator.
      const simpleJoin = !callee && name === 'join' && !receiver.items.some(item => item != null) &&
        args.every(({node, spread}) => !spread && literal(node) !== null);
      return !simpleJoin;
    }
    const tracked = !ts.isIdentifier(node) || find('bindings', checker.getSymbolAtLocation(node) ?? node.text) !== undefined;
    return receiver?.keys && (receiver.keys.size || (tracked && !receiver.invalidated));
  }

  function call(node, used) {
    const target = unwrap(node.expression);
    const property = isProperty(target) ? propertyReference(target) : null;
    const callee = property ? readProperty(target, property) : value(target);
    const cut = node.arguments.pos + limit;
    const args = node.arguments.map(argument => {
      const spread = ts.isSpreadElement(argument);
      const reference = value(spread ? argument.expression : argument);
      // A spread reads the slots immediately. A normal object argument retains its identity.
      const items = spread ? state(reference)?.items : null;
      return {node: argument, spread, data: spread ? items && {items: items.slice()} : reference};
    });
    const bounded = args.filter(argument => argument.node.end <= cut);
    if (node.end - 1 > cut && (callee?.kind || callee?.unknown || callee?.serialize)) gap(LIMIT_GAP);
    const indirectOrigin = !callee?.kind && !callee?.serialize && (used || callee?.unknown) ?
      originFromArguments(bounded) : null;
    inspectCall(node, callee, bounded, indirectOrigin);

    if (callee?.serialize) {
      const firstArg = bounded[0];
      // With a spread, an empty or unknown sequence makes the first position ambiguous.
      if (firstArg?.spread && !firstArg.data?.items?.length) gap('argumentos com expansão sem vínculo estático');
      return scalar(origin(firstArg?.spread ? firstArg.data?.items?.[0] : firstArg?.data));
    }
    const uncertain = used && !callee?.kind && (indirectOrigin !== null ||
      (property !== null && origin(property.reference) !== null));
    if (uncertain) gap(UNKNOWN_VALUE);
    if (callee?.effects) applyEffects(callee);
    const seen = new Set();
    if (callee?.unknown || callee?.opaqueEffects) {
      for (const {spread, data} of args) {
        if (spread) {
          for (const item of data?.items ?? []) invalidateArgument(item, seen);
        } else invalidateArgument(data, seen);
      }
    }
    const changesReceiver = property && receiverMayChange(unwrap(target.expression), property, callee, args);
    if (changesReceiver) {
      invalidateArgument(property.reference, seen);
    }
    return {keys: new Map(), unknown: true, invalidated: true};
  }

  function arrayIndex(name) {
    return /^(0|[1-9]\d*)$/.test(name) ? Number(name) : null;
  }

  function invalidate(reference) {
    active().objects.set(reference, {keys: new Map(), unknown: true, invalidated: true});
  }

  function invalidateArgument(reference, seen = new Set()) {
    if (!reference || seen.has(reference)) return;
    seen.add(reference);
    const data = state(reference);
    if (data?.items || (data?.keys && (data.keys.size || !data.invalidated))) {
      gap(MUTATION);
      invalidate(reference);
      for (const item of data.items ?? []) invalidateArgument(item, seen);
      for (const item of data.keys?.values() ?? []) invalidateArgument(item, seen);
    }
  }

  function mutate({reference, name}, data, deleting = false) {
    const current = state(reference);
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
      next.keys.set(name, deleting ? CAPTURED : data);
    }
  }

  function bind(target, property, data, declaration = false, expression = null) {
    if (property) {
      mutate(property, data);
      return;
    }
    if (!ts.isIdentifier(target)) {
      gap(DECLARATION);
      for (const item of assignmentTargets(target)) {
        bind(item, isProperty(item) ? propertyReference(item) : null, CAPTURED, declaration);
      }
      return;
    }
    const symbol = (ts.isShorthandPropertyAssignment(target.parent) ?
      checker.getShorthandAssignmentValueSymbol(target.parent) : checker.getSymbolAtLocation(target)) ?? target.text;
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
    const values = branches.map(visit => {
      frames.push(newFrame());
      const data = visit();
      const frame = frames.pop();
      for (const symbol of frame.writes) writes.add(symbol);
      for (const reference of frame.objects.keys()) objects.add(reference);
      return data;
    });
    if (writes.size || objects.size) gap(BRANCH);
    for (const symbol of writes) {
      active().bindings.set(symbol, CAPTURED);
      active().writes.add(symbol);
    }
    for (const reference of objects) invalidate(reference);
    return values;
  }

  function walk(node) {
    if (!node || ts.isTypeNode(node)) return;
    if (ts.isFunctionLike(node) && node.body) {
      bodies.push(node);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      if (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) return;
      const data = value(node.initializer);
      bind(node.name, null, !node.initializer || fits(node.initializer) ? data : CAPTURED, true, node.initializer);
      if (node.initializer && !(node.parent.flags & ts.NodeFlags.BlockScoped)) {
        for (const item of assignmentTargets(node.name)) {
          active().writes.add(checker.getSymbolAtLocation(item) ?? item.text);
        }
      }
      return;
    }
    if (ts.isIfStatement(node)) {
      value(node.expression);
      walkBranches([() => walk(node.thenStatement), () => walk(node.elseStatement)]);
      return;
    }
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const iterable = value(node.expression);
      walkBranches([() => {
        const target = unwrap(node.initializer);
        if (ts.isVariableDeclarationList(target)) {
          const lexical = Boolean(target.flags & ts.NodeFlags.BlockScoped);
          if (lexical && ts.isForOfStatement(node) && origin(iterable) !== null) gap(BRANCH);
          for (const declaration of target.declarations) bind(declaration.name, null, CAPTURED, lexical);
        } else {
          bind(target, isProperty(target) ? propertyReference(target) : null, CAPTURED);
        }
        walk(node.statement);
      }]);
      return;
    }
    if (ts.isIterationStatement(node, false) || ts.isTryStatement(node) || ts.isSwitchStatement(node)) {
      const branches = [];
      ts.forEachChild(node, child => { branches.push(() => walk(child)); });
      walkBranches(branches);
      return;
    }
    if (ts.isExpressionNode(node)) value(node, false);
    else ts.forEachChild(node, walk);
  }

  walk(file);
  // Visit bodies for local findings without applying their writes at declaration or guessing when they run.
  for (const body of bodies) {
    inFunction = body;
    frames.push(newFrame());
    for (const parameter of body.parameters) {
      if (parameter.initializer) value(parameter.initializer);
      bind(parameter.name, null, {keys: new Map(), unknown: true}, true);
    }
    walk(body.body);
    frames.pop();
  }
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
