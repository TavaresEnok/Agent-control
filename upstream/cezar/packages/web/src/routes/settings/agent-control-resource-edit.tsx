import {useState} from 'react'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'

type Account={id:string;label:string;provider:string;revision:number}
type Profile={id:string;account_id:string;model:string;effort:string;role:string;config_digest:string}
type Entry={provider:string;model:string;efforts:string[];roles:string[]}
export function AccountRename({account,busy,onSave}:{account:Account;busy:boolean;onSave:(payload:{id:string;label:string;expectedRevision:number})=>void}){
 const [label,setLabel]=useState(account.label),[base]=useState(account.revision)
 return <form className="flex flex-wrap gap-2" onSubmit={event=>{event.preventDefault();onSave({id:account.id,label:label.trim(),expectedRevision:base})}}>
  <label>Novo nome da conta<Input aria-label={`Novo nome ${account.label}`} value={label} onChange={event=>setLabel(event.target.value)} maxLength={100} required/></label>
  <Button type="submit" disabled={busy||!label.trim()||label.trim()===account.label||base!==account.revision}>Renomear conta</Button>
 </form>
}
export function ProfileVersionEditor({profile,account,catalog,busy,onSave}:{profile:Profile;account:Account;catalog:Entry[];busy:boolean;onSave:(payload:{sourceProfileId:string;expectedDigest:string;newId:string;model:string;effort:string;role:string},onSuccess:()=>void)=>void}){
 const [editing,setEditing]=useState(false),[model,setModel]=useState(profile.model),[effort,setEffort]=useState(profile.effort),[role,setRole]=useState(profile.role)
 const [base]=useState(profile.config_digest),[newId,setNewId]=useState(()=>crypto.randomUUID())
 const choices=catalog.filter(entry=>entry.provider===account.provider&&entry.roles.includes(role)),entry=choices.find(item=>item.model===model)
 if(!editing)return <Button type="button" disabled={busy} onClick={()=>setEditing(true)}>Criar nova versão do perfil</Button>
 return <form className="flex min-w-0 flex-col gap-2" onSubmit={event=>{event.preventDefault();if(!entry?.efforts.includes(effort))return;onSave({sourceProfileId:profile.id,expectedDigest:base,newId,model,effort,role},()=>{setEditing(false);setNewId(crypto.randomUUID())})}}>
  <p>A nova versão não altera políticas ou concessões existentes. Publique uma política para usá-la.</p>
  <label>Função da nova versão<select aria-label="Função da nova versão" value={role} onChange={event=>{setRole(event.target.value);setModel('')}}>
   {['manager','programmer','reviewer','qa','specialist','judge'].map(value=><option key={value} value={value}>{value}</option>)}
  </select></label>
  <label>Modelo da nova versão<select aria-label="Modelo da nova versão" value={entry?model:''} onChange={event=>{const value=event.target.value;setModel(value);const choice=choices.find(item=>item.model===value);if(choice&&!choice.efforts.includes(effort))setEffort(choice.efforts[0]??'')}}>
   <option value="">Selecione um modelo</option>{choices.map(value=><option key={value.model} value={value.model}>{value.model}</option>)}
  </select></label>
  <label>Esforço da nova versão<select aria-label="Esforço da nova versão" value={entry?.efforts.includes(effort)?effort:''} onChange={event=>setEffort(event.target.value)}>
   <option value="">Selecione o esforço</option>{entry?.efforts.map(value=><option key={value} value={value}>{value}</option>)}
  </select></label>
  {base!==profile.config_digest&&<p role="alert">O perfil mudou. Feche e abra novamente para revisar a versão atual.</p>}
  <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy||base!==profile.config_digest||!entry?.efforts.includes(effort)}>Salvar nova versão</Button>
   <Button type="button" variant="outline" onClick={()=>setEditing(false)}>Cancelar edição</Button></div>
 </form>
}
