import {lstatSync, readFileSync, realpathSync} from 'node:fs';
import {resolve} from 'node:path';

export const manifestPath = 'qa-banco-local.json';
export const seedPath = 'banco/seed.sql';
export const invariantPath = 'banco/assert.sql';
export const freshPath = 'banco/pgtap-fresh.sql';

const migrationInventory = /^db\/migrations\/\d+_[a-zA-Z0-9_.-]+\.sql$/;
const migrationPath = /^db\/migrations\/\d{1,16}_[a-zA-Z0-9_.-]{1,64}\.sql$/;
const maxMigrations = 24;
const maxBytes = 64 * 1024;
const utf8 = new TextDecoder('utf-8', {fatal: true});

function readSource(workspace, file) {
  const path = resolve(workspace, file);
  const stat = lstatSync(path);
  if (!stat.isFile() || realpathSync(path) !== path || stat.size < 1 || stat.size > maxBytes) {
    throw new Error('invalid fixture');
  }
  const source = utf8.decode(readFileSync(path));
  if (!source.trim() || source.includes('\0')) throw new Error('invalid fixture');
  return source;
}

function predicate(source) {
  const leading = /^(?:\s|--[^\r\n]*)*/.exec(source)[0];
  const sql = source.slice(leading.length).trimEnd().replace(/;$/, '');
  if (!/^SELECT\s/i.test(sql)) throw new Error('expected scalar SELECT');
  return {sql, line: leading.split('\n').length};
}

export function planBancoLocal({workspace, copiedFiles, incomplete}) {
  const files = new Set(copiedFiles);
  if (!files.has(manifestPath)) return {status: 'skipped', reason: `${manifestPath} ausente; nenhuma fixture sintética declarada`};
  if (incomplete) return {status: 'skipped', reason: 'snapshot parcial; inventário de migrações sem confirmação'};
  try {
    const manifest = JSON.parse(readSource(workspace, manifestPath));
    if (!manifest || manifest.version !== 1 || manifest.provenance !== 'synthetic' ||
        Object.keys(manifest).length !== 3 || !Array.isArray(manifest.migrations) ||
        manifest.migrations.length < 1 || manifest.migrations.length > maxMigrations ||
        manifest.migrations.some(file => typeof file !== 'string' || !migrationPath.test(file))) {
      return {status: 'skipped', reason: `${manifestPath} fora do contrato de fixtures sintéticas`};
    }

    // O módulo 5 usa ordem lexicográfica e trata a última migração como atualização.
    const inventory = [...files].filter(file => migrationInventory.test(file)).sort();
    if (inventory.length !== manifest.migrations.length ||
        inventory.some((file, index) => file !== manifest.migrations[index])) {
      return {status: 'skipped', reason: 'migrações declaradas divergem do inventário ordenado de db/migrations'};
    }
    const migrations = inventory.map(file => ({file, sql: readSource(workspace, file)}));
    const fresh = files.has(freshPath) ? predicate(readSource(workspace, freshPath)) : null;
    const missing = [seedPath, invariantPath].filter(file => !files.has(file));
    const history = migrations.length < 2 ? {reason: 'são necessárias pelo menos duas migrações'}
      : missing.length ? {reason: `entradas históricas ausentes (${missing.join(', ')})`}
        : {seed: readSource(workspace, seedPath), invariant: predicate(readSource(workspace, invariantPath))};
    return {migrations, fresh, history};
  } catch {
    return {status: 'skipped', reason: 'fixture ilegível ou incompatível com o contrato de SQL sintético'};
  }
}
