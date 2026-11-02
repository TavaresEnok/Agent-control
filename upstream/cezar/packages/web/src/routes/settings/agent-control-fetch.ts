import {getApiScope} from '@open-mercato/cezar-api-client'

/** Project scope is selected by the native route and verified by the gateway. */
export function agentControlFetch(path:string,init:RequestInit={}):Promise<Response>{
 const headers=new Headers(init.headers)
 const projectId=getApiScope()
 if(projectId)headers.set('X-Agent-Control-Project',projectId)
 return fetch(path,{...init,headers,credentials:'include'})
}
