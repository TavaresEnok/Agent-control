import {z} from 'zod'
const safePath=(s:string)=>s.length<=4096&&!s.startsWith('/')&&!s.includes('\\')&&!s.split('/').some(part=>!part||part==='.'||part==='..')
const sha=z.string().regex(/^[a-f0-9]{64}$/)
const manifestSchema=z.object({schemaVersion:z.literal(1),scope:z.literal('isolated-synthetic-lab'),backupId:z.string().min(1).max(128),root:z.string().min(1).max(4096),createdAt:z.iso.datetime(),commit:z.string().regex(/^[a-f0-9]{40,64}$/),sources:z.array(z.string().refine(safePath)).max(100),missingOptional:z.array(z.string().refine(safePath)).max(100),files:z.array(z.object({path:z.string().refine(safePath),size:z.number().int().nonnegative().max(1024*1024*1024),sha256:sha}).strict()).max(2000),databaseSha256:sha,limitation:z.string().max(4096)}).strict()
export const BACKUP_MANIFEST_LIMIT=192*1024
/** Parses only a manifest already selected by the operator. No extraction or restoration. */
export async function inspectBackupManifest(bytes:Uint8Array){
 if(bytes.byteLength>BACKUP_MANIFEST_LIMIT)throw Error('MANIFEST_TOO_LARGE')
 let json:unknown;try{json=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw Error('INVALID_MANIFEST')}
 const m=manifestSchema.parse(json)
 if(new Set(m.files.map(f=>f.path)).size!==m.files.length)throw Error('DUPLICATE_PATH')
 const total=m.files.reduce((sum,f)=>sum+f.size,0)
 if(!Number.isSafeInteger(total)||total>1024*1024*1024)throw Error('MANIFEST_BYTES_EXCEEDED')
 const hash=await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>)
 const inputSha256=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')
 return {schemaVersion:1 as const,kind:'backup-manifest-preview' as const,inputSha256,counts:{files:m.files.length,sourceBytes:total,missingOptional:m.missingOptional.length},checks:{manifestSchemaValid:true as const,archiveAuthenticated:false as const,fileContentsVerified:false as const,databaseVerified:false as const},restoreEnabled:false as const}
}
export function downloadPreviewReport(report:unknown){
 const blob=new Blob([JSON.stringify(report,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob)
 try{const link=document.createElement('a');link.href=url;link.download='agent-control-preview-report.json';link.click()}finally{URL.revokeObjectURL(url)}
}
