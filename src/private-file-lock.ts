import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {Refusal} from './contracts.ts';

/** The inherited descriptor and this process share the flock until the handle closes. Keep the lock file in place. */
export async function withPrivateFileLock<T>(path:string,busyCode:string,operation:()=>Promise<T>):Promise<T>{
 const handle=await open(path,constants.O_CREAT|constants.O_NOFOLLOW|constants.O_RDWR,0o600);
 try{
  await new Promise<void>((ok,fail)=>{
   const child=spawn('/usr/bin/flock',['--exclusive','--wait','5','3'],{stdio:['ignore','ignore','ignore',handle.fd]});
   child.once('error',fail);
   child.once('close',code=>code===0?ok():fail(new Refusal(busyCode,503)));
  });
  return await operation();
 }finally{await handle.close();}
}
