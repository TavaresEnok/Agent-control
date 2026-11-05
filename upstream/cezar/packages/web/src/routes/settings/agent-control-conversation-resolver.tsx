import {useEffect} from 'react'
import {useQuery} from '@tanstack/react-query'
import {Link,useNavigate} from 'react-router'
import {z} from 'zod'

const resultSchema=z.object({matches:z.array(z.object({projectId:z.string().uuid(),contextId:z.string().uuid()})).max(100)})
/** The gateway resolves membership before this entry selects any project. */
export function AgentControlConversationResolver({sessionId}:{sessionId:string}){
 const navigate=useNavigate()
 const lookup=useQuery({queryKey:['ac-conversation-entry',sessionId],enabled:!!sessionId,retry:false,queryFn:async()=>{
  const response=await fetch('/api/v1/ac/conversation-entry?sessionId='+encodeURIComponent(sessionId),{credentials:'include'})
  if(!response.ok)throw Error('CONVERSATION_ENTRY_UNAVAILABLE')
  return resultSchema.parse(await response.json())
 }})
 const matches=lookup.data?.matches
 const href=(projectId:string)=>`/p/${encodeURIComponent(projectId)}/settings/agent-control?acSession=${encodeURIComponent(sessionId)}`
 useEffect(()=>{if(matches?.length===1)void navigate(href(matches[0]!.projectId),{replace:true})},[matches,navigate,sessionId])
 if(!sessionId||lookup.isError)return <p role="alert">Não foi possível abrir esta conversa. Entre pelo Happier e tente novamente.</p>
 if(!matches)return <p role="status">Localizando o projeto da conversa…</p>
 if(matches.length===0)return <p role="status">Esta conversa não tem vínculo autorizado disponível.</p>
 if(matches.length===1)return <p role="status">Abrindo o projeto da conversa…</p>
 return <section aria-label="Projeto da conversa"><p>Escolha o projeto desta conversa.</p><ul>{matches.map(match=><li key={match.projectId}><Link to={href(match.projectId)}>Abrir projeto {match.projectId}</Link></li>)}</ul></section>
}
