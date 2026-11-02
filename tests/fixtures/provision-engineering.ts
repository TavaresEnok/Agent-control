import { randomUUID,randomBytes,createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Capacity } from '../../src/capacity.ts';
import { GitArtifacts } from '../../src/git.ts';
import { Quality } from '../../src/quality.ts';
import type { Ledger } from '../../src/ledger.ts';
import type { EngineeringOptions } from '../../src/engineering.ts';
export async function provisionEngineering(ledger:Ledger,principal:string,projectId:string,repo:string,requiredReviews=1,requireJudge=false):Promise<{revision:number;options:EngineeringOptions}>{
 const service=new Capacity(ledger),admin='synthetic-engineering-admin';
 await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1) ON CONFLICT DO NOTHING',[admin]);
 await service.configure(admin,{programmingLimit:128,evaluationLimit:128});
 const accountId=randomUUID();
 await service.addAccount(principal,projectId,{id:accountId,provider:'synthetic-engineering',label:'Fixed engineering executors',resourceIdentity:'fixture-'+accountId,
  mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://fixed-engineering',maxConcurrent:4});
 await service.observeQuota(principal,accountId,{status:'available',source:'synthetic://fixture',ttlSeconds:3600});
 const profiles={programmer:randomUUID(),qa:randomUUID(),reviewer:randomUUID(),judge:randomUUID()};
 for(const role of ['programmer','qa','reviewer','judge'] as const){
  await service.registerModel(admin,{provider:'synthetic-engineering',model:'fixed-'+role,efforts:['medium'],roles:[role],source:'synthetic://fixture'});
  await service.addProfile(principal,projectId,{id:profiles[role],accountId,model:'fixed-'+role,effort:'medium',role});
 }
 const revision=await service.publish(principal,projectId,0,{schemaVersion:1,maxProgrammersPerContext:10,maxEvaluatorsPerContext:2,
  roles:{programmer:{regular:[profiles.programmer],emergency:[]},qa:{regular:[profiles.qa],emergency:[]},reviewer:{regular:[profiles.reviewer],emergency:[]},judge:{regular:[profiles.judge],emergency:[]}}});
 const verifierKey=randomBytes(32),git=new GitArtifacts(repo),quality=new Quality(ledger,verifierKey,git);
 const verifierDigest=createHash('sha256').update(await readFile(new URL('../../scripts/synthetic-verifier.mjs',import.meta.url))).digest('hex');
 const qualityRevision=await quality.publish(principal,projectId,0,{schemaVersion:1,requiredReviews,allowLowRiskQaWaiver:false,requireHumanIntegration:false,verifierDigest,requireJudge});
 return {revision,options:{quality,git,qualityRevision,targetRef:'refs/heads/protected',verifierKey}};
}
