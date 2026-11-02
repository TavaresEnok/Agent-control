import {useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
export const approvalSchema=z.object({id:z.string().uuid(),commit_id:z.string(),tree_id:z.string(),base_id:z.string(),identity_digest:z.string(),
 policy_revision:z.number(),target_ref:z.string(),approved:z.boolean(),canceled:z.boolean()})
const diffSchema=z.object({artifactId:z.string(),artifactDigest:z.string(),commit:z.string(),tree:z.string(),base:z.string(),diff:z.string(),truncated:z.boolean(),diffSha256:z.string()})
export function AgentControlIntegrationApproval({contextId,artifact,canApprove,busy,onApprove}:{contextId:string;artifact:z.infer<typeof approvalSchema>;
 canApprove:boolean;busy:boolean;onApprove:(payload:{artifactId:string;artifactDigest:string;policyRevision:number;targetRef:string})=>void}){
 const [opened,setOpened]=useState(false)
 const diff=useQuery({queryKey:['ac-artifact-diff',contextId,artifact.id,artifact.identity_digest],enabled:opened,
  queryFn:async()=>{
   const response=await fetch(`/api/v1/ac/contexts/${contextId}/artifacts/${artifact.id}/diff`,{credentials:'include'})
   if(!response.ok)throw Error(`DIFF_HTTP_${response.status}`)
   const value=diffSchema.parse(await response.json())
   if(value.artifactId!==artifact.id||value.artifactDigest!==artifact.identity_digest||value.commit!==artifact.commit_id||value.tree!==artifact.tree_id||value.base!==artifact.base_id)throw Error('APPROVAL_ARTIFACT_MISMATCH')
   return value
  }})
 return <div className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
  <p className="break-all text-sm">Commit {artifact.commit_id} → {artifact.target_ref}</p>
  <p className="break-all text-xs text-muted-foreground">Base {artifact.base_id} · árvore {artifact.tree_id} · política {artifact.policy_revision}</p>
  <p>{artifact.canceled?'Plano cancelado; integração bloqueada.':artifact.approved?'Aprovação registrada para este artefato.':'Aguardando aprovação humana para este artefato.'}</p>
  <Button variant="outline" disabled={diff.isFetching} onClick={()=>setOpened(true)}>Ver alterações deste artefato</Button>
  {diff.error&&<p role="alert">{diff.error.message}</p>}
  {diff.data&&<>
   <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-xs">{diff.data.diff||'Nenhuma alteração textual.'}</pre>
   {diff.data.truncated&&<p role="alert">A prévia está incompleta. A aprovação pelo painel fica bloqueada até revisão integral por um fluxo homologado.</p>}
  </>}
  {canApprove&&!artifact.approved&&!artifact.canceled&&<Button disabled={busy||!diff.data||diff.data.truncated}
   onClick={()=>onApprove({artifactId:artifact.id,artifactDigest:artifact.identity_digest,policyRevision:artifact.policy_revision,targetRef:artifact.target_ref})}>
   Aprovar integração deste commit
  </Button>}
 </div>
}
