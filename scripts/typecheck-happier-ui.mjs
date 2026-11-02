import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {resolveTypeScriptCommandInvocation} from '../upstream/happier/scripts/workspaces/typescriptCommand.mjs';
const cwd=resolve('upstream/happier/apps/ui');
const invocation=resolveTypeScriptCommandInvocation({cwd,args:['-p','tsconfig.json','--noEmit']});
const result=spawnSync(invocation.command,invocation.args,{cwd,env:process.env,stdio:'inherit'});
console.log(JSON.stringify({check:'happier-ui-types',exitCode:result.status,signal:result.signal,error:result.error?.message}));
process.exit(result.status??1);
