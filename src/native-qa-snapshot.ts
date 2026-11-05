import {constants} from 'node:fs';
import {open,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {Refusal} from './contracts.ts';

/** Only traverse the private snapshot through opened directories. Never follow
 * checkout symlinks or chmod shared inodes. */
export async function setQaSnapshotPermissions(path:string,readonly:boolean){
 const walk=async (name:string):Promise<void>=>{
  const dir=await open(name,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{
   const stat=await dir.stat();
   if(!stat.isDirectory()||stat.uid!==process.getuid?.())throw new Refusal('NATIVE_QA_SNAPSHOT_UNSAFE');
   if(!readonly)await dir.chmod(0o700);
   const anchor=`/proc/self/fd/${dir.fd}`;
   for(const entry of await readdir(anchor,{withFileTypes:true})){
    const child=join(anchor,entry.name);
    if(entry.isSymbolicLink())continue;
    if(entry.isDirectory()){await walk(child);continue;}
    if(!entry.isFile())throw new Refusal('NATIVE_QA_SNAPSHOT_UNSAFE');
    const file=await open(child,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const info=await file.stat();if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.())throw new Refusal('NATIVE_QA_SNAPSHOT_UNSAFE');
     if(readonly)await file.chmod((info.mode&0o111)?0o555:0o444);
    }finally{await file.close();}
   }
   if(readonly)await dir.chmod(0o555);
  }finally{await dir.close();}
 };
 await walk(path);
}
