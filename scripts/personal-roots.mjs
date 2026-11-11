// Records the directories the personal panel may browse.
//   npm run personal:roots -- <instalação.json> list
//   npm run personal:roots -- <instalação.json> add <pasta> [--label nome]
//   npm run personal:roots -- <instalação.json> remove <id>
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const result=spawnSync(process.execPath,['--import','tsx','src/personal-roots.ts',...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
process.exit(result.status??1);
