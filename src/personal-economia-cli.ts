/**
 * personal:economia: lê um arquivo JSON de resultados de um experimento de economia (formato em src/economy-trial.ts e
 * docs/economia/PROTOCOLO.md) e imprime o relatório e o veredito. Não chama modelos.
 *
 * Uso: npm run personal:economia -- <resultados.json> [--json]
 * Saída: 0 quando entra no padrão, 2 quando não entra, 3 quando inconclusivo, 1 em erro de leitura ou formato.
 */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {analyzeTrial, formatTrialReport, TrialInputError, type TrialResult} from './economy-trial.ts';

export const EXIT_BY_VERDICT: Record<TrialResult['veredito'], number> = {'entra no padrão': 0, 'não entra': 2, 'inconclusivo': 3};

export async function runPersonalEconomia(argv: string[]): Promise<{output: string; result: TrialResult}> {
  const json = argv.includes('--json');
  const files = argv.filter(a => a !== '--json');
  if (files.length !== 1) throw new TrialInputError('uso: npm run personal:economia -- <resultados.json> [--json]');
  let raw: unknown;
  try { raw = JSON.parse(await readFile(resolve(files[0]), 'utf8')); }
  catch (e) { throw new TrialInputError('não consegui ler o JSON de ' + files[0] + ': ' + (e as Error).message); }
  const result = analyzeTrial(raw);
  return {result, output: json ? JSON.stringify(result, null, 1) : formatTrialReport(result)};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPersonalEconomia(process.argv.slice(2)).then(
    ({output, result}) => { console.log(output); process.exit(EXIT_BY_VERDICT[result.veredito]); },
    error => { console.error(error instanceof TrialInputError ? error.message : 'personal:economia falhou: ' + (error as Error).message); process.exit(1); },
  );
}
