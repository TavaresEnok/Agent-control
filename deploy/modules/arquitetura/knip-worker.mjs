// Adaptador da distribuição fixada do Knip. O reporter JSON só inclui achados.
import {createRequire} from 'node:module';
import {dirname, join, relative} from 'node:path';
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const [toolsRoot, configPath] = process.argv.slice(2);
const cwd = process.cwd();
const require = createRequire(import.meta.url);
const knipDist = dirname(require.resolve('knip', {paths: [toolsRoot]}));
const load = file => import(pathToFileURL(join(knipDist, file)).href);
const [
  {createOptions},
  {run},
  {default: reportJson},
  {Plugins},
] = await Promise.all([
  load('util/create-options.js'),
  load('run.js'),
  load('reporters/json.js'),
  load('plugins/index.js'),
]);

// Usa apenas a configuração gerada. O manifesto continua disponível para análise.
const packagePath = join(cwd, 'package.json');
const manifest = JSON.parse(readFileSync(packagePath, 'utf8').replace(/^\uFEFF/, ''));
if (Object.hasOwn(manifest, 'knip')) {
  delete manifest.knip;
  writeFileSync(packagePath, JSON.stringify(manifest));
}
// A descoberta de workspaces pode ler inclusões do pnpm através de um loader genérico.
const pnpmPath = join(cwd, 'pnpm-workspace.yaml');
let pnpmManifest;
try {
  pnpmManifest = readFileSync(pnpmPath, 'utf8');
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
if (pnpmManifest !== undefined) {
  const requireKnip = createRequire(join(knipDist, 'index.js'));
  const yaml = requireKnip('yaml');
  const parsed = yaml.parse(pnpmManifest);
  if (parsed && Object.hasOwn(parsed, 'include')) {
    delete parsed.include;
    writeFileSync(pnpmPath, yaml.stringify(parsed));
  }
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
for (const plugin of Object.keys(Plugins)) config[plugin] = false;
writeFileSync(configPath, JSON.stringify(config));
const options = await createOptions({isSession: true, args: {config: configPath, progress: false}});
const {results, session} = await run(options);
if (results.hasConfigLoadErrors) throw new Error('Knip informou falha ao carregar configurações');

let report;
await reportJson({
  ...results,
  report: options.includedIssueTypes,
  cwd,
  write: value => { report = JSON.parse(value); },
});

const toRelative = paths => [...paths].map(path => relative(cwd, path));
// O grafo também contém nós auxiliares. A distribuição fixa preenche
// internalImportCache apenas para nós submetidos à análise de código.
report.analyzedFiles = toRelative(
  [...session.getGraph()].filter(([, node]) => node.internalImportCache !== undefined).map(([path]) => path),
);
report.entryFiles = toRelative(session.getEntryPaths());
process.stdout.write(JSON.stringify(report));
