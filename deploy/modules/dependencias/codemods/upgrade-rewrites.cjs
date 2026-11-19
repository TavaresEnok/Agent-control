'use strict';

const fs = require('node:fs');
const {createHash} = require('node:crypto');
const getParser = require('jscodeshift/src/getParser');
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

// These patterns depend on bindings, argument types or API semantics. Report them
// for review without changing the source or promising an equivalent rewrite.
module.exports = function transformer(fileInfo, api, options) {
  const {path: file, source} = fileInfo;
  const report = process.env.AC_JSCODESHIFT_REPORT;
  const nonce = process.env.AC_JSCODESHIFT_NONCE;
  if (!report || !nonce) return null;

  const j = api.jscodeshift;
  // Parse the original text directly to keep tabs and CRLF in source offsets.
  const root = j(getParser(options.parser).parse(source));
  const sha256 = createHash('sha256').update(source).digest('hex');
  const header = `${JSON.stringify({kind: 'source', file, nonce, sha256})}\n`;
  fs.writeFileSync(report, header, {flag: 'wx'});
  let bytes = Buffer.byteLength(header);
  const checks = [
    [j.NewExpression, {callee: {type: 'Identifier', name: 'Buffer'}}, 'JSCODESHIFT-NODE-BUFFER-CTOR'],
    [j.NewExpression, {callee: {type: 'MemberExpression', object: {type: 'Identifier', name: 'Buffer'}, property: {type: 'Identifier', name: 'SlowBuffer'}}}, 'JSCODESHIFT-NODE-SLOW-BUFFER'],
    [j.CallExpression, {callee: {type: 'MemberExpression', object: {type: 'Identifier', name: 'url'}, property: {type: 'Identifier', name: 'parse'}}}, 'JSCODESHIFT-NODE-URL-PARSE'],
    [j.CallExpression, {callee: {type: 'MemberExpression', object: {type: 'Identifier', name: 'util'}, property: {type: 'Identifier', name: 'isArray'}}}, 'JSCODESHIFT-NODE-UTIL-ISARRAY'],
  ];
  for (const [type, pattern, rule] of checks) {
    for (const path of root.find(type, pattern).paths()) {
      const event = `${JSON.stringify({
        file, line: path.value.loc.start.line, column: path.value.loc.start.column, rule,
        severity: 'media', message: 'Possível API legada; confirme o vínculo e a semântica antes de alterar.',
        before: source.slice(path.value.start, path.value.end), review: true,
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
