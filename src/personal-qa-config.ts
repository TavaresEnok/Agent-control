import {execFile} from 'node:child_process';
import {chmod,mkdir,rename,unlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {readPrivateFile} from './installation.ts';
import type {Ledger} from './ledger.ts';
import {NativeQaContract,QaServices,type NativeQaContract as NativeQaContractValue} from './native-qa-contract.ts';
import {nativeReviewVerifierDigest} from './native-review-contract.ts';
import {QualityPolicies,QualityPolicy} from './quality-policy.ts';

/** Default personal QA. It runs in the tools image with no network and a read-only checkout, so it
 * cannot install dependencies; it checks what needs none: no merge-conflict markers, every JSON
 * file parses and every plain JavaScript file passes `node --check`. */
export const defaultPersonalQaScript=[
 "const fs=require('fs'),path=require('path'),cp=require('child_process');",
 "const skip=new Set(['.git','node_modules','dist','build','vendor','.ai']);let bad=0,seen=0;",
 "const fail=(file,why)=>{bad++;console.log('QA_FAIL '+file+': '+why);};",
 "(function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){",
 " const file=path.join(dir,entry.name);",
 " if(entry.isDirectory()){if(!skip.has(entry.name))walk(file);continue;}",
 " if(!entry.isFile()||fs.statSync(file).size>1048576||++seen>20000)continue;",
 " const text=fs.readFileSync(file,'utf8');if(text.includes('\\u0000'))continue;",
 " if(/^(<{7} |>{7} )/m.test(text))fail(file,'merge conflict marker');",
 " if(/\\.json$/.test(entry.name)&&!/^(tsconfig|jsconfig)[^/]*\\.json$/.test(entry.name)&&!/[\\\\/]\\.vscode[\\\\/]/.test(file)){try{JSON.parse(text);}catch(error){fail(file,'invalid JSON');}}",
 " if(/\\.(js|mjs|cjs)$/.test(entry.name)){const run=cp.spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(run.status!==0)fail(file,'syntax error');}",
 "}})('/work');",
 "console.log('QA files checked: '+seen+', failures: '+bad);process.exit(bad?1:0);",
].join('\n');

export const QA_BINARIES=['npm','npx','pnpm','corepack','yarn','node','make','sh'] as const;
/** Cache variables for a configured project. Absent from the default contract, so its digest stays put. */
export const personalQaCacheEnvironment=[
 'PATH=/usr/local/bin:/usr/bin:/bin','HOME=/cache/home','npm_config_cache=/cache/npm','PNPM_HOME=/cache/pnpm','COREPACK_HOME=/cache/corepack','XDG_CACHE_HOME=/cache/xdg',
] as const;

const command=z.array(z.string().min(1).max(4096).refine(value=>!/[\0\r\n]/.test(value))).min(1).max(64).superRefine((argv,ctx)=>{
 if(!(QA_BINARIES as readonly string[]).includes(argv[0]!))ctx.addIssue({code:'custom',message:'QA_COMMAND_NOT_ALLOWED'});
});
const PersonalQaFile=z.object({
 prepare:command.optional(),test:command,timeoutSeconds:z.number().int().min(30).max(1800).default(600),
 services:QaServices.optional(),
}).strict();
export type PersonalQaConfig=z.infer<typeof PersonalQaFile>;

/** The contract written into nativeBootstrap when a project has no qa/<projectId>.json. */
export function defaultPersonalQaContract(image:string,argv?:string[]){
 return NativeQaContract.parse({schemaVersion:1,id:'personal-qa',image,argv:argv??['/usr/local/bin/node','-e',defaultPersonalQaScript],
  environment:['PATH=/usr/local/bin:/usr/bin:/bin'],timeoutMs:120000,memoryBytes:268435456,pids:64,nanoCpus:500000000});
}

export function parsePersonalQaConfig(input:unknown):PersonalQaConfig{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Refusal('QA_CONFIG_INVALID');
 const raw=input as Record<string,unknown>;
 for(const key of ['prepare','test'] as const){
  if(raw[key]===undefined)continue;
  if(typeof raw[key]==='string'||!Array.isArray(raw[key]))throw new Refusal('QA_CONFIG_NOT_A_LIST');
 }
 if(raw.test===undefined)throw new Refusal('QA_CONFIG_TEST_REQUIRED');
 if(raw.timeoutSeconds!==undefined&&(typeof raw.timeoutSeconds!=='number'||!Number.isInteger(raw.timeoutSeconds)||raw.timeoutSeconds<30||raw.timeoutSeconds>1800))throw new Refusal('QA_TIMEOUT_OUT_OF_RANGE');
 if(raw.services!==undefined&&(typeof raw.services!=='object'||raw.services===null||Array.isArray(raw.services)))throw new Refusal('QA_SERVICES_INVALID');
 const parsed=PersonalQaFile.safeParse(raw);
 if(!parsed.success){
  if(parsed.error.issues.some(issue=>issue.path[0]==='services'))throw new Refusal('QA_SERVICES_INVALID');
  if(parsed.error.issues.some(issue=>issue.message==='QA_COMMAND_NOT_ALLOWED'))throw new Refusal('QA_COMMAND_NOT_ALLOWED');
  if(parsed.error.issues.some(issue=>issue.path[0]==='timeoutSeconds'))throw new Refusal('QA_TIMEOUT_OUT_OF_RANGE');
  if(parsed.error.issues.some(issue=>(issue.path[0]==='test'||issue.path[0]==='prepare')))throw new Refusal('QA_CONFIG_NOT_A_LIST');
  throw new Refusal('QA_CONFIG_INVALID');
 }
 return parsed.data;
}

export function personalQaConfigPath(dataDirectory:string,projectId:string){
 if(!z.uuid().safeParse(projectId).success||resolve(dataDirectory)!==dataDirectory)throw new Refusal('QA_PROJECT_INVALID');
 return join(dataDirectory,'qa',projectId+'.json');
}

export async function readPersonalQaConfig(dataDirectory:string,projectId:string){
 try{return parsePersonalQaConfig(JSON.parse((await readPrivateFile(personalQaConfigPath(dataDirectory,projectId))).toString('utf8')));}
 catch(error){
  const code=(error as NodeJS.ErrnoException).code;
  if(code==='ENOENT')return null;
  throw error;
 }
}

export async function writePersonalQaConfig(dataDirectory:string,projectId:string,config:PersonalQaConfig){
 const path=personalQaConfigPath(dataDirectory,projectId),directory=join(dataDirectory,'qa'),temporary=path+'.tmp';
 await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
 const body=JSON.stringify(parsePersonalQaConfig(config))+'\n';
 await writeFile(temporary,body,{mode:0o600});await chmod(temporary,0o600);await rename(temporary,path);await chmod(path,0o600);
 return path;
}

export async function clearPersonalQaConfig(dataDirectory:string,projectId:string){
 await unlink(personalQaConfigPath(dataDirectory,projectId)).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});
}

