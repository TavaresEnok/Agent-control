import {useEffect,useRef,useState,type ReactNode} from 'react'
import {useQuery} from '@tanstack/react-query'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {createTerminalPairingAuthentication,applyTerminalAuthRequestExpiry,openTerminalProvisioningResponse,buildTerminalConnectLinks,nacl} from '@agent-control/happier-browser-auth'
const Config=z.discriminatedUnion('enabled',[z.object({enabled:z.literal(false)}),z.object({enabled:z.literal(true),webUrl:z.string().url(),serverUrl:z.string().url()})])
const Status=z.object({authenticated:z.literal(true),principalId:z.string()})
const Answer=z.discriminatedUnion('state',[
 z.object({state:z.literal('requested'),expiresAt:z.number().optional()}),
 z.object({state:z.literal('authorized'),token:z.string(),response:z.string()}),
])
const base64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes))
const base64url=(bytes:Uint8Array)=>base64(bytes).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')
const decode=(text:string)=>Uint8Array.from(atob(text),character=>character.charCodeAt(0))
async function json(path:string,body?:unknown,signal?:AbortSignal){
 const response=await fetch(path,{method:body?'POST':'GET',credentials:'include',headers:body?{'content-type':'application/json'}:undefined,
  body:body?JSON.stringify(body):undefined,signal,cache:'no-store'})
 const value:unknown=await response.json()
 if(!response.ok){const error=z.object({error:z.string()}).safeParse(value);throw Error(error.success?error.data.error:`HTTP_${response.status}`)}
 return value
}
function ManagedAuthentication({children}:{children:ReactNode}){
 const auth=useQuery({queryKey:['ac-auth-status'],retry:false,refetchInterval:30000,refetchOnWindowFocus:'always',queryFn:async()=>{
  const response=await fetch('/api/v1/ac/auth/status',{credentials:'include',cache:'no-store'})
  if(response.status===401)return null
  if(!response.ok)throw Error('AUTH_STATUS_UNAVAILABLE')
  return Status.parse(await response.json())
 }})
 const config=useQuery({queryKey:['ac-auth-config'],retry:false,queryFn:async()=>Config.parse(await json('/api/v1/ac/auth/config'))})
 const [links,setLinks]=useState<{webUrl:string;mobileUrl:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const current=useRef<AbortController|null>(null)
 useEffect(()=>()=>{current.current?.abort()},[])
 async function login(){
  if(config.data?.enabled!==true||busy||current.current)return
  if(!crypto.subtle){setError('Abra o cockpit por HTTPS para entrar com segurança.');return}
  const controller=new AbortController();current.current=controller;setBusy(true);setError('');setLinks(null)
  // All decryption and pairing secrets remain in this browser's memory.
  let pair:ReturnType<typeof nacl.box.keyPair>|undefined,claim:Uint8Array<ArrayBuffer>|undefined
  let pairing:ReturnType<typeof createTerminalPairingAuthentication>|undefined
  try{
   pair=nacl.box.keyPair();claim=crypto.getRandomValues(new Uint8Array(32))
   pairing=createTerminalPairingAuthentication({nowMs:Date.now(),randomBytes:length=>crypto.getRandomValues(new Uint8Array(length))})
   const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',claim))
   const request=await json('/api/v1/ac/auth/pair',{publicKey:base64(pair.publicKey),claimSecretHash:base64url(hash)},controller.signal)
   pairing=applyTerminalAuthRequestExpiry(pairing,request)
   const connect=buildTerminalConnectLinks({webappUrl:config.data.webUrl,serverUrl:config.data.serverUrl,publicKeyB64Url:base64url(pair.publicKey),
    pairing:{secretB64Url:base64url(pairing.secret),createdAtMs:pairing.createdAtMs,expiresAtMs:pairing.expiresAtMs}})
   setLinks(connect)
   while(!controller.signal.aborted&&Date.now()<pairing.expiresAtMs){
    const response=Answer.parse(await json('/api/v1/ac/auth/pair/claim',{publicKey:base64(pair.publicKey),claimSecret:base64url(claim)},controller.signal))
    if(response.state==='authorized'){
     const bytes=decode(response.response)
     const opened=openTerminalProvisioningResponse({payload:bytes,terminalSecretKey:pair.secretKey,terminalPublicKey:pair.publicKey,pairing,requirement:'v3',nowMs:Date.now()})
     bytes.fill(0)
     if(!opened?.authenticated)throw Error('PAIRING_AUTHENTICATION_REQUIRED')
     if(opened.type!=='tokenOnly')opened.key.fill(0)
     const issued=await fetch('/api/v1/ac/auth/session',{method:'POST',credentials:'include',headers:{authorization:'Bearer '+response.token},signal:controller.signal,cache:'no-store'})
     if(!issued.ok)throw Error('BROWSER_SESSION_REFUSED')
     const verified=await auth.refetch();if(!verified.data?.authenticated)throw Error('BROWSER_SESSION_UNCONFIRMED')
     return
    }
    await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',finish);resolve()};const timer=setTimeout(finish,1500);controller.signal.addEventListener('abort',finish,{once:true})})
   }
   if(!controller.signal.aborted)throw Error('PAIRING_EXPIRED')
  }catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'LOGIN_FAILED')}
  finally{pair?.secretKey.fill(0);claim?.fill(0);pairing?.secret.fill(0);if(current.current===controller){current.current=null;setBusy(false);setLinks(null)}}
 }
 if(auth.data?.authenticated)return children
 return <main className="flex min-h-dvh items-center justify-center bg-background p-4 text-foreground">
  <section className="flex w-full max-w-md flex-col gap-4 rounded-xl border bg-card p-6 shadow-sm">
   <h1 className="text-xl font-semibold">Agent Control</h1>
   {auth.isPending?<p role="status">Verificando sua sessão…</p>:<>
    <p>Entre com sua conta do Happier para acessar o cockpit. Sua conversa continua no Happier.</p>
    {config.data?.enabled===false&&<p role="status">O login precisa ser configurado nesta instalação.</p>}
    {config.error&&<p role="alert">Não foi possível consultar a configuração de acesso.</p>}
    <Button disabled={busy||config.data?.enabled!==true} onClick={()=>{void login()}}>Entrar pelo Happier</Button>
    {links&&<div className="flex flex-col gap-3">
     <a className="underline" href={links.webUrl} target="_blank" rel="noopener noreferrer">Autorizar no Happier</a>
     {links.mobileUrl.includes('server=')&&<a className="underline" href={links.mobileUrl}>Autorizar no aplicativo Happier</a>}
     <p role="status">Aguardando autorização. Depois de aprovar, volte a esta página.</p>
     <Button variant="outline" onClick={()=>current.current?.abort()}>Cancelar entrada</Button>
    </div>}
    {error&&<p role="alert" className="break-words">{error}</p>}
   </>}
  </section>
 </main>
}
export function AgentControlAuthGate({children}:{children:ReactNode}){
 return import.meta.env.VITE_AGENT_CONTROL_MANAGED==='1'?<ManagedAuthentication>{children}</ManagedAuthentication>:children
}
