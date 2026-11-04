import {useMutation,useQueryClient} from '@tanstack/react-query'
import {useRef,useState} from 'react'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {signControl} from './agent-control-operator'
import {agentControlFetch} from './agent-control-fetch'

const gitHash=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const Snapshot=z.object({
 projectId:z.string().uuid(),contextId:z.string().uuid(),operationId:z.string().uuid(),hostId:z.string().uuid(),
 commit:z.string().regex(gitHash),tree:z.string().regex(gitHash),sha256:z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value=>value.commit.length===value.tree.length)
type Snapshot=z.infer<typeof Snapshot>
const Candidate=Snapshot.and(z.object({label:z.string().min(1).max(200),state:z.literal('exported'),reviewStatus:z.literal('not_reviewed')}).strict())
type Candidate=z.infer<typeof Candidate>
const Pending=z.object({semantic:z.string(),intentId:z.string().uuid(),uncertain:z.boolean().default(false)}).strict()
const Result=z.object({state:z.literal('applied'),projectId:z.string().uuid(),reviewStatus:z.literal('not_reviewed')})
const BUNDLE_LIMIT=65536

export function remoteSourceStorageKey(principalId:string,installationId:string){
 return `ac-remote-source:${encodeURIComponent(principalId)}:${installationId}`
}
/** Ids and the expected digest only. The bundle bytes never enter storage. */
export function remoteSourceSemantic(candidate:Snapshot){
 return JSON.stringify({projectId:candidate.projectId,contextId:candidate.contextId,operationId:candidate.operationId,hostId:candidate.hostId,commit:candidate.commit,tree:candidate.tree,sha256:candidate.sha256})
}
function snapshotFromSemantic(semantic:string){
 try{const parsed=Snapshot.safeParse(JSON.parse(semantic));return parsed.success?parsed.data:null}catch{return null}
}
async function sha256Hex(bytes:Uint8Array){
 const digest=await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>)
 return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('')
}
function encodeBase64(bytes:Uint8Array){
 let binary=''
 for(let index=0;index<bytes.length;index+=0x8000)binary+=String.fromCharCode(...bytes.subarray(index,index+0x8000))
 return btoa(binary)
}
function readPending(key:string){
 let saved:unknown
 try{saved=JSON.parse(sessionStorage.getItem(key)||'null')}catch{throw Error('PENDING_COMMAND_INVALID')}
 const record=Pending.safeParse(saved)
 if(saved!==null&&!record.success)throw Error('PENDING_COMMAND_INVALID')
 return record.success?record.data:null
}
function peekPending(key:string){
 try{return readPending(key)}catch{return null}
}

