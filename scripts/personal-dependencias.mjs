// npm run personal:dependencias -- <instalação.json> <projeto>
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const result=spawnSync(process.execPath,['--import','tsx','src/personal-module-cli.ts','dependencias',...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
process.exit(result.status??1);
