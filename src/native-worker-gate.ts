import {lstat} from 'node:fs/promises';
/** The supervisor writes a signed launch only after inspecting both running
 * containers. Until then no credential is opened and no inference can start. */
export async function waitForNativeLaunch(path='/input/launch.json',timeoutMs=60000){
 const deadline=Date.now()+timeoutMs;
 for(;;){
  try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<2||(s.mode&0o077)!==0)throw Error('INVALID_WORKER_GATE');return;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(Date.now()>=deadline)throw Error('WORKER_GATE_EXPIRED');
  await new Promise(resolve=>setTimeout(resolve,100));
 }
}
