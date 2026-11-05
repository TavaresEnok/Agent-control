import {lstat,realpath} from 'node:fs/promises';
import {dirname,basename,resolve,sep} from 'node:path';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {NativeResourceEnvelope} from './native-resource-envelope.ts';

const root=z.string().min(1).max(4096).refine(path=>resolve(path)===path&&!/[\x00\r\n]/.test(path)&&!path.includes('docker.sock'),'NATIVE_RESOURCE_ROOT_INVALID');
const overlaps=(left:string,right:string)=>left===right||left.startsWith(right+sep)||right.startsWith(left+sep);
const Authority=NativeResourceEnvelope.omit({stateRoot:true}).extend({installationId:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/)});
/** Inactive configuration is a mapping, never proof that a host group exists.
 * The authority's laboratory identity and database identity are distinct fields. */
export const NativeResourceConfiguration=z.object({
 state:z.literal('configured-inactive'),contract:z.literal('native-resource-authority-configured-v1'),
 databaseInstallationId:z.uuid(),authority:Authority,
 roots:z.object({planning:root,execution:root,qa:root}).strict(),
}).strict().superRefine((value,ctx)=>{
 const paths=Object.values(value.roots);
 if(paths.some((path,i)=>paths.some((other,j)=>i!==j&&overlaps(path,other))))ctx.addIssue({code:'custom',message:'NATIVE_RESOURCE_ROOTS_OVERLAP'});
});
export type NativeResourceConfiguration=z.infer<typeof NativeResourceConfiguration>;
export type NativeResourceKind=keyof NativeResourceConfiguration['roots'];
export type NativeResourceConfigurationReport={state:'configured-inactive';physicalVerification:'not-requested';databaseIdentity:'verified';executionEnabled:false;
 limits:Omit<NativeResourceEnvelope['resourceAuthority'],'authorityId'|'anchorId'>};
export type NativeResourceAttachment=Readonly<{report:NativeResourceConfigurationReport;envelopeForRoot(kind:NativeResourceKind):Promise<NativeResourceEnvelope>}>;
const issued=new WeakSet<object>();
function frozen<T>(value:T):T{if(value&&typeof value==='object'){for(const item of Object.values(value))frozen(item);Object.freeze(value);}return value;}

/** Pure schema policy; no filesystem, provisioning, Docker or network access. */
export function nativeResourceConfigurationError(value:NativeResourceConfiguration,scope:{dataDirectory:string;planningRoot:string;executionRoot:string;protectedPaths:readonly string[]}):string|undefined{
 if(resolve(scope.dataDirectory)!==scope.dataDirectory||scope.protectedPaths.some(path=>resolve(path)!==path))return 'NATIVE_RESOURCE_ROOT_FORBIDDEN';
 if(value.roots.planning!==scope.planningRoot||value.roots.execution!==scope.executionRoot)return 'NATIVE_RESOURCE_SUPERVISOR_ROOT_MISMATCH';
 if(Object.values(value.roots).some(path=>!path.startsWith(scope.dataDirectory+sep)||scope.protectedPaths.some(other=>overlaps(path,other))))return 'NATIVE_RESOURCE_ROOT_FORBIDDEN';
 return undefined;
}
async function directory(path:string){
 try{const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o7777)!==0o700||await realpath(path)!==path)throw new Refusal('NATIVE_RESOURCE_ROOT_UNSAFE',403);
  return {device:info.dev,inode:info.ino};
 }catch(error){if(error instanceof Refusal)throw error;throw new Refusal('NATIVE_RESOURCE_ROOT_UNSAFE',403);}
}
async function protectedPath(path:string){
 const suffix:string[]=[];let current=path;
 for(;;){try{const canonical=resolve(await realpath(current),...suffix);if(canonical!==path)throw new Refusal('NATIVE_RESOURCE_PROTECTED_PATH_UNSAFE',403);return;}
  catch(error){if(error instanceof Refusal)throw error;if((error as NodeJS.ErrnoException).code!=='ENOENT'||dirname(current)===current)throw new Refusal('NATIVE_RESOURCE_PROTECTED_PATH_UNSAFE',403);suffix.unshift(basename(current));current=dirname(current);}
 }
}
export function assertNativeResourceAttachment(value:NativeResourceAttachment){if(!issued.has(value))throw new Refusal('NATIVE_RESOURCE_ATTACHMENT_INVALID',403);}
/** Caller supplies the actual database singleton identity read by the trusted
 * bootstrap. No authority label is inferred from it and no host RPC runs here. */
export async function prepareNativeResourceAttachment(raw:NativeResourceConfiguration,actualDatabaseInstallationId:string,scope:{protectedPaths:readonly string[]}={protectedPaths:[]}):Promise<NativeResourceAttachment>{
 const config=frozen(NativeResourceConfiguration.parse(raw));
 if(!z.uuid().safeParse(actualDatabaseInstallationId).success||config.databaseInstallationId!==actualDatabaseInstallationId)throw new Refusal('NATIVE_RESOURCE_DATABASE_IDENTITY_MISMATCH',403);
 const protectedPaths=Object.freeze([...scope.protectedPaths]);
 const assertProtected=async()=>{for(const path of protectedPaths){if(resolve(path)!==path||Object.values(config.roots).some(root=>overlaps(root,path)))throw new Refusal('NATIVE_RESOURCE_ROOT_FORBIDDEN',403);await protectedPath(path);}};
 await assertProtected();
 const identities={} as Record<NativeResourceKind,Awaited<ReturnType<typeof directory>>>;
 for(const kind of ['planning','execution','qa'] as const)identities[kind]=await directory(config.roots[kind]);
 const {authorityId:_authority,anchorId:_anchor,...limits}=config.authority.resourceAuthority;
 const report=frozen<NativeResourceConfigurationReport>({state:'configured-inactive',physicalVerification:'not-requested',databaseIdentity:'verified',executionEnabled:false,limits});
 const attachment=frozen<NativeResourceAttachment>({report,envelopeForRoot:async kind=>{
  if(!['planning','execution','qa'].includes(kind))throw new Refusal('NATIVE_RESOURCE_SUPERVISOR_INVALID');
  await assertProtected();
  const current=await directory(config.roots[kind]),previous=identities[kind];
  if(current.device!==previous.device||current.inode!==previous.inode)throw new Refusal('NATIVE_RESOURCE_ROOT_IDENTITY_CHANGED',403);
  return frozen(NativeResourceEnvelope.parse({...config.authority,stateRoot:config.roots[kind]}));
 }});
 issued.add(attachment);return attachment;
}
/** Explicit trusted factory boundary; serialization cannot reconstruct it. */
export async function envelopeForRoot(attachment:NativeResourceAttachment,kind:NativeResourceKind){assertNativeResourceAttachment(attachment);return attachment.envelopeForRoot(kind);}
