// One personal-installation check for the 2-minute timer.
//   npm run personal:watch -- <instalação.json>
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const result=spawnSync(process.execPath,['--import','tsx','src/personal-watch-cli.ts',...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
process.exit(result.status??1);
