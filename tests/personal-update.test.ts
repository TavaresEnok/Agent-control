import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {test,type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {runPersonalUpdate} from '../src/personal-update-cli.ts';

async function fixture(t:TestContext){
 const root=await mkdtemp(join(tmpdir(),'personal-update-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'installation.json');
 await writeFile(file,JSON.stringify({
  schemaVersion:1,mode:'administration-only',activation:'personal',
  databaseUrl:'postgresql://postgres@127.0.0.1:1/disposable',dataDirectory:join(root,'data'),
  project:{id:randomUUID(),label:'Test',repo:join(root,'repo'),owner:'test'},
  http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'},
 }),{mode:0o600});
 return file;
}

const active='LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=532\nNRestarts=0\n';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const target=(file:string)=>`WorkingDirectory=${root}\nLoadState=loaded\nExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node --import tsx ${join(root,'src/server-main.ts')} serve ${file} ; ignore_errors=no ; pid=1 }\n`;

test('update waits for the verified backup and migration before restart, then proves stability and checks the panel',async t=>{
 const file=await fixture(t);
 const calls:string[]=[];
 let elapsed=0;
 let checks=0;
 const output=await runPersonalUpdate([file,'my setup'],{
  backup:async path=>{assert.equal(path,file);calls.push('backup');},
  initialize:async path=>{assert.equal(path,file);calls.push('initialize');},
  systemctl:async([action,unit,property])=>{
   assert.equal(unit,'agent-control-gateway-my-setup.service');
   if(action==='restart'){calls.push('restart');return '';}
   if(property?.includes('ExecStart')){calls.push('target');return target(file);}
   calls.push('show');
   if(++checks===1)return active.replace('ActiveState=active','ActiveState=activating').replace('SubState=running','SubState=start');
   return active;
  },
  now:()=>elapsed,
  wait:async ms=>{elapsed+=ms;},
  panel:async url=>{
   assert.equal(elapsed,16000);
   assert.equal(url,'http://127.0.0.1:8765/');
   calls.push('panel');
   return true;
  },
 });
 assert.deepEqual(calls.slice(0,5),['target','backup','initialize','target','restart']);
 assert(calls.slice(5,-2).every(call=>call==='show'));
 assert.deepEqual(calls.slice(-2),['panel','show']);
 assert.match(output,/Atualização concluída/);
});

test('update stops at every failure and reports the stage',async t=>{
 const file=await fixture(t);
 const beforeRestart=['target','backup','initialize','target'];
 const afterRestart=[...beforeRestart,'restart'];
 const cases=[
  ['wrongUnit',/confirmar a unidade/,['target']],
  ['backup',/restore-check/,['target','backup']],
  ['initialize',/Initialize falhou/,['target','backup','initialize']],
  ['changedUnit',/confirmar a unidade/,beforeRestart],
  ['restart',/reinício.*falhou/,afterRestart],
  ['loop',/não ficou estável/,[...afterRestart,'show','show']],
  ['timeout',/não ficou estável/,[...afterRestart,'show','show']],
  ['panel',/painel não serviu HTML/,[...afterRestart,'show','show','panel']],
  ['afterPanel',/não ficou estável/,[...afterRestart,'show','show','panel','show']],
 ] as const;
 for(const [failed,message,expected] of cases){
  const calls:string[]=[];
  let elapsed=0,checks=0,targets=0;
  const call=(name:string)=>{calls.push(name);if(name===failed&&name!=='panel')throw Error('synthetic failure');};
  await assert.rejects(runPersonalUpdate([file],{
   backup:async()=>call('backup'),
   initialize:async()=>call('initialize'),
   systemctl:async([action,,property])=>{
    if(property?.includes('ExecStart')){
     calls.push('target');
     targets++;
     return target(failed==='wrongUnit'||(failed==='changedUnit'&&targets===2)?file+'.other':file);
    }
    call(action!);
    if(action==='restart')return '';
    checks++;
    if((failed==='loop'&&checks===2)||(failed==='afterPanel'&&checks===3))return active.replace('NRestarts=0','NRestarts=1');
    if(failed==='timeout')return active.replace('ActiveState=active','ActiveState=activating');
    return active;
   },
   now:()=>elapsed,
   wait:async()=>{elapsed+=failed==='timeout'?30_000:15_000;},
   panel:async()=>{call('panel');return failed!=='panel';},
  }),message);
  assert.deepEqual(calls,expected,failed);
 }
});
