import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {Refusal} from './contracts.ts';

/** Serialize deletion with image selection until the run has durably recorded its digest. */
export async function withInstallationImageLock<T>(dataDirectory:string,shared:boolean,operation:()=>Promise<T>,waitSeconds=15):Promise<T>{
 const handle=await open(dataDirectory,constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_RDONLY);
 try{
  await new Promise<void>((ok,fail)=>{
   const lock=spawn('/usr/bin/flock',[shared?'--shared':'--exclusive','--wait',String(waitSeconds),'3'],{stdio:['ignore','ignore','ignore',handle.fd]});
   lock.once('error',fail);
   lock.once('close',code=>code===0?ok():fail(new Refusal('MODULE_IMAGE_LOCK_BUSY',503)));
  });
  return await operation();
 }finally{await handle.close();}
}
