import { randomUUID } from 'node:crypto';
import { Capacity } from '../../src/capacity.ts';
import type { Ledger } from '../../src/ledger.ts';
// Fixtures only: never infer a real provider or production capacity from these defaults.
export async function provisionCapacity(ledger: Ledger, principal: string, projectId: string) {
  const service=new Capacity(ledger), admin='synthetic-capacity-administrator';
  await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1) ON CONFLICT DO NOTHING',[admin]);
  await service.configure(admin,{programmingLimit:128,evaluationLimit:128});
  await service.registerModel(admin,{provider:'synthetic',model:'fixed-worker-v1',efforts:['medium'],roles:['programmer'],source:'synthetic://fixture'});
  const accountId=randomUUID(), profileId=randomUUID();
  await service.addAccount(principal,projectId,{id:accountId,provider:'synthetic',label:'Isolated fixed worker',resourceIdentity:'fixture-'+accountId,
    mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://fixed-worker',maxConcurrent:2});
  await service.addProfile(principal,projectId,{id:profileId,accountId,model:'fixed-worker-v1',effort:'medium',role:'programmer'});
  await service.observeQuota(principal,accountId,{status:'available',source:'synthetic://fixture',ttlSeconds:3600});
  const revision=await service.publish(principal,projectId,0,{schemaVersion:1,maxProgrammersPerContext:10,maxEvaluatorsPerContext:2,
    roles:{programmer:{regular:[profileId],emergency:[]}}});
  return {service,revision};
}
