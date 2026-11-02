/** A device signing key stays non-extractable in browser storage. It is never a provider credential. */
type Device={id:string;privateKey:CryptoKey;publicKey:string}
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}'
 const text=JSON.stringify(value);if(text===undefined)throw Error('INVALID_SIGNED_COMMAND');return text
}
function storedDevice(raw:unknown):Device{
 const value=raw as Device|undefined
 if(!value||typeof value.id!=='string'||typeof value.publicKey!=='string'||!(value.privateKey instanceof CryptoKey)||
  value.privateKey.type!=='private'||value.privateKey.extractable||value.privateKey.algorithm.name!=='Ed25519'||!value.privateKey.usages.includes('sign'))throw Error('DEVICE_KEY_INVALID')
 return value
}
const pending=new Map<string,Promise<Device>>()
async function device(principal:string,legacyIds:readonly string[]=[]):Promise<Device>{
 if(!principal)throw Error('PRINCIPAL_REQUIRED')
 const current=pending.get(principal);if(current)return current
 const scope='principal:'+principal
 const promise=(async()=>{
  if(!crypto.subtle)throw Error('SECURE_BROWSER_REQUIRED')
  const db=await new Promise<IDBDatabase>((ok,fail)=>{const req=indexedDB.open('agent-control-operator',1)
   req.onupgradeneeded=()=>req.result.createObjectStore('keys');req.onerror=()=>fail(Error('DEVICE_STORAGE_UNAVAILABLE'));req.onsuccess=()=>ok(req.result)})
  try{
   const saved:unknown=await new Promise((ok,fail)=>{const req=db.transaction('keys','readonly').objectStore('keys').get(scope);req.onsuccess=()=>ok(req.result);req.onerror=()=>fail(Error('DEVICE_STORAGE_UNAVAILABLE'))})
   if(saved!==undefined)return storedDevice(saved)
   const legacy:unknown=await new Promise((ok,fail)=>{const req=db.transaction('keys','readonly').objectStore('keys').get('primary');req.onsuccess=()=>ok(req.result);req.onerror=()=>fail(Error('DEVICE_STORAGE_UNAVAILABLE'))})
   const reusable=legacy as Device|undefined
   const reuse=!!reusable&&legacyIds.includes(reusable.id)&&typeof reusable.publicKey==='string'&&reusable.privateKey instanceof CryptoKey&&reusable.privateKey.type==='private'&&!reusable.privateKey.extractable
   let value:Device
   if(reuse)value=storedDevice(reusable)
   else{
    const pair=await crypto.subtle.generateKey({name:'Ed25519'},false,['sign','verify']) as CryptoKeyPair
    const publicBytes=new Uint8Array(await crypto.subtle.exportKey('spki',pair.publicKey))
    value={id:crypto.randomUUID(),privateKey:pair.privateKey,publicKey:btoa(String.fromCharCode(...publicBytes))}
   }
   // Serialize tabs at the existing IndexedDB owner; do not overwrite another
   // tab's newly enrolled key after generating ours outside the transaction.
   return await new Promise<Device>((ok,fail)=>{const tx=db.transaction('keys','readwrite'),store=tx.objectStore('keys');let selected=value
    const read=store.get(scope);read.onsuccess=()=>{try{if(read.result!==undefined)selected=storedDevice(read.result);else store.add(value,scope)}catch{tx.abort()}}
    tx.oncomplete=()=>ok(selected);tx.onerror=()=>fail(Error('DEVICE_STORAGE_UNAVAILABLE'));tx.onabort=()=>fail(Error('DEVICE_STORAGE_UNAVAILABLE'))})
  }finally{db.close()}
 })().catch(error=>{pending.delete(principal);throw error})
 pending.set(principal,promise);return promise
}
export async function operatorIdentity(principal:string,legacyIds:readonly string[]=[]){const value=await device(principal,legacyIds);return {deviceId:value.id,publicKey:value.publicKey}}
export async function signControl(principal:string,command:Record<string,unknown>,installationId:string){
 const value=await device(principal),expiresAt=Date.now()+120000,{deliveryAttemptId,...semantic}=command
 const message=canonical({domain:'agent-control-human-command-v1',installationId,principal,deviceId:value.id,expiresAt,command:semantic})
 const signature=new Uint8Array(await crypto.subtle.sign('Ed25519',value.privateKey,new TextEncoder().encode(message)))
 const proof={deviceId:value.id,expiresAt,signature:Array.from(signature,b=>b.toString(16).padStart(2,'0')).join('')}
 return btoa(JSON.stringify(proof)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')
}
