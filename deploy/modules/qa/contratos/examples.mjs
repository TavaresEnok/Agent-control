// Conjunto nominal: todas as entradas e expectativas vêm do próprio documento.
export const maxBodyBytes = 64 * 1024;
export const maxInventory = 64;
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const supportedMethods = new Set(['GET', 'POST']);
const json = 'application/json';
const safeName = /^[a-z0-9_.~-]+$/i;
const credentialFields = new Set([
  'authorization', 'proxyauthorization', 'credential', 'credentials', 'password', 'passwd',
  'senha', 'secret', 'clientsecret', 'token', 'accesstoken', 'refreshtoken', 'idtoken',
  'authtoken', 'apikey', 'xapikey', 'sessionid', 'cookie', 'setcookie',
]);
const credentialName = name => credentialFields.has(name.toLowerCase().replace(/[-_.]/g, ''));

function boundedJson(value, requestBody = false) {
  let nodes = 0;
  let chars = 0;
  function visit(item, depth) {
    if (++nodes > 4096 || depth > 20) return false;
    if (item === null || typeof item === 'boolean' || Number.isFinite(item)) return true;
    if (typeof item === 'string') {
      chars += item.length;
      return chars <= maxBodyBytes;
    }
    if (Array.isArray(item)) return item.every(child => visit(child, depth + 1));
    if (!isRecord(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
    return Object.entries(item).every(([key, child]) => {
      chars += key.length;
      return chars <= maxBodyBytes && !(requestBody && credentialName(key)) && visit(child, depth + 1);
    });
  }
  if (!visit(value, 0)) return undefined;
  const body = JSON.stringify(value, requestBody ? (_, item) => isRecord(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item : undefined);
  return Buffer.byteLength(body) <= maxBodyBytes ? body : undefined;
}

function embedded(container) {
  if (!isRecord(container)) return [];
  if (Object.hasOwn(container, 'example')) return [{value: container.example}];
  if (isRecord(container.examples)) return Object.entries(container.examples).map(([name, example]) =>
    isRecord(example) && Object.hasOwn(example, 'value') && !Object.hasOwn(example, 'externalValue')
      ? {name, value: example.value} : {name});
  if (isRecord(container.schema)) {
    if (Object.hasOwn(container.schema, 'example')) return [{value: container.schema.example}];
    if (Array.isArray(container.schema.examples)) return container.schema.examples.map(value => ({value}));
  }
  return [];
}

function select(examples, name) {
  const named = name === undefined ? undefined : examples.find(example => example.name === name);
  return named ?? (examples.length === 1 && (name === undefined || examples[0].name === undefined)
    ? examples[0] : undefined);
}

function scalar(value) {
  return typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value);
}

function requestPath(path, query) {
  if (typeof path !== 'string' || !/^\/(?:[a-z0-9_.~-]+\/)*[a-z0-9_.~-]*$/i.test(path) ||
      path.split('/').some(segment => segment === '.' || segment === '..')) return undefined;
  query.sort();
  const suffix = query.toString();
  const target = suffix ? `${path}?${suffix}` : path;
  return target.length <= 2048 ? target : undefined;
}

function openApiRequest(path, method, inheritedParams, operation, name) {
  const parameters = new Map();
  for (const parameter of [...(inheritedParams ?? []), ...(operation.parameters ?? [])]) {
    parameters.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  const pathValues = new Map();
  const query = new URLSearchParams();
  for (const parameter of parameters.values()) {
    const {in: where, required, style, allowReserved} = parameter;
    const examples = embedded(parameter);
    if (!required && !examples.length) continue;
    if (!['path', 'query'].includes(where) || !safeName.test(parameter.name) || credentialName(parameter.name) ||
        allowReserved || (style && style !== (where === 'path' ? 'simple' : 'form'))) return undefined;
    const example = select(examples, name);
    if (!example && !required) continue;
    if (!scalar(example?.value) || String(example.value).length > 2048) return undefined;
    const value = String(example.value);
    if (where === 'path') {
      if (!safeName.test(value) || value === '.' || value === '..') return undefined;
      pathValues.set(parameter.name, value);
    } else {
      query.set(parameter.name, value);
    }
  }
  const target = requestPath(path.replace(/\{([^{}]+)\}/g, (_, key) => pathValues.get(key) ?? '{}'), query);
  if (!target) return undefined;
  if (!operation.requestBody) return {method, target};
  if (method !== 'POST') return undefined;
  const selected = select(embedded(operation.requestBody.content?.[json]), name);
  const body = boundedJson(selected?.value, true);
  return body === undefined ? undefined : {method, target, body};
}

function addOperationCases(cases, candidates) {
  const requests = new Map();
  for (const candidate of candidates) {
    if (!candidate.request) continue;
    const key = JSON.stringify(candidate.request);
    requests.set(key, (requests.get(key) ?? 0) + 1);
  }
  for (const candidate of candidates) {
    if (candidate.request && requests.get(JSON.stringify(candidate.request)) > 1) {
      cases.push({at: candidate.at, reason: 'mesma requisição associada a mais de um exemplo de resposta'});
    } else {
      cases.push(candidate);
    }
  }
}

export function planOpenApi(spec) {
  const cases = [];
  let operations = 0;
  let withoutExamples = 0;
  let omitted = 0;
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [verb, operation] of Object.entries(pathItem ?? {})) {
      if (!methods.has(verb)) continue;
      operations++;
      const method = verb.toUpperCase();
      const security = operation.security ?? spec.security ?? [];
      const anonymous = !security.length || security.some(requirement => Object.keys(requirement).length === 0);
      const responses = Object.entries(operation.responses ?? {}).flatMap(([status, response]) =>
        Object.entries(response.content ?? {}).flatMap(([media, declaration]) =>
          embedded(declaration).map(example => ({status, media, example}))));
      if (!responses.length) withoutExamples++;
      // A operação é indivisível na enumeração, para não esconder pares ambíguos.
      if (cases.length + responses.length > maxInventory) {
        omitted += responses.length;
        continue;
      }
      addOperationCases(cases, responses.map(({status, media, example}, index) => {
        const at = `operação ${operations} (${method}), resposta ${/^[2-5](?:\d\d|XX)$/.test(status) ? status : 'sem código exato'}, exemplo ${index + 1}`;
        if (!supportedMethods.has(method)) return {at, reason: 'método fora do escopo GET/POST'};
        if (!anonymous) return {at, reason: 'operação exige autenticação'};
        if (media !== json || !/^[2-5]\d\d$/.test(status) || boundedJson(example.value) === undefined) {
          return {at, reason: 'resposta sem exemplo JSON embutido, limitado e associado a código HTTP exato'};
        }
        const request = openApiRequest(path, method, pathItem.parameters, operation, example.name);
        if (!request) return {at, reason: 'entrada explícita insuficiente ou serialização fora do escopo'};
        return {at, request, expected: {status: Number(status), value: example.value}};
      }));
    }
  }
  return {cases, declared: cases.length + omitted, omitted, inventory: `${operations} operações, ${withoutExamples} sem exemplo de resposta`};
}

export function isJsonContentType(value) {
  return typeof value === 'string' && /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(value.trim());
}

function pactSection(section, fields, hasBody) {
  if (!isRecord(section) || Object.keys(section).some(key =>
    !fields.includes(key) && !['matchingRules', 'generators'].includes(key))) return undefined;
  if (['matchingRules', 'generators'].some(key => Object.hasOwn(section, key) &&
    (!isRecord(section[key]) || Object.keys(section[key]).length))) return undefined;
  if (!Object.hasOwn(section, 'headers')) return {};
  if (!isRecord(section.headers)) return undefined;
  const headers = Object.entries(section.headers);
  if (!headers.length) return {};
  if (headers.length !== 1 || headers[0][0].toLowerCase() !== 'content-type' || !hasBody) return undefined;
  const value = headers[0][1];
  const header = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (!isJsonContentType(header)) return undefined;
  return {charset: header.includes(';')};
}

function pactQuery(value, major) {
  if (value === undefined) return new URLSearchParams();
  let entries;
  if (major === 2 && typeof value === 'string' && !value.startsWith('?')) {
    entries = [...new URLSearchParams(value)].map(([key, item]) => [key, [item]]);
  } else if (major === 3 && isRecord(value)) {
    entries = Object.entries(value);
  } else {
    return undefined;
  }
  const query = new URLSearchParams();
  for (const [key, values] of entries) {
    if (!safeName.test(key) || credentialName(key) || !Array.isArray(values) || !values.length ||
        values.some(item => typeof item !== 'string')) return undefined;
    for (const item of values) query.append(key, item);
  }
  return query;
}

function pactCase(interaction, index, major) {
  const at = `interação ${index + 1} (#/interactions/${index})`;
  const {request, response, providerState, providerStates} = interaction ?? {};
  if ((providerState != null && providerState !== '') ||
      (providerStates != null && (!Array.isArray(providerStates) || providerStates.length)) ||
      Object.hasOwn(interaction ?? {}, 'matchingRules') || Object.hasOwn(interaction ?? {}, 'generators')) {
    return {at, reason: 'estado de provedor, regra de matching ou gerador fora do escopo'};
  }
  const hasBody = isRecord(request) && Object.hasOwn(request, 'body');
  const requestHeaders = pactSection(request, ['method', 'path', 'query', 'headers', 'body'], hasBody);
  const responseHeaders = pactSection(response, ['status', 'headers', 'body'], true);
  if (!requestHeaders || !responseHeaders ||
      !supportedMethods.has(request.method) || !Number.isInteger(response.status) ||
      response.status < 200 || response.status > 599 || !Object.hasOwn(response, 'body')) {
    return {at, reason: 'interação fora do recorte HTTP GET/POST com corpo de resposta JSON e sem cabeçalhos adicionais'};
  }
  const query = pactQuery(request.query, major);
  const target = query && requestPath(request.path, query);
  const body = hasBody ? boundedJson(request.body, true) : undefined;
  if (!target || (hasBody && (request.method !== 'POST' || body === undefined)) || boundedJson(response.body) === undefined) {
    return {at, reason: 'requisição local ou corpo JSON fora dos limites do executor'};
  }
  return {
    at,
    request: {method: request.method, target, body, ...requestHeaders},
    expected: {status: response.status, value: response.body, ...responseHeaders},
  };
}

export function planPact(spec) {
  const version = spec?.metadata?.pactSpecification?.version;
  const validParty = party => typeof party?.name === 'string' && party.name.trim().length > 0;
  if (!validParty(spec?.consumer) || !validParty(spec?.provider) || spec.consumer.name.trim() === spec.provider.name.trim()) {
    return {reason: 'contrato sem consumidor e provedor distintos'};
  }
  if (!['2.0.0', '3.0.0'].includes(version) ||
      Object.hasOwn(spec, 'messages') || !Array.isArray(spec.interactions)) {
    return {reason: 'contrato fora do recorte Pact HTTP 2.0.0/3.0.0'};
  }
  return {
    version, cases: spec.interactions.slice(0, maxInventory).map((item, index) => pactCase(item, index, Number(version[0]))),
    declared: spec.interactions.length,
    omitted: Math.max(0, spec.interactions.length - maxInventory),
    inventory: `${spec.interactions.length} interações declaradas`,
  };
}

export function matchesExample(actual, expected, exactLeaves) {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length &&
    expected.every((item, index) => matchesExample(actual[index], item, exactLeaves));
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    const entries = Object.entries(expected);
    if (exactLeaves && !entries.length) return Object.keys(actual).length === 0;
    return entries.every(([key, value]) => Object.hasOwn(actual, key) && matchesExample(actual[key], value, exactLeaves));
  }
  if (exactLeaves || expected === null) return actual === expected;
  return actual !== null && typeof actual === typeof expected;
}
