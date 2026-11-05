export type ConversationConfigurationEntry={requested:boolean;sessionId:string};
export function conversationConfigurationEntry(search:string):ConversationConfigurationEntry{
 const params=new URLSearchParams(search),value=params.get('acSession')??'';
 const sessionId=value.length<=200&&!/[\x00-\x20\x7f]/.test(value)?value:'';
 return {requested:params.has('acSession'),sessionId};
}
export function conversationConfigurationContext(contexts:readonly {id:string;session_id?:string}[],selected:string,entry:ConversationConfigurationEntry){
 if(entry.requested)return entry.sessionId?contexts.find(context=>context.session_id===entry.sessionId)?.id??'':'';
 return selected||contexts[0]?.id||'';
}
