import {lstat,realpath,statfs} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {z} from 'zod';
import {Refusal} from './contracts.ts';

export const DiskAdmissionPolicy=z.object({schemaVersion:z.literal(1),
 paths:z.array(z.string().min(1).max(4096).refine(path=>isAbsolute(path)&&resolve(path)===path,'ABSOLUTE_NORMALIZED_PATH_REQUIRED')).min(1).max(8),
 minFreeBytes:z.number().int().safe().nonnegative(),estimatedWriteBytes:z.number().int().safe().positive()}).strict();
export type DiskAdmissionPolicy=z.infer<typeof DiskAdmissionPolicy>;
export interface DiskGuard{assertAdmission(additionalReservedBytes?:bigint):Promise<void>}
export async function measureDiskCapacity(path:string){
 try{
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw new Refusal('DISK_PATH_UNSAFE');
  const measurement=await statfs(path,{bigint:true});
  return {availableBytes:measurement.bavail*measurement.bsize,totalBytes:measurement.blocks*measurement.bsize};
 }catch(error){if(error instanceof Refusal)throw error;throw new Refusal('DISK_OBSERVATION_UNAVAILABLE');}
}

/** Trusted startup configuration only. Workers/model requests cannot choose
 * paths or disable this guard. Absence means disabled, never an invented disk
 * reading. It complements PG admission; statfs is not a quota or an ENOSPC
 * guarantee. Reconcile/stop/cleanup must remain available when disk is low. */
export function diskPolicyFromEnvironment(env:NodeJS.ProcessEnv=process.env):DiskAdmissionPolicy|undefined{
 const raw=env.AC_DISK_ADMISSION_POLICY;if(raw===undefined)return undefined;
 if(raw.length>40000)throw new Refusal('DISK_POLICY_INVALID',400);
 try{return DiskAdmissionPolicy.parse(JSON.parse(raw));}catch{throw new Refusal('DISK_POLICY_INVALID',400);}
}
export class DiskAdmissionGuard implements DiskGuard{
 readonly policy:DiskAdmissionPolicy;
 constructor(raw:DiskAdmissionPolicy){this.policy=DiskAdmissionPolicy.parse(raw);}
 async assertAdmission(additionalReservedBytes=0n){
  if(additionalReservedBytes<0n)throw new Refusal('DISK_RESERVATION_INVALID',400);
  for(const path of this.policy.paths){
   const measurement=await measureDiskCapacity(path);
   if(measurement.availableBytes<additionalReservedBytes+BigInt(this.policy.estimatedWriteBytes)+BigInt(this.policy.minFreeBytes))throw new Refusal('STORAGE_LOW_SPACE');
  }
 }
}
export function diskGuardFromEnvironment():DiskGuard|undefined{
 const policy=diskPolicyFromEnvironment();return policy?new DiskAdmissionGuard(policy):undefined;
}
