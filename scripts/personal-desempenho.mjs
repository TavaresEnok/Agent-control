// npm run personal:desempenho -- <instalação.json> <projeto>
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const result=spawnSync(process.execPath,['--import','tsx','src/personal-module-cli.ts','desempenho',...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
process.exit(result.status??1);
