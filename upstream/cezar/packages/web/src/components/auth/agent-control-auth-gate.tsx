import {useState,type FormEvent,type ReactNode} from 'react'
import {useQuery} from '@tanstack/react-query'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
const Config=z.object({passwordLogin:z.boolean().default(false)})
const Status=z.object({authenticated:z.literal(true),principalId:z.string()})
async function json(path:string){
 const response=await fetch(path,{credentials:'include',cache:'no-store'})
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
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 const [codeLogin,setCodeLogin]=useState(false),[code,setCode]=useState(''),[user,setUser]=useState(''),[password,setPassword]=useState('')
 async function enterWithPassword(event:FormEvent){
  event.preventDefault()
  if(busy)return
  setBusy(true);setError('')
  try{
   const response=await fetch('/api/v1/ac/auth/password',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({user,password}),cache:'no-store'})
   if(response.status===429){setError('Muitas tentativas. Espere um minuto.');return}
   if(!response.ok){setError('Usuário ou senha incorretos.');return}
   const verified=await auth.refetch()
   if(!verified.data?.authenticated)throw Error('BROWSER_SESSION_UNCONFIRMED')
   setUser('');setPassword('')
  }catch(cause){setError(cause instanceof Error?cause.message:'LOGIN_FAILED')}
  finally{setBusy(false)}
 }
 async function enterWithCode(event:FormEvent){
  event.preventDefault()
  if(busy)return
  setBusy(true);setError('')
  try{
   const response=await fetch('/api/v1/ac/auth/code',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({code}),cache:'no-store'})
   if(response.status===429){setError('Muitas tentativas. Espere um minuto.');return}
   if(!response.ok){setError('Código inválido ou vencido.');return}
   const verified=await auth.refetch()
   if(!verified.data?.authenticated)throw Error('BROWSER_SESSION_UNCONFIRMED')
   setCode('')
  }catch(cause){setError(cause instanceof Error?cause.message:'LOGIN_FAILED')}
  finally{setBusy(false)}
 }
 if(auth.data?.authenticated)return children
 return <main className="flex min-h-dvh items-center justify-center bg-background p-4 text-foreground">
  <section className="flex w-full max-w-md flex-col gap-4 rounded-xl border bg-card p-6 shadow-sm">
   <h1 className="text-xl font-semibold">Agent Control</h1>
   {auth.isPending||config.isPending?<p role="status">Verificando sua sessão…</p>:<>
    {config.data?.passwordLogin===false&&<p role="status">O login por usuário e senha precisa ser configurado nesta instalação.</p>}
    {config.error&&<p role="alert">Não foi possível consultar a configuração de acesso.</p>}
    {config.data?.passwordLogin===true&&<form className="flex flex-col gap-2" onSubmit={event=>{void enterWithPassword(event)}}>
     <Input aria-label="Usuário" placeholder="Usuário" name="username" value={user} onChange={event=>setUser(event.target.value)} autoComplete="username" autoCapitalize="none" maxLength={40} required/>
     <Input aria-label="Senha" placeholder="Senha" name="password" type="password" value={password} onChange={event=>setPassword(event.target.value)} autoComplete="current-password" maxLength={200} required/>
     <Button type="submit" disabled={busy}>Entrar</Button>
    </form>}
    <button type="button" className="text-left underline" onClick={()=>setCodeLogin(value=>!value)}>Entrar com código</button>
    {codeLogin&&<form className="flex flex-col gap-2" onSubmit={event=>{void enterWithCode(event)}}>
     <p>Gere o código no servidor com npm run gateway -- pair {'<instalação.json>'}</p>
     <Input aria-label="Código" value={code} onChange={event=>setCode(event.target.value)} autoComplete="one-time-code" maxLength={8} required/>
     <Button type="submit" disabled={busy}>Entrar</Button>
    </form>}
    {error&&<p role="alert" className="break-words">{error}</p>}
   </>}
  </section>
 </main>
}
export function AgentControlAuthGate({children}:{children:ReactNode}){
 return import.meta.env.VITE_AGENT_CONTROL_MANAGED==='1'?<ManagedAuthentication>{children}</ManagedAuthentication>:children
}
