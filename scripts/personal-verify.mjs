// npm run personal:verify -- see src/personal-verify-cli.ts for the arguments.
// A transient failure (exit 75: the Docker daemon too busy to answer) starts a new attempt after a pause. The security exam
// journal keeps every judgment and confirmation already paid for, so the new attempt continues where the last one stopped.
// AC_VERIFY_RETRIES (default 3) and AC_VERIFY_RETRY_PAUSE_MS (default 60000) change the limits.
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const cli=process.env.AC_VERIFY_CLI_FOR_TESTS??'src/personal-verify-cli.ts';
const retries=Math.max(0,Math.min(10,Number.parseInt(process.env.AC_VERIFY_RETRIES??'3',10)||0));
const pauseMs=Math.max(0,Number.parseInt(process.env.AC_VERIFY_RETRY_PAUSE_MS??'60000',10)||0);
let status=1;
for(let attempt=0;attempt<=retries;attempt+=1){
 if(attempt>0){
  console.error(`Falha passageira do Docker. Retomando a verificação (tentativa ${attempt+1} de ${retries+1}).`);
  if(pauseMs)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,pauseMs);
 }
 const result=spawnSync(process.execPath,['--import','tsx',cli,...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
 status=result.status??1;
 if(status!==75)break;
}
process.exit(status===75?1:status);
