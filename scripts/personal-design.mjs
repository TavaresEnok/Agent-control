// npm run personal:design -- see src/personal-design-cli.ts for the arguments.
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const result=spawnSync(process.execPath,['--import','tsx','src/personal-design-cli.ts',...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
process.exit(result.status??1);
