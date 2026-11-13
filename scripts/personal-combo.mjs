// List or apply one project's team combo.
//   npm run personal:combo -- <instalação.json> <projeto> list|apply <nome>
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const result=spawnSync(process.execPath,['--import','tsx','src/personal-combo-cli.ts',...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
process.exit(result.status??1);