export function AgentControlRemoteSourceImport({principalId,installationId,candidates}:{principalId:string;installationId:string;candidates:Candidate[]}){
 const cache=useQueryClient()
 const storageKey=remoteSourceStorageKey(principalId,installationId)
 const selection=useRef({operationId:'',file:null as File|null})
 const [operationId,setOperationId]=useState('')
 const [file,setFile]=useState<File|null>(null)
 const [fileEpoch,setFileEpoch]=useState(0)
 const [refusedKey,setRefusedKey]=useState<string|null>(null)
 const [revision,setRevision]=useState(0)
 const pending=peekPending(revision>=0?storageKey:storageKey)
 function chooseSnapshot(value:string){selection.current.operationId=value;setOperationId(value)}
 function chooseFile(next:File|null){selection.current.file=next;setFile(next)}
 function invalidateSelection(){selection.current={operationId:'',file:null};setOperationId('');setFile(null);setFileEpoch(value=>value+1)}
 const materialize=useMutation({mutationFn:async()=>{
  const stored=readPending(storageKey)
  const resumed=stored?snapshotFromSemantic(stored.semantic):null
  const stillListed=Boolean(stored&&candidates.some(item=>remoteSourceSemantic(item)===stored.semantic))
  const chosenOperationId=selection.current.operationId
  const chosenFile=selection.current.file
  const selected=candidates.find(item=>item.operationId===chosenOperationId)
  const target=(!stillListed&&stored?.uncertain&&resumed&&(!chosenOperationId||chosenOperationId===resumed.operationId)?resumed:selected)
  if(!target)throw Error('SNAPSHOT_REQUIRED')
  if(!chosenFile||chosenFile.size<=0)throw Error('BUNDLE_INVALID')
  if(chosenFile.size>BUNDLE_LIMIT)throw Error('BUNDLE_TOO_LARGE')
  const bytes=new Uint8Array(await chosenFile.arrayBuffer())
  const sha256=await sha256Hex(bytes)
  if(sha256!==target.sha256)throw Error('BUNDLE_SHA256_MISMATCH')
  const semantic=remoteSourceSemantic(target)
  if(stored&&stored.semantic!==semantic)throw Error('PENDING_COMMAND_DIFFERENT')
  const intent={semantic,intentId:stored?.intentId??crypto.randomUUID(),uncertain:stored?.uncertain??false}
  sessionStorage.setItem(storageKey,JSON.stringify(intent))
  const command={schemaVersion:1,intentId:intent.intentId,deliveryAttemptId:crypto.randomUUID(),action:'project.materializeRemoteSource' as const,
   payload:{projectId:target.projectId,contextId:target.contextId,operationId:target.operationId,hostId:target.hostId,commit:target.commit,tree:target.tree,bundle:encodeBase64(bytes)}}
  let proof:string
  try{proof=await signControl(principalId,command,installationId)}
  catch(error){if(!intent.uncertain)setRefusedKey(storageKey);throw error}
  setRefusedKey(null)
  sessionStorage.setItem(storageKey,JSON.stringify({...intent,uncertain:true}))
  setRevision(value=>value+1)
  try{
   const response=await agentControlFetch('/api/v1/ac/project-admin/remote-source',{method:'POST',headers:{'content-type':'application/json','x-ac-operator-proof':proof},body:JSON.stringify(command)})
   const value:unknown=await response.json().catch(()=>null)
   if(!response.ok){const error=z.object({error:z.string()}).safeParse(value);throw Error(error.success?error.data.error:`HTTP_${response.status}`)}
   const result=Result.safeParse(value)
   if(!result.success||result.data.projectId!==target.projectId)throw Error('COMMAND_RESPONSE_MISMATCH')
   sessionStorage.removeItem(storageKey)
   setRefusedKey(null)
   setRevision(value=>value+1)
   return result.data
  }catch(error){invalidateSelection();throw error}
 },onSuccess:()=>{invalidateSelection();void cache.invalidateQueries({queryKey:['ac-project-admin']});void cache.invalidateQueries({queryKey:['projects']});void cache.invalidateQueries({queryKey:['workspace','projects']})}})
 const uncertain=pending?.uncertain===true
 const resumed=uncertain&&pending?snapshotFromSemantic(pending.semantic):null
 const resumeAbsent=Boolean(resumed&&pending&&!candidates.some(item=>remoteSourceSemantic(item)===pending.semantic))
 return <div className="flex min-w-0 flex-col gap-2">
  <p>Materializar origem SSH de uma exportação Git já concluída. O snapshot permanece não revisado e esta ação não aprova integração.</p>
  {candidates.length===0&&!resumeAbsent&&<p role="status">Nenhuma exportação Git concluída deste projeto está disponível para materializar.</p>}
  {uncertain&&!resumeAbsent&&<p role="status">Envio anterior incerto. Selecione de novo o mesmo snapshot e o mesmo arquivo para retomar. O efeito não pode ser descartado daqui.</p>}
  {resumeAbsent&&resumed&&<form noValidate className="flex min-w-0 flex-col gap-2" onSubmit={event=>{event.preventDefault();materialize.mutate()}}>
   <p role="status">Envio anterior incerto. O snapshot saiu da lista. Selecione de novo o mesmo arquivo, com o mesmo SHA-256, para confirmar o resultado. O efeito não pode ser descartado daqui.</p>
   <p>Snapshot pendente; projeto {resumed.projectId}; commit {resumed.commit}; tree {resumed.tree}; SHA-256 {resumed.sha256}; exportado; não revisado</p>
   <label className="flex flex-col gap-1">Arquivo Git bundle local<input key={fileEpoch} aria-label="Arquivo Git bundle local" type="file" accept=".bundle,application/octet-stream" onChange={event=>chooseFile(event.target.files?.[0]??null)} required/></label>
   <p className="text-xs text-muted-foreground">O arquivo local precisa ter no máximo 64 KiB e o mesmo SHA-256 do snapshot. A comparação acontece antes da assinatura.</p>
   <Button type="submit" disabled={materialize.isPending||!file}>Materializar origem SSH</Button>
  </form>}
  {!resumeAbsent&&candidates.length>0&&<form noValidate className="flex min-w-0 flex-col gap-2" onSubmit={event=>{event.preventDefault();materialize.mutate()}}>
   <label className="flex flex-col gap-1">Snapshot exportado<select aria-label="Snapshot exportado" className="h-9 min-w-0 max-w-full rounded-md border border-input bg-card px-2 text-sm" value={operationId} onChange={event=>chooseSnapshot(event.target.value)} required>
    <option value="">Selecione um snapshot</option>
    {candidates.map(candidate=><option key={candidate.operationId} value={candidate.operationId}>{candidate.label}; commit {candidate.commit}; tree {candidate.tree}; SHA-256 {candidate.sha256}; exportado; não revisado</option>)}
   </select></label>
   <label className="flex flex-col gap-1">Arquivo Git bundle local<input key={fileEpoch} aria-label="Arquivo Git bundle local" type="file" accept=".bundle,application/octet-stream" onChange={event=>chooseFile(event.target.files?.[0]??null)} required/></label>
   <p className="text-xs text-muted-foreground">O arquivo local precisa ter no máximo 64 KiB e o mesmo SHA-256 do snapshot. A comparação acontece antes da assinatura.</p>
   <Button type="submit" disabled={materialize.isPending||!operationId||!file}>Materializar origem SSH</Button>
   {refusedKey&&<Button type="button" variant="outline" onClick={()=>{sessionStorage.removeItem(refusedKey);setRefusedKey(null);setRevision(value=>value+1);materialize.reset()}}>Descartar rascunho recusado</Button>}
  </form>}
  {materialize.error&&<p role="alert">{materialize.error.message}</p>}
  {materialize.isSuccess&&<p role="status">Origem SSH materializada. O snapshot continua não revisado.</p>}
 </div>
}
