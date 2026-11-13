// Dated personal backup. Keeps the 7 newest folders and can rsync the new one.
//   npm run personal:backup-rotate -- <instalação.json> <pasta>
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const result=spawnSync(process.execPath,['--import','tsx','src/personal-backup-rotate-cli.ts',...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
process.exit(result.status??1);
