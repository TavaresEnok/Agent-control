import {createHash} from 'node:crypto';
import {ImportBundle} from './import.ts';
import {digest,Refusal} from './contracts.ts';
import type {Ledger} from './ledger.ts';

/** Deliberately smaller than the existing stage limit and global API body limit. */
export const IMPORT_PREVIEW_MAX_BYTES=192*1024;
export class ImportPreview {
 constructor(private readonly ledger:Ledger,private readonly projectId:string){}
 async inspect(principal:string,bytes:Uint8Array){
  if(!(await this.ledger.pool.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[this.projectId,principal])).rowCount)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
  if(bytes.byteLength>IMPORT_PREVIEW_MAX_BYTES)throw new Refusal('IMPORT_PREVIEW_TOO_LARGE',400);
  // No decompression, extraction, path interpretation or persistence.
  let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Refusal('INVALID_IMPORT_JSON',400);}
  const bundle=ImportBundle.parse(raw);
  if(bundle.projectId!==this.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
  return {schemaVersion:1 as const,kind:'import' as const,projectId:bundle.projectId,
   inputSha256:createHash('sha256').update(bytes).digest('hex'),bundleDigest:digest(bundle),
   counts:{contexts:bundle.contexts.length,messages:bundle.contexts.reduce((n,c)=>n+c.messages.length,0),runs:bundle.contexts.reduce((n,c)=>n+c.runs.length,0),sourcePaused:bundle.contexts.filter(c=>c.sourcePaused).length},
   checks:{schemaValid:true as const,projectOwner:true as const,sessionOwnershipVerified:false as const,keysVerified:false as const,ciphertextVerified:false as const},executionEnabled:false as const};
 }
}