/** Absolute paths come from the tools image. The stored file keeps the simple names. */
export function personalQaContractFromConfig(projectId:string,image:string,config:PersonalQaConfig,resolveName:(name:string)=>string):NativeQaContractValue{
 if(!z.uuid().safeParse(projectId).success)throw new Refusal('QA_PROJECT_INVALID');
 const absolute=(argv:string[])=>{
  const bin=resolveName(argv[0]!);
  if(!bin.startsWith('/')||bin.includes('\0')||bin.includes('\n'))throw new Refusal('QA_COMMAND_NOT_IN_IMAGE');
  return [bin,...argv.slice(1)];
 };
 return NativeQaContract.parse({schemaVersion:1,id:'personal-qa-'+projectId,image,argv:absolute(config.test),
  ...(config.prepare?{prepareArgv:absolute(config.prepare)}:{}),...(config.services?{services:config.services}:{}),environment:[...personalQaCacheEnvironment],
  // Installing and testing a real project needs more room than the default syntax check.
  timeoutMs:config.timeoutSeconds*1000,memoryBytes:2147483648,pids:256,nanoCpus:2000000000});
}

const imageLookup=promisify(execFile);
const lookupScript=[
 "const fs=require('fs');const n=process.argv[1];",
 "if(!/^(npm|npx|pnpm|corepack|yarn|node|make|sh)$/.test(n))process.exit(2);",
 "for(const d of ['/usr/local/bin','/usr/bin','/bin']){const p=d+'/'+n;try{fs.accessSync(p,fs.constants.X_OK);process.stdout.write(p);process.exit(0);}catch{}}",
 "process.exit(1);",
].join('');
/** Resolves one allowlisted name on the tools image PATH. The container has no network and no host environment. */
export async function resolveImageExecutable(image:string,name:string){
 if(!(QA_BINARIES as readonly string[]).includes(name)||!/^sha256:[a-f0-9]{64}$/.test(image))throw new Refusal('QA_COMMAND_NOT_ALLOWED');
 let stdout='';
 try{stdout=(await imageLookup('docker',['run','--rm','--network','none','--user','10001:10001','--entrypoint','/usr/local/bin/node',image,'-e',lookupScript,name],{encoding:'utf8',timeout:30000})).stdout.trim();}
 catch{throw new Refusal('QA_COMMAND_NOT_IN_IMAGE');}
 if(!stdout.startsWith('/')||stdout.includes('\n'))throw new Refusal('QA_COMMAND_NOT_IN_IMAGE');
 return stdout;
}

export async function resolvePersonalProjectQa(options:{dataDirectory:string;projectId:string;image:string;fallback:NativeQaContractValue;resolveExecutable?:(image:string,name:string)=>Promise<string>}){
 const config=await readPersonalQaConfig(options.dataDirectory,options.projectId);
 if(!config)return options.fallback;
 const resolveExecutable=options.resolveExecutable??resolveImageExecutable;
 const names=[...new Set([config.test[0]!,...(config.prepare?[config.prepare[0]!]:[])])];
 const paths=new Map<string,string>();
 for(const name of names)paths.set(name,await resolveExecutable(options.image,name));
 return personalQaContractFromConfig(options.projectId,options.image,config,name=>paths.get(name)!);
}

/** Keeps one project's quality policy on the QA contract it will actually run. */
export async function syncPersonalQaPolicy(ledger:Ledger,owner:string,projectId:string,qaDigest:string){
 const latest=(await ledger.pool.query('SELECT revision,snapshot FROM ac_quality_policies WHERE project_id=$1 ORDER BY revision DESC LIMIT 1',[projectId])).rows[0];
 const base=latest?QualityPolicy.parse(latest.snapshot):QualityPolicy.parse({schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false});
 if(base.verifierDigest!==nativeReviewVerifierDigest||base.qaVerifierDigest!==qaDigest)
  await new QualityPolicies(ledger).publish(owner,projectId,Number(latest?.revision??0),{...base,verifierDigest:nativeReviewVerifierDigest,qaVerifierDigest:qaDigest});
}
