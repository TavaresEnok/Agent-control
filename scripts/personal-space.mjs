// Espaço do próprio Agent Control, por categoria, contra o orçamento (storage.budgetGB).
//   npm run personal:espaco -- <instalação.json> [--json] [--por-projeto]
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
// npm runs this from the product root; a relative installation path is taken from where npm was called (INIT_CWD).
const args=process.argv.slice(2).map((arg,index)=>index===0&&!arg.startsWith('--')?resolve(process.env.INIT_CWD??process.cwd(),arg):arg);
const result=spawnSync(process.execPath,['--import','tsx','src/personal-space.ts',...args],{cwd:root,stdio:'inherit'});
process.exit(result.status??1);
