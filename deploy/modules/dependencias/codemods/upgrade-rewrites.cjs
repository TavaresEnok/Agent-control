'use strict';

const fs = require('node:fs');
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

// These patterns depend on bindings, argument types or API semantics. Report them
// for review without changing the source or promising an equivalent rewrite.
module.exports = function transformer(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);
  const report = process.env.AC_JSCODESHIFT_REPORT;
  if (!report) return null;
  let bytes = fs.statSync(report).size;
  const checks = [
    [j.NewExpression, {callee: {type: 'Identifier', name: 'Buffer'}}, 'JSCODESHIFT-NODE-BUFFER-CTOR'],
    [j.NewExpression, {callee: {type: 'MemberExpression', object: {type: 'Identifier', name: 'Buffer'}, property: {type: 'Identifier', name: 'SlowBuffer'}}}, 'JSCODESHIFT-NODE-SLOW-BUFFER'],
    [j.CallExpression, {callee: {type: 'MemberExpression', object: {type: 'Identifier', name: 'url'}, property: {type: 'Identifier', name: 'parse'}}}, 'JSCODESHIFT-NODE-URL-PARSE'],
    [j.CallExpression, {callee: {type: 'MemberExpression', object: {type: 'Identifier', name: 'util'}, property: {type: 'Identifier', name: 'isArray'}}}, 'JSCODESHIFT-NODE-UTIL-ISARRAY'],
  ];
  for (const [type, pattern, rule] of checks) {
    for (const path of root.find(type, pattern).paths()) {
      const event = `${JSON.stringify({
        file: fileInfo.path, line: path.value.loc?.start.line || 1, rule,
        severity: 'media', message: 'Possível API legada; confirme o vínculo e a semântica antes de alterar.',
        before: j(path).toSource(), review: true,
      })}\n`;
      bytes += Buffer.byteLength(event);
      if (bytes > MAX_REPORT_BYTES) {
        fs.writeFileSync(`${report}.limit`, 'limit');
        return null;
      }
      fs.appendFileSync(report, event);
    }
  }
  return null;
};
