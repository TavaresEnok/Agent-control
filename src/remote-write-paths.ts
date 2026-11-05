import {z} from 'zod';
import {Refusal} from './contracts.ts';

/** Canonical Git paths; a final slash grants a directory and its descendants. */
export const RemoteWritePath=z.string().min(1).max(240).refine(value=>{
 if(value.includes('\\')||/[\x00-\x1f\x7f]/.test(value))return false;
 const parts=(value.endsWith('/')?value.slice(0,-1):value).split('/');
 return parts.every(part=>part!==''&&part!=='.'&&part!=='..'&&part!=='.git');
});
export function remoteImplementationWritePaths(requested:readonly string[],configured:readonly string[]|undefined){
 const paths=z.array(RemoteWritePath).min(1).max(64).safeParse(requested);
 const policy=configured===undefined?undefined:z.array(RemoteWritePath).min(1).max(64).safeParse(configured);
 if(!paths.success||policy&&!policy.success)throw new Refusal('REMOTE_IMPLEMENTATION_WRITE_PATH_FORBIDDEN');
 if(policy?.success&&paths.data.some(path=>!policy.data.some(allowed=>path===allowed||allowed.endsWith('/')&&path.startsWith(allowed))))throw new Refusal('REMOTE_IMPLEMENTATION_WRITE_PATH_FORBIDDEN');
 return paths.data;
}
