// Show, set or clear one project's QA commands.
//   npm run personal:qa -- <instalação.json> <projeto> show|set|clear
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const result=spawnSync(process.execPath,['--import','tsx','src/personal-qa-cli.ts',...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
process.exit(result.status??1);
