import {createCipheriv,createDecipheriv,createHash,randomBytes,type KeyObject} from 'node:crypto';
import {open,link,unlink,lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {constants} from 'node:fs';
import {readPrivateWorkerFile} from './native-worker-security.ts';
import {Refusal} from './contracts.ts';

function keyFor(key:KeyObject){const material=key.export({format:'der',type:'pkcs8'});try{return createHash('sha256').update('agent-control:native-redaction-snapshot:v1\n').update(material).digest();}finally{material.fill(0);}}
export async function writeNativeSecretSnapshot(path:string,jobId:string,key:KeyObject,secrets:readonly string[]){
 const clear=Buffer.from(JSON.stringify([...new Set(secrets.filter(Boolean))]));if(clear.length>256*1024)throw new Refusal('NATIVE_REDACTION_SNAPSHOT_INVALID');
 const derived=keyFor(key),nonce=randomBytes(12);try{const cipher=createCipheriv('aes-256-gcm',derived,nonce);cipher.setAAD(Buffer.from(jobId));const ciphertext=Buffer.concat([cipher.update(clear),cipher.final()]);const payload=Buffer.from(JSON.stringify({version:1,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));
  const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(payload);await file.sync();}finally{await file.close();}
 }finally{derived.fill(0);clear.fill(0);}
}
export async function readNativeSecretSnapshot(path:string,jobId:string,key:KeyObject):Promise<string[]>{
 let bytes:Buffer|undefined,clear:Buffer|undefined;const derived=keyFor(key);try{
  bytes=await readPrivateWorkerFile(path,512*1024);const value=JSON.parse(bytes.toString('utf8'));
  if(value.version!==1||typeof value.nonce!=='string'||typeof value.tag!=='string'||typeof value.ciphertext!=='string')throw Error();
  const nonce=Buffer.from(value.nonce,'base64'),tag=Buffer.from(value.tag,'base64');if(nonce.length!==12||tag.length!==16)throw Error();
  const decipher=createDecipheriv('aes-256-gcm',derived,nonce);decipher.setAAD(Buffer.from(jobId));decipher.setAuthTag(tag);clear=Buffer.concat([decipher.update(Buffer.from(value.ciphertext,'base64')),decipher.final()]);const secrets=JSON.parse(clear.toString('utf8'));
  if(!Array.isArray(secrets)||secrets.some(value=>typeof value!=='string'||!value))throw Error();return secrets;
 }catch{throw new Refusal('NATIVE_REDACTION_SNAPSHOT_INVALID');}finally{bytes?.fill(0);clear?.fill(0);derived.fill(0);}
}

/** Preserve a legacy raw log under authenticated encryption while retaining
 * its original SHA. No caller receives plaintext; restart after encryption or
 * unlink is idempotent. The old signed receipt remains untouched. */
export async function quarantineNativeLegacyLog(path:string,jobId:string,key:KeyObject):Promise<string>{
 const quarantine=path+'.quarantine',temporary=quarantine+'.pending',aad=jobId+'\n'+path.split('/').at(-1);const derived=keyFor(key);
 let raw:Buffer|undefined,encrypted:Buffer|undefined,clear:Buffer|undefined;
 try{
  // Recover an interrupted atomic publish without accepting foreign links.
  try{const pending=await lstat(temporary);if(!pending.isFile()||pending.isSymbolicLink()||pending.uid!==process.getuid?.()||(pending.mode&0o077)!==0)throw Error();
   try{const existing=await lstat(quarantine);if(!existing.isFile()||existing.isSymbolicLink()||existing.dev!==pending.dev||existing.ino!==pending.ino||pending.nlink!==2)throw Error();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;if(pending.nlink!==1)throw Error();}
   await unlink(temporary);
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  try{encrypted=await readPrivateWorkerFile(quarantine,2*1024*1024);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(encrypted){const value=JSON.parse(encrypted.toString('utf8'));if(value.version!==1)throw Error();const nonce=Buffer.from(value.nonce,'base64'),tag=Buffer.from(value.tag,'base64');if(nonce.length!==12||tag.length!==16)throw Error();const decipher=createDecipheriv('aes-256-gcm',derived,nonce);decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(tag);clear=Buffer.concat([decipher.update(Buffer.from(value.ciphertext,'base64')),decipher.final()]);
   try{raw=await readPrivateWorkerFile(path,1048576);if(!raw.equals(clear))throw Error();await unlink(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   return createHash('sha256').update(clear).digest('hex');
  }
  raw=await readPrivateWorkerFile(path,1048576);const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',derived,nonce);cipher.setAAD(Buffer.from(aad));const ciphertext=Buffer.concat([cipher.update(raw),cipher.final()]);const payload=Buffer.from(JSON.stringify({version:1,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));
  const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(payload);await file.sync();}finally{await file.close();}
  await link(temporary,quarantine);await unlink(temporary);const directory=await open(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}
  // Authenticate the persisted ciphertext before removing the original.
  encrypted=await readPrivateWorkerFile(quarantine,2*1024*1024);const saved=JSON.parse(encrypted.toString('utf8'));const decipher=createDecipheriv('aes-256-gcm',derived,Buffer.from(saved.nonce,'base64'));decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(Buffer.from(saved.tag,'base64'));clear=Buffer.concat([decipher.update(Buffer.from(saved.ciphertext,'base64')),decipher.final()]);if(!raw.equals(clear))throw Error();
  await unlink(path);return createHash('sha256').update(raw).digest('hex');
 }catch{throw new Refusal('NATIVE_LEGACY_LOG_QUARANTINE_INVALID');}finally{raw?.fill(0);clear?.fill(0);encrypted?.fill(0);derived.fill(0);}
}

/** Do not register a legacy artifact when its credential set cannot be
 * reconstructed. Physical retirement remains a separate operation. */
export async function readNativeArtifactSecrets(path:string,jobId:string,key:KeyObject):Promise<string[]>{
 try{return await readNativeSecretSnapshot(path,jobId,key);}catch{throw new Refusal('NATIVE_ARTIFACT_SECRET_SCAN_UNAVAILABLE');}
}
