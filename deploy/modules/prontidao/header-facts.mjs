const MIN_HSTS_MAX_AGE_SECONDS = 15_552_000;

function hstsMaxAge(value) {
  const seen = new Set();
  let maxAge = null;
  for (const directive of value.split(';').map(part => part.trim()).filter(Boolean)) {
    const match = /^([!#$%&'*+.^_`|~\w-]+)(?:[\t ]*=[\t ]*("[^"\r\n]*"|[!#$%&'*+.^_`|~\w-]+))?$/.exec(directive);
    if (!match) return null;
    const [, key, arg] = match;
    const lower = key.toLowerCase();
    if (seen.has(lower)) return null;
    seen.add(lower);
    if (lower === 'includesubdomains' && arg !== undefined) return null;
    if (lower !== 'max-age') continue;
    if (!/^(?:\d+|"\d+")$/.test(arg ?? '')) return null;
    maxAge = Number(arg.replaceAll('"', ''));
  }
  return Number.isFinite(maxAge) ? maxAge : null;
}

function hasFrameAncestors(value) {
  return value.split(',').some(policy => {
    // Browsers use the first directive of a given name within each policy.
    const directive = policy.split(';').find(part => /^\s*frame-ancestors(?:\s|$)/i.test(part));
    if (!directive) return false;
    const sources = directive.trim().split(/\s+/).slice(1);
    if (sources.length === 1 && sources[0].toLowerCase() === "'none'") return true;
    return sources.length > 0 && !sources.includes('*') && sources.every(source =>
      /^'self'$/i.test(source)
      || /^[a-z][a-z0-9+.-]*:$/i.test(source)
      || /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::(?:\d+|\*))?(?:\/[^\s;,]*)?$/i.test(source),
    );
  });
}

// Only these results cross the observation boundary. Header values can contain nonces and tenant names.
export function passiveHeaderFacts(headers) {
  const value = name => {
    const raw = headers[name];
    const text = Array.isArray(raw) ? raw.join(', ') : typeof raw === 'string' ? raw : '';
    return text.length > 1000 ? '[oversize]' : text.trim();
  };
  const hsts = value('strict-transport-security');
  const age = hstsMaxAge(hsts);
  return {
    hsts: !hsts ? 'absent' : age === null ? 'invalid' : age < MIN_HSTS_MAX_AGE_SECONDS ? 'insufficient' : 'adequate',
    noSniff: value('x-content-type-options').toLowerCase() === 'nosniff',
    antiFrame: /^(?:DENY|SAMEORIGIN)$/i.test(value('x-frame-options')) || hasFrameAncestors(value('content-security-policy')),
  };
}
