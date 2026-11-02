import {useEffect,useRef,useState} from 'react'
import {Button} from '@/components/ui/button'
import {SettingsField} from './settings-field'
import {agentControlFetch} from './agent-control-fetch'

const MAX_BYTES=2*1024*1024
const codePattern=/^[A-Z][A-Z0-9_]{0,79}$/
async function readBounded(response:Response):Promise<Uint8Array<ArrayBuffer>>{
 const length=response.headers.get('content-length')
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES))throw Error('EXPORT_TOO_LARGE')
 const reader=response.body?.getReader();if(!reader)throw Error('EXPORT_INVALID_JSON')
 const chunks:Uint8Array[]=[];let size=0
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength
  if(size>MAX_BYTES){void reader.cancel().catch(()=>{});throw Error('EXPORT_TOO_LARGE')}chunks.push(chunk.value)}}finally{reader.releaseLock()}
 const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength}return result
}
async function failureCode(response:Response):Promise<string>{
 try{
  if((response.headers.get('content-type')??'').split(';')[0]?.trim().toLowerCase()!=='application/json')return `HTTP_${response.status}`
  const bytes=await readBounded(response),value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
  if(value&&typeof value==='object'&&'error' in value&&typeof value.error==='string'&&codePattern.test(value.error))return value.error
 }catch{/* Do not display response content. */}
 return `HTTP_${response.status}`
}
export function AgentControlPortableExport({contextId,canExport}:{contextId:string;canExport:boolean}){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('')
 const running=useRef(false)
 const active=useRef<AbortController|null>(null)
 useEffect(()=>()=>{active.current?.abort()},[])
 useEffect(()=>{if(!canExport&&active.current){active.current.abort();setBusy(false)}},[canExport])
 if(!canExport)return null
 async function download(){
  if(running.current)return
  running.current=true;const controller=new AbortController();active.current=controller;setBusy(true);setMessage('');setError('')
  try{
   const response=await agentControlFetch(`/api/v1/ac/contexts/${encodeURIComponent(contextId)}/export/metadata`,{signal:controller.signal})
   if(!response.ok)throw Error(await failureCode(response))
   if((response.headers.get('content-type')??'').split(';')[0]?.trim().toLowerCase()!=='application/json')throw Error('EXPORT_INVALID_CONTENT_TYPE')
   const bytes=await readBounded(response)
   try{JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw Error('EXPORT_INVALID_JSON')}
   if(controller.signal.aborted)return
   const href=URL.createObjectURL(new Blob([bytes],{type:'application/json'})),link=document.createElement('a')
   link.href=href;link.download='agent-control-context-metadata.json';document.body.appendChild(link)
   try{link.click()}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(href),0)}
   setMessage('Download dos metadados iniciado.')
  }catch(cause){if(!controller.signal.aborted){const code=cause instanceof Error&&codePattern.test(cause.message)?cause.message:'EXPORT_UNAVAILABLE';setError(code)}}
  finally{running.current=false;if(active.current===controller)active.current=null;if(!controller.signal.aborted)setBusy(false)}
 }
 return <SettingsField title="Exportar metadados do contexto" hint="O arquivo contém metadados limitados e informa no próprio JSON quando houver truncamento. Não inclui chat, credenciais nem backup completo.">
  <Button type="button" variant="outline" disabled={busy} onClick={()=>{void download()}}>{busy?'Preparando metadados…':'Exportar metadados do contexto'}</Button>
  {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
 </SettingsField>
}
