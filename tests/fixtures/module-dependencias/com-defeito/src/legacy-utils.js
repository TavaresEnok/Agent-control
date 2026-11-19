const url = require('node:url');
const util = require('node:util');

function legacyNormalize(payload, endpoint, items) {
  const raw = new Buffer(payload);
  const parsed = url.parse(endpoint);
  const isArr = util.isArray(items);
  return {raw, parsed, isArr};
}

module.exports = {legacyNormalize};
