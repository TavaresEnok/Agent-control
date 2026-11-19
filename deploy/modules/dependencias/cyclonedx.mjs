import {readFileSync} from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import addInternationalFormats from 'ajv-formats-draft2019';

const validators = new Map();
let ajv;

function readSchema(name) {
  return JSON.parse(readFileSync(new URL(`./schemas/${name}.schema.json`, import.meta.url), 'utf8'));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

function checkUniqueItems(required, items) {
  if (!required) return true;
  const seen = new Set();
  for (const item of items) {
    const key = canonicalJson(item);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function validatorFor(version) {
  if (validators.has(version)) return validators.get(version);
  if (!ajv) {
    // CycloneDX 1.2 uses the undeclared format "string", which is a JSON Schema annotation.
    const instance = new Ajv({strict: false, strictNumbers: true, ownProperties: true, formats: {string: true}});
    // Keep object equality independent of key order without comparing every pair in a large inventory.
    instance.removeKeyword('uniqueItems');
    instance.addKeyword({keyword: 'uniqueItems', type: 'array', schemaType: 'boolean', validate: checkUniqueItems});
    addFormats(instance);
    addInternationalFormats(instance, {formats: ['iri-reference', 'idn-email']});
    for (const name of ['spdx', 'jsf-0.82', 'cryptography-defs']) instance.addSchema(readSchema(name));
    ajv = instance;
  }
  const validate = ajv.compile(readSchema(`bom-${version}`));
  validators.set(version, validate);
  return validate;
}

export function validateCycloneDx(bom) {
  if (bom?.bomFormat !== 'CycloneDX' || typeof bom.specVersion !== 'string' || !bom.specVersion.trim()) {
    return 'erro=formato_invalido';
  }
  const version = bom.specVersion;
  if (!/^1\.[2-7]$/.test(version)) {
    return `erro=versao_cyclonedx_nao_suportada; versao=${JSON.stringify(version).slice(0, 64)}`;
  }
  let validate;
  try {
    validate = validatorFor(version);
  } catch {
    return `erro=esquema_cyclonedx_indisponivel; versao=${version}`;
  }
  try {
    if (validate(bom)) return null;
    const {instancePath, keyword} = validate.errors[0];
    return `erro=esquema_cyclonedx_invalido; versao=${version}; campo=${JSON.stringify(instancePath || '/').slice(0, 180)}; regra=${keyword}`;
  } catch {
    return `erro=validacao_cyclonedx_interrompida; versao=${version}`;
  }
}
