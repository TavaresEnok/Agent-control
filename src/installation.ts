import {constants} from 'node:fs';
import {open,mkdir,realpath,stat} from 'node:fs/promises';
import {isAbsolute,join,resolve,sep} from 'node:path';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {Ledger} from './ledger.ts';
import {Operators} from './operator.ts';
import {Refusal,digest} from './contracts.ts';
import {Projects} from './projects.ts';
import {ProjectRoot} from './project-admin.ts';
import {CodexQuotaRegistryConfig} from './codex-quota-registry.ts';
import {NativeBootstrapConfig,nativeBootstrapSchemaError} from './native-bootstrap.ts';
import {InstallationToken} from './installation-authority.ts';
import {RemoteReturnConfig} from './remote-return-config.ts';
import {RemoteDevelopmentConfig} from './remote-development-config.ts';
const origin=()=>z.string().transform(value=>{
 const url=new URL(value);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||
  (url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('UNSAFE_INSTALLATION_ORIGIN');
 return url.origin;
});
const absolute=z.string().refine(isAbsolute,'Absolute path required');
const projectDefinition=z.object({id:z.uuid(),label:z.string().min(1).max(200),repo:absolute,owner:z.string().min(1).max(200)}).strict();
export const Installation=z.object({schemaVersion:z.literal(1),mode:z.literal('administration-only'),
 databaseUrl:z.string().url().refine(value=>['postgres:','postgresql:'].includes(new URL(value).protocol)),
 projectRoots:z.array(ProjectRoot.extend({path:absolute})).max(32).default([]),
 dataDirectory:absolute,project:projectDefinition,projects:z.array(projectDefinition).max(99).default([]),
 contextVault:z.object({directory:absolute,masterFile:absolute}).strict().optional(),
 accountHomesDirectory:absolute.optional(),
 installationAuthority:z.object({mode:z.literal('synthetic-laboratory'),token:InstallationToken}).strict().optional(),
 remoteReturn:RemoteReturnConfig.optional(),
 remoteDevelopment:RemoteDevelopmentConfig.optional(),
 nativeBootstrap:NativeBootstrapConfig.optional(),
 codexQuota:CodexQuotaRegistryConfig.optional(),
 managerTransport:z.object({principal:z.string().min(1).max(200),tokenFile:absolute,machineId:z.string().min(1).max(200),
  contexts:z.array(z.object({projectId:z.uuid(),contextId:z.uuid(),sessionId:z.string().min(1).max(200),profileId:z.string().min(1).max(100),
   keyVersion:z.number().int().positive(),encryptionVariant:z.enum(['legacy','dataKey'])}).strict()).min(1).max(100)}).strict().optional(),
 http:z.object({listen:z.literal('127.0.0.1'),port:z.number().int().min(1024).max(65535),publicOrigin:origin()}).strict(),
 happier:z.object({upstreamOrigin:origin(),webOrigin:origin(),publicServerOrigin:origin()}).strict(),
 sessionMaxAgeSeconds:z.number().int().min(60).max(2592000).default(86400),
}).strict().refine(value=>!value.managerTransport||!!value.contextVault&&new Set(value.managerTransport.contexts.map(x=>x.contextId)).size===value.managerTransport.contexts.length,'Manager transport requires a vault and unique contexts').refine(value=>[value.project,...value.projects].every(p=>value.dataDirectory!==p.repo&&!value.dataDirectory.startsWith(p.repo+sep)),'Credential storage must be outside project repository').refine(value=>{const all=[value.project,...value.projects];return new Set(all.map(p=>p.id)).size===all.length&&new Set(all.map(p=>p.repo)).size===all.length;},'Duplicate project').refine(value=>new Set(value.projectRoots.map(root=>root.id)).size===value.projectRoots.length,'Duplicate project root')
 .refine(value=>!value.contextVault||[value.dataDirectory,value.contextVault.directory,value.contextVault.masterFile].every(path=>resolve(path)===path)&&
  value.contextVault.directory.startsWith(value.dataDirectory+sep)&&value.contextVault.masterFile.startsWith(value.dataDirectory+sep)&&value.contextVault.directory!==value.contextVault.masterFile,'Vault paths must be canonical and inside private data directory')
 .refine(value=>!value.accountHomesDirectory||resolve(value.accountHomesDirectory)===value.accountHomesDirectory&&value.accountHomesDirectory.startsWith(value.dataDirectory+sep)&&
  (!value.contextVault||![value.contextVault.directory,value.contextVault.masterFile].some(path=>path===value.accountHomesDirectory||path.startsWith(value.accountHomesDirectory+sep)||value.accountHomesDirectory!.startsWith(path+sep))),
 'Account homes must be isolated inside private data directory and outside the context vault')
 .refine(value=>!value.remoteReturn||value.remoteReturn.credentials.every(credential=>
  [value.project.repo,...value.projects.map(project=>project.repo),...value.projectRoots.map(root=>root.path)].every(path=>
   credential.path!==resolve(path)&&!credential.path.startsWith(resolve(path)+sep)&&!resolve(path).startsWith(credential.path+sep))),
 'SSH credentials must be outside repositories and authorized project roots')
 .refine(value=>!value.remoteDevelopment||value.remoteDevelopment.projects.every(project=>{
  const roots=[value.project.repo,...value.projects.map(p=>p.repo),...value.projectRoots.map(root=>root.path)].map(path=>resolve(path));
  const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
  return [value.project,...value.projects].some(p=>p.id===project.projectId)&&
   resolve(value.dataDirectory)===value.dataDirectory&&resolve(project.verifierKeyFile)===project.verifierKeyFile&&
   project.verifierKeyFile.startsWith(value.dataDirectory+sep)&&!roots.some(root=>overlaps(project.verifierKeyFile,root))&&
   resolve(project.tmpfsRoot)===project.tmpfsRoot&&!roots.some(root=>overlaps(project.tmpfsRoot,root))&&
   !overlaps(project.tmpfsRoot,value.dataDirectory)&&
   (!value.contextVault||![value.contextVault.directory,value.contextVault.masterFile].some(path=>overlaps(project.tmpfsRoot,resolve(path))))&&
   (!value.accountHomesDirectory||!overlaps(project.tmpfsRoot,resolve(value.accountHomesDirectory)))&&
   value.remoteDevelopment!.transport.credentials.every(credential=>!overlaps(credential.path,project.tmpfsRoot)&&!roots.some(root=>overlaps(credential.path,root)));
 }),'Remote development requires configured projects, private canonical verifier keys and isolated tmpfs/SSH paths')
 .superRefine((value,ctx)=>{const code=nativeBootstrapSchemaError(value);if(code)ctx.addIssue({code:'custom',message:code});});
export type Installation=z.infer<typeof Installation>;
/** No symlink, hard-link, world-readable or foreign-owned credential files. */
export async function readPrivateFile(path:string,maxBytes=65536,options:{canonical?:boolean}={}){
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  if(options.canonical&&(resolve(path)!==path||await realpath(path)!==path||await realpath('/proc/self/fd/'+file.fd)!==path))throw new Refusal('NON_CANONICAL_PRIVATE_FILE',403);
  const info=await file.stat();
  if(!info.isFile()||info.nlink!==1||(info.mode&0o077)!==0||info.uid!==process.getuid?.()||info.size>maxBytes)throw new Refusal('UNSAFE_PRIVATE_FILE',403);
  const bytes=await file.readFile();if(bytes.length>maxBytes){bytes.fill(0);throw new Refusal('PRIVATE_FILE_TOO_LARGE');}return bytes;
 }finally{await file.close();}
}
export async function loadInstallation(path:string){
 const config=Installation.parse(JSON.parse((await readPrivateFile(path)).toString('utf8')));
 for(const root of config.projectRoots){
  if(resolve(root.path)!==root.path||await realpath(root.path)!==root.path||!(await stat(root.path)).isDirectory())throw new Refusal('PROJECT_ROOT_UNAVAILABLE');
 }
 return config;
}
export async function privateDirectory(path:string){
 if(resolve(path)!==path)throw new Refusal('NON_CANONICAL_PRIVATE_DIRECTORY');
 await mkdir(path,{recursive:true,mode:0o700});
 const actual=await realpath(path),info=await stat(path);
 if(actual!==path||!info.isDirectory()||(info.mode&0o077)!==0||info.uid!==process.getuid?.())throw new Refusal('UNSAFE_PRIVATE_DIRECTORY',403);
}
async function createPrivateFile(path:string,bytes:Uint8Array){
 const file=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
}
export async function sessionKey(config:Installation,create=false){
 await privateDirectory(config.dataDirectory);const path=join(config.dataDirectory,'browser-session.key');
 if(create){try{await createPrivateFile(path,randomBytes(32));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}
 const key=await readPrivateFile(path,32);if(key.length!==32)throw new Refusal('INVALID_BROWSER_SESSION_KEY');return key;
}
export async function initializeInstallation(config:Installation,ledger:Ledger){
 await privateDirectory(config.dataDirectory);
 await ledger.migrate();
 await new Projects(ledger).register([config.project,...config.projects],config.project.owner);
 const key=await sessionKey(config,true);key.fill(0);
 return {projectId:config.project.id,mode:config.mode};
}
/** Explicit local operator recovery; never exposed as an unauthenticated HTTP route.
 * Existing operator keys are not revoked and no manager, task or CLI is launched. */
export async function prepareInstallationOperator(config:Installation,ledger:Ledger){
 await privateDirectory(config.dataDirectory);
 const token=randomBytes(32).toString('hex');
 const path=join(config.dataDirectory,'operator-'+digest(config.project.owner)+'-'+randomBytes(8).toString('hex')+'.bootstrap');
 await createPrivateFile(path,Buffer.from(token+'\n'));
 await new Operators(ledger).prepareBootstrap(config.project.owner,config.project.owner,token);
 return {file:path,expiresInSeconds:600};
}
