import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { compactarSaida } from './compactar-saida.mjs';

// A mesma entrada é usada pelas duas técnicas. Sem filtro adequado, RTK passa a entrada.
const samples = [
  ['01-tsc', 'tsc'], ['02-test-usage', 'vitest'], ['02-test-passing', 'vitest'],
  ['03-git-log', 'git-log'], ['04-git-diff', 'git-diff'], ['05-npm-ls', null],
  ['06-docker-ps', null], ['07-astra-log', 'log']
];
const tokens = s => Math.ceil([...s].length / 4);
for (const [name, filter] of samples) {
  const raw = readFileSync(`docs/economia/amostras-saida/${name}.txt`, 'utf8');
  const result = spawnSync('/home/app/.local/bin/rtk-1.2.1', ['pipe', ...(filter ? ['-f', filter] : ['--passthrough'])], {input: raw, encoding: 'utf8'});
  if (result.status !== 0) throw new Error(`RTK ${name}: ${result.stderr}`);
  const own = compactarSaida(raw, {maxLinhas: 50});
  // Conta linhas de diagnóstico exatamente preservadas; não prova a preservação de contexto.
  const diagnostics = raw.split(/\r?\n/).filter(l => /(?:error TS\d+|ERR_MODULE_NOT_FOUND|npm error|AssertionError|Error: connect ECONNREFUSED)/.test(l));
  const retained = output => diagnostics.filter(l => output.includes(l.trim())).length;
  console.log(JSON.stringify({name, filter: filter ?? 'passthrough', raw: tokens(raw), rtk: tokens(result.stdout), own: tokens(own), diagnostics: diagnostics.length, rtkRetained: retained(result.stdout), ownRetained: retained(own)}));
}
