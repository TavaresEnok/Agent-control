'use strict';

const fs = require('node:fs');

// These patterns depend on bindings, argument types or API semantics. Report them
// for review without changing the source or promising an equivalent rewrite.
module.exports = function transformer(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);
  const checks = [
    [j.NewExpression, {callee: {type: 'Identifier', name: 'Buffer'}}, 'JSCODESHIFT-NODE-BUFFER-CTOR'],
    [j.NewExpression, {callee: {type: 'MemberExpression', object: {type: 'Identifier', name: 'Buffer'}, property: {type: 'Identifier', name: 'SlowBuffer'}}}, 'JSCODESHIFT-NODE-SLOW-BUFFER'],
    [j.CallExpression, {callee: {type: 'MemberExpression', object: {type: 'Identifier', name: 'url'}, property: {type: 'Identifier', name: 'parse'}}}, 'JSCODESHIFT-NODE-URL-PARSE'],
    [j.CallExpression, {callee: {type: 'MemberExpression', object: {type: 'Identifier', name: 'util'}, property: {type: 'Identifier', name: 'isArray'}}}, 'JSCODESHIFT-NODE-UTIL-ISARRAY'],
  ];
  for (const [type, pattern, rule] of checks) {
    root.find(type, pattern).forEach(path => {
      if (!process.env.AC_JSCODESHIFT_REPORT) return;
      const report = process.env.AC_JSCODESHIFT_REPORT;
      const event = `${JSON.stringify({
        file: fileInfo.path, line: path.value.loc?.start.line || 1, rule,
        severity: 'media', message: 'Possível API legada; confirme o vínculo e a semântica antes de alterar.',
        before: j(path).toSource(), review: true,
      })}\n`;
      if (fs.statSync(report).size + Buffer.byteLength(event) > 2 * 1024 * 1024) {
        if (!fs.existsSync(`${report}.limit`)) fs.writeFileSync(`${report}.limit`, 'limit');
        return;
      }
      fs.appendFileSync(report, event);
    });
  }
  return null;
};
