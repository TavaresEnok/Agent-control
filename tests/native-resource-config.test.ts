import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rename,rm,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {NativeResourceConfiguration,nativeResourceConfigurationError,prepareNativeResourceAttachment,envelopeForRoot} from '../src/native-resource-config.ts';

async function fixture(){
 const area=await mkdtemp(join(tmpdir(),'ac-resource-config-')),data=join(area,'data');await mkdir(data,{mode:0o700});
 const roots={planning:join(data,'plan'),execution:join(data,'exec'),qa:join(data,'qa')};for(const path of Object.values(roots))await mkdir(path,{mode:0o700});
 const databaseInstallationId=randomUUID();
 const raw={state:'configured-inactive' as const,contract:'native-resource-authority-configured-v1' as const,databaseInstallationId,authority:{installationId:'separate-lab-identity',authorityEpoch:1,resourceAuthority:{authorityId:'ac-r3-resources-config-fixture',anchorId:'a'.repeat(64),cpuQuotaMicros:50000,cpuPeriodMicros:100000,memoryBytes:67108864,pidsLimit:32,maxJobs:3}},roots};
 return {area,data,raw};
}
test('inactive resource configuration rejects absent identities, malformed limits and unsafe root policy',async()=>{
 const {area,data,raw}=await fixture();try{
  const config=NativeResourceConfiguration.parse(raw),scope={dataDirectory:data,planningRoot:config.roots.planning,executionRoot:config.roots.execution,protectedPaths:[join(data,'accounts'),join(data,'vault'),join(area,'repo')]};
  assert.equal(nativeResourceConfigurationError(config,scope),undefined);
  for(const field of ['databaseInstallationId','authority'] as const){const changed={...raw};delete (changed as Record<string,unknown>)[field];assert.throws(()=>NativeResourceConfiguration.parse(changed));}
  assert.throws(()=>NativeResourceConfiguration.parse({...raw,authority:{...raw.authority,installationId:''}}));
  for(const limits of [{maxJobs:0},{pidsLimit:3},{memoryBytes:1},{cpuQuotaMicros:-1},{cpuPeriodMicros:0}])assert.throws(()=>NativeResourceConfiguration.parse({...raw,authority:{...raw.authority,resourceAuthority:{...raw.authority.resourceAuthority,...limits}}}));
  for(const path of ['relative/path',join(data,'qa')+'/../escape',data+'/docker.sock/private'])assert.throws(()=>NativeResourceConfiguration.parse({...raw,roots:{...raw.roots,qa:path}}));
  assert.throws(()=>NativeResourceConfiguration.parse({...raw,roots:{...raw.roots,qa:raw.roots.execution+'/nested'}}));
  assert.equal(nativeResourceConfigurationError({...config,roots:{...config.roots,qa:join(area,'outside')}},scope),'NATIVE_RESOURCE_ROOT_FORBIDDEN');
  assert.equal(nativeResourceConfigurationError({...config,roots:{...config.roots,qa:join(data,'vault','nested')}},scope),'NATIVE_RESOURCE_ROOT_FORBIDDEN');
  assert.equal(nativeResourceConfigurationError(config,{...scope,planningRoot:join(data,'different')}),'NATIVE_RESOURCE_SUPERVISOR_ROOT_MISMATCH');
  await assert.rejects(prepareNativeResourceAttachment(config,randomUUID()),/NATIVE_RESOURCE_DATABASE_IDENTITY_MISMATCH/);
 }finally{await rm(area,{recursive:true,force:true});}
});
test('resource factory preserves distinct identities and refuses substituted private roots or JSON attachments',async()=>{
 const {area,raw}=await fixture();try{
  const attached=await prepareNativeResourceAttachment(raw,raw.databaseInstallationId);
  const projected=JSON.stringify(attached);for(const value of [raw.databaseInstallationId,raw.authority.installationId,raw.authority.resourceAuthority.authorityId,raw.authority.resourceAuthority.anchorId,...Object.values(raw.roots)])assert(!projected.includes(value));
  assert.equal(attached.report.physicalVerification,'not-requested');assert.equal(attached.report.executionEnabled,false);
  for(const kind of ['planning','execution','qa'] as const){const envelope=await envelopeForRoot(attached,kind);assert.equal(envelope.stateRoot,raw.roots[kind]);assert.equal(envelope.installationId,'separate-lab-identity');assert(Object.isFrozen(envelope.resourceAuthority));}
  await assert.rejects(envelopeForRoot(JSON.parse(projected),'qa'),/NATIVE_RESOURCE_ATTACHMENT_INVALID/);
  raw.authority.resourceAuthority.maxJobs=999;assert.equal((await envelopeForRoot(attached,'qa')).resourceAuthority.maxJobs,3,'caller mutation cannot retarget a prepared authority');
  const previous=raw.roots.qa+'-original';await rename(raw.roots.qa,previous);await symlink(previous,raw.roots.qa);await assert.rejects(envelopeForRoot(attached,'qa'),/NATIVE_RESOURCE_ROOT_UNSAFE/);
  await rm(raw.roots.qa);await mkdir(raw.roots.qa,{mode:0o700});await assert.rejects(envelopeForRoot(attached,'qa'),/NATIVE_RESOURCE_ROOT_IDENTITY_CHANGED/);
  await chmod(raw.roots.execution,0o755);await assert.rejects(envelopeForRoot(attached,'execution'),/NATIVE_RESOURCE_ROOT_UNSAFE/);
 }finally{await rm(area,{recursive:true,force:true});}
});
