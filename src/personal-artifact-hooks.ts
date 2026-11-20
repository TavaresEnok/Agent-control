import {join} from 'node:path';
import {readPrivateFile, type Installation} from './installation.ts';
import {closeRound,registerRoundTemp,type RetentionDeps} from './personal-artifact-retention.ts';

/**
 * Registration of round temporaries by the code that creates them (module snapshots, evidence folders).
 *
 * The producers know only the data directory of the installation and the project; they never hold the whole
 * `Installation`. `registerRoundTemp` and `closeRound` read exactly two things from it: `dataDirectory` (where the
 * private registry lives) and the project ids. The same removal later runs with the real `Installation`, which judges
 * every entry again (project membership, directory identity, owner marker, round end, idle time, processes, containers).
 *
 * Registration is best effort by design: a failure to record a temporary must never fail the examination that creates it.
 * An unrecorded directory is simply never removed; retention reports how many such `ac-*` items it preserved.
 */

export type RoundScope={dataDirectory:string;projectId:string;roundId:string};

/** Minimal structural view of an installation, enough for the registry calls above and nothing else. */
function scopeInstallation(scope:Pick<RoundScope,'dataDirectory'|'projectId'>):Installation{
 return {activation:'personal',dataDirectory:scope.dataDirectory,project:{id:scope.projectId,label:'retention',repo:'/',owner:'retention'},projects:[]} as unknown as Installation;
}

/** Records `path` (a direct child of the temporary root) as owned by the round. Returns whether it was recorded. */
export async function trackRoundTemp(scope:RoundScope,path:string,deps:RetentionDeps={}):Promise<boolean>{
 try{
  await registerRoundTemp(scopeInstallation(scope),{projectId:scope.projectId,roundId:scope.roundId,path},deps);
  return true;
 }catch{return false;}
}

/** Whether the private registry holds a temporary of this round. Unreadable or absent registry: no. Read only, never creates anything. */
async function roundHasTemps(scope:RoundScope):Promise<boolean>{
 try{
  const bytes=await readPrivateFile(join(scope.dataDirectory,'artifact-retention','registry.json'),4*1024*1024,{canonical:true});
  try{
   const parsed=JSON.parse(bytes.toString('utf8')) as {temps?:{projectId?:unknown;roundId?:unknown}[]};
   return Array.isArray(parsed.temps)&&parsed.temps.some(item=>item.projectId===scope.projectId&&item.roundId===scope.roundId);
  }finally{bytes.fill(0);}
 }catch{return false;}
}

/** Records that the round ended. Call it only where the product itself proved the end (terminal run state).
 * A round that recorded no temporary is not written down: the registry keeps one line per round, so only rounds that
 * can ever own something are worth a line. Returns whether a round end was recorded. */
export async function endRound(scope:RoundScope,deps:RetentionDeps={}):Promise<boolean>{
 try{
  if(!await roundHasTemps(scope))return false;
  await closeRound(scopeInstallation(scope),{projectId:scope.projectId,roundId:scope.roundId},deps);
  return true;
 }catch{return false;}
}
