function modernNormalize(payload, endpoint, items) {
  const raw = Buffer.from(payload);
  const parsed = new URL(endpoint);
  const isArr = Array.isArray(items);
  return {raw, parsed, isArr};
}

module.exports = {modernNormalize};
