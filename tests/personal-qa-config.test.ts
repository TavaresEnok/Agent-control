import assert from 'node:assert/strict';
import {chmod,mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {digest,Refusal} from '../src/contracts.ts';
import {NativeQaContract,nativeQaContractDigest} from '../src/native-qa-contract.ts';
import {clearPersonalQaConfig,defaultPersonalQaContract,parsePersonalQaConfig,personalQaContractFromConfig,readPersonalQaConfig,resolvePersonalProjectQa,writePersonalQaConfig} from '../src/personal-qa-config.ts';

const image='sha256:'+'ab'.repeat(32);
const projectId='11111111-1111-4111-8111-111111111111';

test('a project without a QA file keeps today\'s default contract digest',async()=>{
 const fallback=defaultPersonalQaContract(image);
 const literal=NativeQaContract.parse({schemaVersion:1,id:'personal-qa',image,argv:fallback.argv,environment:['PATH=/usr/local/bin:/usr/bin:/bin'],timeoutMs:120000,memoryBytes:268435456,pids:64,nanoCpus:500000000});
 assert.deepEqual(fallback,literal);
 assert.equal('prepareArgv' in fallback,false);
 assert.equal(nativeQaContractDigest(fallback),digest({contract:'native-qa-v1',definition:literal}));
 const directory=await mkdtemp(join(tmpdir(),'qa-config-'));
 try{
  const resolved=await resolvePersonalProjectQa({dataDirectory:resolve(directory),projectId,image,fallback});
  assert.equal(nativeQaContractDigest(resolved),nativeQaContractDigest(fallback));
  assert.equal(resolved,fallback);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('QA configuration rejects shell text, an unknown program and a timeout outside 30..1800',()=>{
 assert.throws(()=>parsePersonalQaConfig({test:'npm test'}),(error:unknown)=>error instanceof Refusal&&error.code==='QA_CONFIG_NOT_A_LIST');
 assert.throws(()=>parsePersonalQaConfig({test:'npm test && rm -rf /'}),(error:unknown)=>error instanceof Refusal&&error.code==='QA_CONFIG_NOT_A_LIST');
 assert.throws(()=>parsePersonalQaConfig({prepare:'pnpm install',test:['npm','test']}),(error:unknown)=>error instanceof Refusal&&error.code==='QA_CONFIG_NOT_A_LIST');
 assert.throws(()=>parsePersonalQaConfig({test:['bash','-lc','npm test']}),(error:unknown)=>error instanceof Refusal&&error.code==='QA_COMMAND_NOT_ALLOWED');
 assert.throws(()=>parsePersonalQaConfig({test:['/usr/bin/npm','test']}),(error:unknown)=>error instanceof Refusal&&error.code==='QA_COMMAND_NOT_ALLOWED');
 assert.throws(()=>parsePersonalQaConfig({test:['npm','test'],timeoutSeconds:29}),(error:unknown)=>error instanceof Refusal&&error.code==='QA_TIMEOUT_OUT_OF_RANGE');
 assert.throws(()=>parsePersonalQaConfig({test:['npm','test'],timeoutSeconds:1801}),(error:unknown)=>error instanceof Refusal&&error.code==='QA_TIMEOUT_OUT_OF_RANGE');
 const config=parsePersonalQaConfig({prepare:['corepack','pnpm','install','--frozen-lockfile'],test:['corepack','pnpm','--filter','@ispagent/shared','test'],timeoutSeconds:600});
 assert.equal(config.timeoutSeconds,600);
 const contract=personalQaContractFromConfig(projectId,image,config,name=>'/usr/local/bin/'+name);
 assert.equal(contract.id,'personal-qa-'+projectId);
 assert.deepEqual(contract.argv,['/usr/local/bin/corepack','pnpm','--filter','@ispagent/shared','test']);
 assert.deepEqual(contract.prepareArgv,['/usr/local/bin/corepack','pnpm','install','--frozen-lockfile']);
 assert.equal(contract.environment.includes('npm_config_cache=/cache/npm'),true);
 assert.equal('services' in contract,false);
 assert.notEqual(nativeQaContractDigest(contract),nativeQaContractDigest(defaultPersonalQaContract(image)));
});

test('postgres services enter the contract digest and a project without them keeps today\'s digest',()=>{
 const fallback=defaultPersonalQaContract(image);
 const plain=parsePersonalQaConfig({test:['npm','test']});
 const without=personalQaContractFromConfig(projectId,image,plain,name=>'/usr/bin/'+name);
 assert.equal('services' in without,false);
 assert.equal('services' in fallback,false);
 assert.equal(nativeQaContractDigest(fallback),digest({contract:'native-qa-v1',definition:fallback}));
 assert.throws(()=>parsePersonalQaConfig({test:['npm','test'],services:'postgres'}),(error:unknown)=>error instanceof Refusal&&error.code==='QA_SERVICES_INVALID');
 assert.throws(()=>parsePersonalQaConfig({test:['npm','test'],services:{postgres:{image:'postgres:18-alpine',database:'qa_test'}}}),(error:unknown)=>error instanceof Refusal&&error.code==='QA_SERVICES_INVALID');
 assert.throws(()=>parsePersonalQaConfig({test:['npm','test'],services:{postgres:{image:'postgres:16-alpine',database:'QA-TEST'}}}),(error:unknown)=>error instanceof Refusal&&error.code==='QA_SERVICES_INVALID');
 assert.throws(()=>parsePersonalQaConfig({test:['npm','test'],services:{postgres:{image:'postgres:16-alpine',database:'qa_test',password:'secret'}}}),(error:unknown)=>error instanceof Refusal&&error.code==='QA_SERVICES_INVALID');
 const config=parsePersonalQaConfig({test:['npm','test'],services:{postgres:{image:'postgres:16-alpine',database:'qa_test'}}});
 const contract=personalQaContractFromConfig(projectId,image,config,name=>'/usr/bin/'+name);
 assert.deepEqual(contract.services,{postgres:{image:'postgres:16-alpine',database:'qa_test'}});
 assert.equal(JSON.stringify(contract).includes('password'),false);
 assert.equal(JSON.stringify(contract).includes('secret'),false);
 const digested=nativeQaContractDigest(contract);
 assert.equal(digested,digest({contract:'native-qa-v1',definition:contract}));
 assert.notEqual(digested,nativeQaContractDigest(without));
 assert.equal(digested.includes('qa_test'),false);
 assert.equal(canonicalIncludes(contract,'postgres:16-alpine'),true);
 assert.equal(canonicalIncludes(contract,'qa_test'),true);
});

function canonicalIncludes(value:unknown,text:string){return JSON.stringify(value).includes(text);}

test('the QA file is stored mode 600 and clear removes it',async()=>{
 const directory=resolve(await mkdtemp(join(tmpdir(),'qa-file-')));
 const id=randomUUID();
 try{
  const path=await writePersonalQaConfig(directory,id,{prepare:['npm','ci'],test:['npm','test'],timeoutSeconds:30});
  assert.equal((await stat(path)).mode&0o777,0o600);
  assert.equal((await stat(join(directory,'qa'))).mode&0o777,0o700);
  const read=await readPersonalQaConfig(directory,id);
  assert.deepEqual(read,{prepare:['npm','ci'],test:['npm','test'],timeoutSeconds:30});
  await chmod(path,0o644);
  await assert.rejects(()=>readPersonalQaConfig(directory,id));
  await chmod(path,0o600);
  await clearPersonalQaConfig(directory,id);
  assert.equal(await readPersonalQaConfig(directory,id),null);
 }finally{await rm(directory,{recursive:true,force:true});}
});
