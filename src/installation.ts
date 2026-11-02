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
 http:z.object({listen:z.literal('127.0.0.1'),port:z.number().int().min(1024).max(65535),publicOrigin:origin()}).strict(),
 happier:z.object({upstreamOrigin:origin(),webOrigin:origin(),publicServerOrigin:origin()}).strict(),
 sessionMaxAgeSeconds:z.number().int().min(60).max(2592000).default(86400),
}).strict().refine(value=>[value.project,...value.projects].every(p=>value.dataDirectory!==p.repo&&!value.dataDirectory.startsWith(p.repo+sep)),'Credential storage must be outside project repository').refine(value=>{const all=[value.project,...value.projects];return new Set(all.map(p=>p.id)).size===all.length&&new Set(all.map(p=>p.repo)).size===all.length;},'Duplicate project').refine(value=>new Set(value.projectRoots.map(root=>root.id)).size===value.projectRoots.length,'Duplicate project root');
export type Installation=z.infer<typeof Installation>;
/** No symlink, hard-link, world-readable or foreign-owned credential files. */
export async function readPrivateFile(path:string,maxBytes=65536){
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const info=await file.stat();
  if(!info.isFile()||info.nlink!==1||(info.mode&0o077)!==0||info.uid!==process.getuid?.()||info.size>maxBytes)throw new Refusal('UNSAFE_PRIVATE_FILE',403);
  const bytes=await file.readFile();if(bytes.length>maxBytes)throw new Refusal('PRIVATE_FILE_TOO_LARGE');return bytes;
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
