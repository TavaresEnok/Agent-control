import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Refusal } from './contracts.ts';
import { loadInstallation } from './installation.ts';
import { generateRepoMap } from './repo-map.ts';

const messages: Record<string, string> = {
  MAPA_USAGE: 'Uso: npm run personal:mapa -- <instalação.json> <projectId> [--escopo <pasta>...] [--orcamento <tokens>]',
  PERSONAL_ACTIVATION_REQUIRED: 'A geração do mapa só roda numa instalação pessoal.',
  NOT_FOUND: 'Projeto não encontrado.',
};

export function parsePersonalMapaArgs(argv: readonly string[]): {
  installationPath: string;
  projectId: string;
  scope: string[];
  budgetTokens: number;
} {
  const positional: string[] = [];
  const scope: string[] = [];
  let budgetTokens = 4000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--escopo') {
      let next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Refusal('MAPA_USAGE');
      }
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) {
        scope.push(argv[i + 1]!);
        i++;
      }
      continue;
    }
    if (arg === '--orcamento') {
      const val = argv[i + 1];
      if (!val || val.startsWith('--')) throw new Refusal('MAPA_USAGE');
      const num = parseInt(val, 10);
      if (isNaN(num) || num <= 0) throw new Refusal('MAPA_USAGE');
      budgetTokens = num;
      i++;
      continue;
    }
    if (arg.startsWith('--')) throw new Refusal('MAPA_USAGE');
    positional.push(arg);
  }

  const [installationPath, projectId] = positional;
  if (!installationPath || !projectId || positional.length !== 2) {
    throw new Refusal('MAPA_USAGE');
  }

  return { installationPath, projectId, scope, budgetTokens };
}

export async function runPersonalMapa(argv: readonly string[]): Promise<{
  map: string;
  estimatedTokens: number;
  budgetTokens: number;
  includedFiles: number;
  totalFiles: number;
}> {
  const args = parsePersonalMapaArgs(argv);
  const config = await loadInstallation(resolve(args.installationPath));
  if (config.activation !== 'personal') throw new Refusal('PERSONAL_ACTIVATION_REQUIRED', 403);
  const project = [config.project, ...config.projects].find(item => item.id === args.projectId);
  if (!project) throw new Refusal('NOT_FOUND', 404);

  const result = await generateRepoMap({
    repoPath: project.repo,
    projectId: project.id,
    dataDirectory: config.dataDirectory,
    scope: args.scope.length > 0 ? args.scope : undefined,
    budgetTokens: args.budgetTokens,
  });

  return {
    map: result.map,
    estimatedTokens: result.estimatedTokens,
    budgetTokens: result.budgetTokens,
    includedFiles: result.includedFiles,
    totalFiles: result.totalCandidateFiles,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPersonalMapa(process.argv.slice(2)).then(
    res => {
      console.log(res.map);
      console.log(`Tokens estimados: ${res.estimatedTokens} (orçamento: ${res.budgetTokens}, arquivos: ${res.includedFiles}/${res.totalFiles})`);
    },
    error => {
      const code = error instanceof Refusal ? error.code : error instanceof Error ? error.message : '';
      console.error(messages[code] ?? (code || 'A geração do mapa falhou.'));
      process.exit(1);
    }
  );
}
