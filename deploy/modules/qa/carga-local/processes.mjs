import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {limits} from './limits.mjs';

const pins = JSON.parse(readFileSync(new URL('./tools.lock.json', import.meta.url), 'utf8'));
export const defaultBinDir = '/usr/local/bin';

export function launch(binary, args, cwd, signal, capture = false) {
  const outputMode = capture ? 'pipe' : 'ignore';
  const child = spawn(binary, args, {
    cwd,
    env: {HOME: cwd, TMPDIR: cwd, XDG_CONFIG_HOME: cwd, XDG_CACHE_HOME: cwd, K6_NO_USAGE_REPORT: 'true'},
    stdio: ['ignore', outputMode, outputMode],
    signal,
    killSignal: 'SIGKILL',
  });
  let output = '';
  let error;
  const captureText = text => {
    output = (output + text).slice(0, 1024);
  };
  child.stdout?.setEncoding('utf8').on('data', captureText);
  child.stderr?.setEncoding('utf8').on('data', captureText);
  const closed = new Promise(resolve => {
    child.once('error', fault => { error = fault.code; });
    child.once('close', code => resolve({code, error, output}));
  });
  return {child, closed};
}

export function command(binary, args, cwd, signal, ms, capture = false) {
  return launch(binary, args, cwd, AbortSignal.any([signal, AbortSignal.timeout(ms)]), capture).closed;
}

export async function probeTools(binDir, cwd, signal) {
  const probes = await Promise.all(Object.entries(pins).map(async ([name, {version}]) => {
    const binary = join(binDir, name);
    const result = await command(binary, [name === 'k6' ? 'version' : '-version'], cwd, signal, limits.startupMs, true);
    if (result.error === 'ENOENT') return {name, reason: 'ausente', status: 'skipped'};
    if (result.code !== 0) return {name, reason: 'sonda de versão falhou', status: 'failed'};
    const expected = new RegExp(`(?:^|\\s)v?${version.replaceAll('.', '\\.')}($|\\s)`);
    if (!expected.test(result.output)) return {name, reason: `versão fixada ${version} indisponível`, status: 'skipped'};
    return {name, binary, version};
  }));
  const unavailable = probes.filter(probe => probe.reason);
  if (unavailable.length) {
    return {
      status: unavailable.some(probe => probe.status === 'failed') ? 'failed' : 'skipped',
      reason: unavailable.map(({name, reason}) => `${name} ${reason}`).join(', '),
    };
  }
  return {
    k6: probes[0].binary,
    proxy: probes[1].binary,
    version: `k6 ${probes[0].version} / Toxiproxy ${probes[1].version}`,
  };
}
