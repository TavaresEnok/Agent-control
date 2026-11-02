/** A device signing key stays non-extractable in browser storage. It is never a provider credential. */
type Device={id:string;privateKey:CryptoKey;publicKey:string}
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}'
 const text=JSON.stringify(value);if(text===undefined)throw Error('INVALID_SIGNED_COMMAND');return text
}
let pending:Promise<Device>|undefined
async function device():Promise<Device>{
 if(pending)return pending
 pending=(async()=>{
  if(!crypto.subtle)throw Error('SECURE_BROWSER_REQUIRED')
  const db=await new Promise<IDBDatabase>((ok,fail)=>{const req=indexedDB.open('agent-control-operator',1)
   req.onupgradeneeded=()=>req.result.createObjectStore('keys');req.onerror=()=>fail(Error('DEVICE_STORAGE_UNAVAILABLE'));req.onsuccess=()=>ok(req.result)})
  try{
   const saved:unknown=await new Promise((ok,fail)=>{const req=db.transaction('keys','readonly').objectStore('keys').get('primary');req.onsuccess=()=>ok(req.result);req.onerror=()=>fail(Error('DEVICE_STORAGE_UNAVAILABLE'))})
   if(saved!==undefined){
    const value=saved as Device
    if(!value||typeof value.id!=='string'||typeof value.publicKey!=='string'||!(value.privateKey instanceof CryptoKey)||value.privateKey.type!=='private'||value.privateKey.extractable)
     throw Error('DEVICE_KEY_INVALID')
    return value
   }
   const pair=await crypto.subtle.generateKey({name:'Ed25519'},false,['sign','verify']) as CryptoKeyPair
   const publicBytes=new Uint8Array(await crypto.subtle.exportKey('spki',pair.publicKey))
   const value:Device={id:crypto.randomUUID(),privateKey:pair.privateKey,publicKey:btoa(String.fromCharCode(...publicBytes))}
   await new Promise<void>((ok,fail)=>{const tx=db.transaction('keys','readwrite');tx.objectStore('keys').put(value,'primary');tx.oncomplete=()=>ok();tx.onerror=()=>fail(Error('DEVICE_STORAGE_UNAVAILABLE'))})
   return value
  }finally{db.close()}
 })().catch(error=>{pending=undefined;throw error})
 return pending
}
export async function operatorIdentity(){const value=await device();return {deviceId:value.id,publicKey:value.publicKey}}
export async function signControl(principal:string,command:Record<string,unknown>,installationId:string){
 const value=await device(),expiresAt=Date.now()+120000,{deliveryAttemptId,...semantic}=command
 const message=canonical({domain:'agent-control-human-command-v1',installationId,principal,deviceId:value.id,expiresAt,command:semantic})
 const signature=new Uint8Array(await crypto.subtle.sign('Ed25519',value.privateKey,new TextEncoder().encode(message)))
 const proof={deviceId:value.id,expiresAt,signature:Array.from(signature,b=>b.toString(16).padStart(2,'0')).join('')}
 return btoa(JSON.stringify(proof)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')
}
