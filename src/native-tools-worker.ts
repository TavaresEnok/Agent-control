import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {readPrivateWorkerFile} from './native-worker-security.ts';
/** Tools only: no provider home, login, API key or model invocation. */
async function main(){
 if(process.argv.length!==2)throw Error('INVALID_TOOLS_ARGUMENTS');
 for(const key of Object.keys(process.env))delete process.env[key];
 Object.assign(process.env,{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp/ac-tools-home',CODEX_HOME:'/tmp/ac-tools-home/.codex',TMPDIR:'/tmp',DO_NOT_TRACK:'1'});
 await mkdir('/tmp/ac-tools-home/.codex',{recursive:true,mode:0o700});
 const bytes=await readPrivateWorkerFile('/runner/exec-token',512);
 try{if(!/^[A-Za-z0-9._~-]{32,512}$/.test(bytes.toString('utf8').trim()))throw Error('INVALID_TOOLS_TOKEN');}finally{bytes.fill(0);}
 const child=spawn('/usr/local/bin/codex',['exec-server','--listen','ws://0.0.0.0:19493','--ws-auth','capability-token','--ws-token-file','/runner/exec-token','--linux-sandbox-pid-namespace','inherit'],{cwd:'/work',env:process.env,stdio:'ignore'});
 const stop=()=>child.kill('SIGTERM');process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try{await new Promise<void>((ok,fail)=>{child.once('error',fail);child.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);ok();});});}
 finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
main().catch(()=>{console.error('NATIVE_TOOLS_WORKER_FAILED');process.exitCode=1;});
