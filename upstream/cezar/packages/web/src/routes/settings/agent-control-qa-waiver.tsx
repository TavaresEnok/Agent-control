import {useState} from 'react'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import {SettingsField} from './settings-field'

const hash=z.string().regex(/^[a-f0-9]{64}$/)
export const qaWaiverViewSchema=z.object({
 canAuthorize:z.boolean(),
 active:z.object({templateId:z.string().uuid(),templateRevision:z.number().int().positive(),templateName:z.string(),templateDigest:hash,
  policyRevision:z.number().int().positive(),policyDigest:hash}).nullable(),
 authorizations:z.array(z.object({authorizationId:z.string().uuid(),policyRevision:z.number().int().positive(),templateId:z.string().uuid(),
  templateRevision:z.number().int().positive(),taskId:z.string()})).max(100),truncated:z.boolean(),
})
type View=z.infer<typeof qaWaiverViewSchema>
type Payload={policyRevision:number;templateId:string;templateRevision:number;taskId:string;riskRule:'explicit-low'}

export function AgentControlQaWaiver({view,busy,onAuthorize}:{view:View;busy:boolean;onAuthorize:(payload:Payload)=>void}){
 const [taskId,setTaskId]=useState('')
 const active=view.active
 const valid=/^[a-z][a-z0-9_-]{0,47}$/.test(taskId)
 const matching=view.authorizations.filter(row=>row.taskId===taskId&&row.policyRevision===active?.policyRevision)
 return <SettingsField title="Autorização de dispensa de QA" hint="A autorização permite avaliar dispensa para a primeira tentativa de baixo risco. A revisão independente continua obrigatória.">
  {!view.canAuthorize?<p>Somente o titular do projeto pode autorizar.</p>:!active?<p>Selecione um template do catálogo com política de qualidade que permita dispensa de baixo risco.</p>:<>
   <p className="text-sm">Alcance: projeto inteiro, tarefa identificada abaixo, política {active.policyRevision} e template {active.templateName}, revisão {active.templateRevision}. A regra é explicit-low.</p>
   <p className="text-xs">A autorização pode ser usada em outras conversas do projeto com o mesmo template e tarefa. Cada artefato é avaliado separadamente; falha, cancelamento ou ausência de resultado de QA não são aprovação.</p>
   <p className="break-all font-mono text-xs">Template {active.templateId} · SHA-256 {active.templateDigest}</p>
   <p className="break-all font-mono text-xs">Política SHA-256 {active.policyDigest}</p>
   {view.truncated&&<p role="alert">A lista de autorizações está incompleta. A autorização pelo painel está bloqueada.</p>}
   <form className="flex flex-col gap-2" onSubmit={event=>{event.preventDefault();if(valid&&!busy&&!view.truncated)onAuthorize({policyRevision:active.policyRevision,templateId:active.templateId,templateRevision:active.templateRevision,taskId,riskRule:'explicit-low'})}}>
    <label className="flex flex-col gap-1">Identificador da tarefa
     <Input aria-label="Identificador da tarefa para dispensa de QA" className="min-w-0 max-w-full" value={taskId} onChange={event=>setTaskId(event.target.value)} maxLength={48} pattern="[a-z][a-z0-9_-]{0,47}" required/>
    </label>
    {matching.length>0&&<div role="status" className="text-xs">
     <p>{matching.length>1?'Autorizações ambíguas: o QA será executado.':matching[0]?.templateId===active.templateId&&matching[0]?.templateRevision===active.templateRevision?'Autorização para o template ativo encontrada.':'Autorização encontrada para outro template; o QA será executado.'}</p>
     {matching.map(row=><p key={row.authorizationId} className="break-all">{row.authorizationId} · template {row.templateId} · revisão {row.templateRevision}</p>)}
    </div>}
    <Button type="submit" className="min-h-11 max-w-full" disabled={!valid||busy||view.truncated}>Autorizar dispensa de QA para esta tarefa</Button>
   </form>
  </>}
 </SettingsField>
}
