'use strict';

const fs = require('node:fs');

function recordMatch(entry) {
  const reportFile = process.env.AC_JSCODESHIFT_REPORT;
  if (reportFile) {
    fs.appendFileSync(reportFile, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

function isNumericLiteral(node) {
  return (
    (node && node.type === 'NumericLiteral') ||
    (node && node.type === 'Literal' && typeof node.value === 'number')
  );
}

module.exports = function transformer(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);
  let changed = false;

  // 1. new Buffer(...) -> Buffer.alloc(...) or Buffer.from(...)
  root
    .find(j.NewExpression, {
      callee: { type: 'Identifier', name: 'Buffer' },
    })
    .forEach(path => {
      const args = path.value.arguments || [];
      if (args.length === 0) return;
      const line = path.value.loc ? path.value.loc.start.line : 1;
      const before = j(path).toSource();
      const method = args.length === 1 && isNumericLiteral(args[0]) ? 'alloc' : 'from';
      const replacement = j.callExpression(
        j.memberExpression(j.identifier('Buffer'), j.identifier(method)),
        args
      );
      j(path).replaceWith(replacement);
      const after = j(replacement).toSource();
      changed = true;
      recordMatch({
        file: fileInfo.path,
        line,
        rule: 'JSCODESHIFT-NODE-BUFFER-CTOR',
        severity: 'alta',
        message: `new Buffer() está obsoleto/removido; substitua por Buffer.${method}()`,
        before,
        after,
      });
    });

  // 2. Buffer.SlowBuffer(size) -> Buffer.allocUnsafeSlow(size)
  root
    .find(j.NewExpression, {
      callee: {
        type: 'MemberExpression',
        object: { type: 'Identifier', name: 'Buffer' },
        property: { type: 'Identifier', name: 'SlowBuffer' },
      },
    })
    .forEach(path => {
      const args = path.value.arguments || [];
      if (args.length === 0) return;
      const line = path.value.loc ? path.value.loc.start.line : 1;
      const before = j(path).toSource();
      const replacement = j.callExpression(
        j.memberExpression(j.identifier('Buffer'), j.identifier('allocUnsafeSlow')),
        args
      );
      j(path).replaceWith(replacement);
      const after = j(replacement).toSource();
      changed = true;
      recordMatch({
        file: fileInfo.path,
        line,
        rule: 'JSCODESHIFT-NODE-SLOW-BUFFER',
        severity: 'alta',
        message: 'new Buffer.SlowBuffer() está obsoleto; substitua por Buffer.allocUnsafeSlow()',
        before,
        after,
      });
    });

  // 3. url.parse(input) -> new URL(input)
  root
    .find(j.CallExpression, {
      callee: {
        type: 'MemberExpression',
        object: { type: 'Identifier', name: 'url' },
        property: { type: 'Identifier', name: 'parse' },
      },
    })
    .forEach(path => {
      const args = path.value.arguments || [];
      if (args.length !== 1) return;
      const line = path.value.loc ? path.value.loc.start.line : 1;
      const before = j(path).toSource();
      const replacement = j.newExpression(j.identifier('URL'), [args[0]]);
      j(path).replaceWith(replacement);
      const after = j(replacement).toSource();
      changed = true;
      recordMatch({
        file: fileInfo.path,
        line,
        rule: 'JSCODESHIFT-NODE-URL-PARSE',
        severity: 'media',
        message: 'url.parse() está obsoleto (DEP0169); substitua por new URL()',
        before,
        after,
      });
    });

  // 4. util.isArray(x) -> Array.isArray(x)
  root
    .find(j.CallExpression, {
      callee: {
        type: 'MemberExpression',
        object: { type: 'Identifier', name: 'util' },
        property: { type: 'Identifier', name: 'isArray' },
      },
    })
    .forEach(path => {
      const args = path.value.arguments || [];
      if (args.length !== 1) return;
      const line = path.value.loc ? path.value.loc.start.line : 1;
      const before = j(path).toSource();
      const replacement = j.callExpression(
        j.memberExpression(j.identifier('Array'), j.identifier('isArray')),
        [args[0]]
      );
      j(path).replaceWith(replacement);
      const after = j(replacement).toSource();
      changed = true;
      recordMatch({
        file: fileInfo.path,
        line,
        rule: 'JSCODESHIFT-NODE-UTIL-ISARRAY',
        severity: 'alta',
        message: 'util.isArray() foi removido em versões atuais do Node; substitua por Array.isArray()',
        before,
        after,
      });
    });

  return changed ? root.toSource() : null;
};
