import {constants} from 'node:fs';
import {open,readFile,lstat,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {createPublicKey,verify,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {canonical,digest} from './contracts.ts';

/** Fixed-path workers use these helpers after admission by their supervisor. */
export function initializeNativeWorkerEnvironment(proxyUrl?:'http://provider-egress:8080'){
 for(const name of Object.keys(process.env))delete process.env[name];
 Object.assign(process.env,{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/account',CODEX_HOME:'/account/.codex',TMPDIR:'/tmp',
  CEZ_TELEMETRY:'0',CEZ_AUTONAME:'0',CEZ_AUTOMATIONS:'0',CEZ_SKILLS_AUTO_UPDATE:'0',CEZ_NO_BANNER:'1',DO_NOT_TRACK:'1'});
 if(proxyUrl)Object.assign(process.env,{HTTPS_PROXY:proxyUrl,HTTP_PROXY:proxyUrl,NO_PROXY:'127.0.0.1,localhost'});
}
export async function readPrivateWorkerFile(path:string,maxBytes:number){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0)throw Error('INVALID_WORKER_PRIVATE_FILE');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const info=await file.stat();if(!info.isFile()||info.nlink!==1||(info.mode&0o077)!==0||info.uid!==process.getuid?.()||info.size>maxBytes)throw Error('INVALID_WORKER_PRIVATE_FILE');
  // Enforce the limit during the read too: the file may grow after stat().
  const bytes=Buffer.alloc(maxBytes+1);let length=0;
  try{while(length<bytes.length){const result=await file.read(bytes,length,bytes.length-length,null);if(result.bytesRead===0)break;length+=result.bytesRead;}
   if(length>maxBytes)throw Error('INVALID_WORKER_PRIVATE_FILE');
   return Buffer.from(bytes.subarray(0,length));
  }finally{bytes.fill(0);}
 }finally{await file.close();}
}
export async function readSignedWorkerLaunch<S extends z.ZodType>(schema:S,domain:string,inputPath='/input/launch.json',publicKeyPath='/runner/planning-public-key.pem'):Promise<z.output<S>>{
 const bytes=await readPrivateWorkerFile(inputPath,512*1024);
 try{
  const signed=z.object({payload:z.unknown(),signature:z.string().regex(/^[a-f0-9]{128}$/)}).strict().parse(JSON.parse(bytes.toString('utf8')));
  const payload=schema.parse(signed.payload) as z.output<S>;
  const publicBytes=await readFile(publicKeyPath);if(publicBytes.length>4096)throw Error('INVALID_WORKER_KEY');
  const key=createPublicKey(publicBytes);if(key.asymmetricKeyType!=='ed25519'||!verify(null,Buffer.from(domain+'\n'+canonical(payload)),key,Buffer.from(signed.signature,'hex')))throw Error('INVALID_WORKER_SIGNATURE');
  return payload;
 }finally{bytes.fill(0);}
}
/** The subject is an account identifier digest, not an OAuth token or balance. */
export async function assertCodexSubscriptionIdentity(expected:string,accountRoot='/account'){
 try{await lstat(join(accountRoot,'.codex/config.toml'));throw Error('CUSTOM_CODEX_CONFIG_FORBIDDEN');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const bytes=await readPrivateWorkerFile(join(accountRoot,'.codex/auth.json'),65536);
 try{
  const auth=z.object({auth_mode:z.literal('chatgpt'),OPENAI_API_KEY:z.null().optional(),tokens:z.object({account_id:z.string().min(1),access_token:z.string().min(1),refresh_token:z.string().min(1)}).passthrough()}).passthrough().parse(JSON.parse(bytes.toString('utf8')));
  if(digest({provider:'codex',subject:auth.tokens.account_id})!==expected)throw Error('WORKER_ACCOUNT_IDENTITY_MISMATCH');
  // All string leaves in the structured credential container are sensitive,
  // including supported id tokens and future token fields.
  const strings=(value:unknown):string[]=>typeof value==='string'?[value]:Array.isArray(value)?value.flatMap(strings):value&&typeof value==='object'?Object.values(value).flatMap(strings):[];
  const {account_id,access_token,...otherTokens}=auth.tokens;
  return {accountId:account_id,accessToken:access_token,secrets:strings({access_token,...otherTokens}).filter(Boolean)};
 }finally{bytes.fill(0);}
}

/** Validate the controller's snapshot binding before giving any credential to
 * the child, then point CODEX_HOME at a new private directory in its tmpfs. */
export async function prepareNativeExternalAuth(secrets:readonly string[],token:string,expectedTag:string,tmpRoot='/tmp'){
 if(!/^[a-f0-9]{64}$/.test(expectedTag))throw Error('WORKER_CREDENTIAL_SNAPSHOT_CHANGED');
 const actual=createHmac('sha256',token).update(canonical(secrets)).digest();
 if(!timingSafeEqual(actual,Buffer.from(expectedTag,'hex')))throw Error('WORKER_CREDENTIAL_SNAPSHOT_CHANGED');
 return mkdtemp(join(tmpRoot,'ac-codex-external-'));
}
