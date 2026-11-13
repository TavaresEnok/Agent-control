// systemd user timers: watch every 2 minutes, backup daily at 03:30.
//   npm run personal:timers -- <instalação.json> [--remove]
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const result=spawnSync(process.execPath,['--import','tsx','src/personal-timers-cli.ts',...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
process.exit(result.status??1);
