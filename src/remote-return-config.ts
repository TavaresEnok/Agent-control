import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {Id,Refusal} from './contracts.ts';
import {OpenSshTransport} from './remote.ts';
/** Explicit opt-in only; private key paths remain installation configuration. */
export const RemoteReturnConfig=z.object({allowedHosts:z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/)).min(1).max(32),
 credentials:z.array(z.object({id:Id,path:z.string().refine(isAbsolute)}).strict()).min(1).max(32)}).strict()
 .refine(value=>new Set(value.credentials.map(item=>item.id)).size===value.credentials.length);
export function remoteReturnTransport(config:z.infer<typeof RemoteReturnConfig>|undefined){
 if(!config)return undefined;
 const parsed=RemoteReturnConfig.parse(config),paths=new Map(parsed.credentials.map(item=>[item.id,item.path]));
 return new OpenSshTransport(async id=>{const path=paths.get(id);if(!path)throw new Refusal('REMOTE_CREDENTIAL_NOT_CONFIGURED',403);return path;},new Set(parsed.allowedHosts));
}
