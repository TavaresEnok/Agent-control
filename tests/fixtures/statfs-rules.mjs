// Preload for subprocess tests: replaces fs.promises.statfs with a table of fake volumes.
// Nothing is written or filled. Each rule is {prefix, used}; the longest matching prefix answers,
// and every measured path is recorded in globalThis.__statfsCalls.
import fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';

const BLOCKS = 100000;
globalThis.__statfsRules = [{prefix: '/', used: 10}];
globalThis.__statfsCalls = [];

fsp.statfs = async function fakeStatfs(path, options) {
  const target = String(path);
  const rule = globalThis.__statfsRules
    .filter(item => target === item.prefix || target.startsWith(item.prefix.endsWith('/') ? item.prefix : item.prefix + '/'))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!rule) throw Object.assign(new Error('statfs sem regra: ' + target), {code: 'ENOENT'});
  globalThis.__statfsCalls.push(target);
  // used is a percentage with up to two decimals; the volume has no reserved blocks.
  const usedBlocks = Math.round(rule.used * (BLOCKS / 100));
  const values = {type: 0xEF53, bsize: 4096, blocks: BLOCKS, bfree: BLOCKS - usedBlocks, bavail: BLOCKS - usedBlocks, files: 1000, ffree: 1000};
  if (options?.bigint) return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, BigInt(value)]));
  return values;
};
syncBuiltinESMExports();
