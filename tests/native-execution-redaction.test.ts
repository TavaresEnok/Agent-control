import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {redactNativeDockerLogs,redactNativeLogsOrWithhold,assertNoNativeTaskSecrets} from '../src/native-execution-redaction.ts';
const frame=(id:number,text:string)=>{const data=Buffer.from(text),head=Buffer.alloc(8);head[0]=id;head.writeUInt32BE(data.length,4);return Buffer.concat([head,data]);};
test('Docker log sanitizer redacts split known secrets per stream and refuses malformed frames',()=>{
 const token='synthetic-token-'+randomBytes(20).toString('hex');
 const raw=Buffer.concat([frame(1,'before '+token.slice(0,15)),frame(2,'other stream'),frame(1,token.slice(15)+' after')]);
 const safe=redactNativeDockerLogs(raw,[token]);assert(!safe.includes(Buffer.from(token)));assert(safe.includes(Buffer.from('before [REDACTED] after')));assert(safe.includes(Buffer.from('other stream')));
 assert.throws(()=>assert(!Buffer.concat([raw.subarray(8,8+7),Buffer.from(token)]).includes(Buffer.from(token))),'negative control detects known secret');
 for(const crossFrames of [[frame(1,token.slice(0,12)),frame(2,token.slice(12))],[frame(2,token.slice(0,12)),frame(1,token.slice(12))],[frame(1,token.slice(0,8)),frame(2,token.slice(8,16)),frame(1,token.slice(16,24)),frame(2,token.slice(24))]]){const cross=redactNativeDockerLogs(Buffer.concat(crossFrames),[token]);assert(cross.includes(Buffer.from('NATIVE_LOGS_WITHHELD_CROSS_STREAM_SECRET')));assert(!cross.includes(Buffer.from(token)));}
 for(const bad of [Buffer.from([1,0]),Buffer.from([3,0,0,0,0,0,0,0]),Buffer.from([1,0,0,0,0,0,0,1]),Buffer.from([1,0,0,0,0,0,0,1,255])])assert.throws(()=>redactNativeDockerLogs(bad,[token]),/NATIVE_RETIREMENT_LOG_INVALID/);
});

test('secret snapshots are encrypted, bound to the job and detect tampering',async()=>{
 const {generateKeyPairSync}=await import('node:crypto'),{mkdtemp,readFile,writeFile,rm}=await import('node:fs/promises'),{join}=await import('node:path');
 const {writeNativeSecretSnapshot,readNativeSecretSnapshot}=await import('../src/native-execution-secret-snapshot.ts');
 const root=await mkdtemp('/tmp/ac-redaction-'),path=join(root,'secrets'),key=generateKeyPairSync('ed25519').privateKey,secret='synthetic-'+randomBytes(24).toString('hex');
 try{await writeNativeSecretSnapshot(path,'job-a',key,[secret]);const bytes=await readFile(path);assert(!bytes.includes(Buffer.from(secret)));assert.deepEqual(await readNativeSecretSnapshot(path,'job-a',key),[secret]);await assert.rejects(readNativeSecretSnapshot(path,'job-b',key),/NATIVE_REDACTION_SNAPSHOT_INVALID/);const envelope=JSON.parse(bytes.toString());envelope.tag=Buffer.alloc(16).toString('base64');await writeFile(path,JSON.stringify(envelope));await assert.rejects(readNativeSecretSnapshot(path,'job-a',key),/NATIVE_REDACTION_SNAPSHOT_INVALID/);}finally{await rm(root,{recursive:true,force:true});}
});

test('missing or corrupt legacy redaction context archives only a fixed diagnostic',async()=>{const raw=frame(1,'synthetic-credential');const saved=await redactNativeLogsOrWithhold(raw,async()=>{throw Error('missing');});assert(!saved.includes(Buffer.from('synthetic-credential')));assert(saved.includes(Buffer.from('NATIVE_LOGS_WITHHELD_REDACTION_CONTEXT_UNAVAILABLE')));});

test('legacy log quarantine preserves original digest, removes plaintext, and replays idempotently',async()=>{
 const {generateKeyPairSync,createHash}=await import('node:crypto'),{mkdtemp,readFile,writeFile,rm,stat}=await import('node:fs/promises'),{join}=await import('node:path');
 const {quarantineNativeLegacyLog}=await import('../src/native-execution-secret-snapshot.ts');const root=await mkdtemp('/tmp/ac-log-quarantine-'),path=join(root,'worker-terminal.log'),key=generateKeyPairSync('ed25519').privateKey,secret='synthetic-'+randomBytes(24).toString('hex'),raw=frame(1,'private '+secret);const expected=createHash('sha256').update(raw).digest('hex');
 try{await writeFile(path,raw,{mode:0o600});assert.equal(await quarantineNativeLegacyLog(path,'job',key),expected);await assert.rejects(stat(path),{code:'ENOENT'});const sealed=await readFile(path+'.quarantine');assert(!sealed.includes(Buffer.from(secret)));assert.equal(await quarantineNativeLegacyLog(path,'job',key),expected);await assert.rejects(quarantineNativeLegacyLog(path,'other-job',key),/NATIVE_LEGACY_LOG_QUARANTINE_INVALID/);}
 finally{await rm(root,{recursive:true,force:true});}
});

test('legacy quarantine recovers interrupted publish and post-encryption cuts',async()=>{
 const {generateKeyPairSync,createHash}=await import('node:crypto'),{mkdtemp,writeFile,rm,link,stat}=await import('node:fs/promises'),{join}=await import('node:path');const {quarantineNativeLegacyLog}=await import('../src/native-execution-secret-snapshot.ts');
 const root=await mkdtemp('/tmp/ac-log-crash-'),path=join(root,'worker-terminal.log'),key=generateKeyPairSync('ed25519').privateKey,raw=frame(1,'legacy-private-content'),hash=createHash('sha256').update(raw).digest('hex');
 try{await writeFile(path,raw,{mode:0o600});await writeFile(path+'.quarantine.pending','incomplete',{mode:0o600});assert.equal(await quarantineNativeLegacyLog(path,'job',key),hash);
  await link(path+'.quarantine',path+'.quarantine.pending');await writeFile(path,raw,{mode:0o600});assert.equal(await quarantineNativeLegacyLog(path,'job',key),hash);await assert.rejects(stat(path),{code:'ENOENT'});await assert.rejects(stat(path+'.quarantine.pending'),{code:'ENOENT'});assert.equal((await stat(path+'.quarantine')).nlink,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('known credential in task is refused before launch; safe task remains valid',()=>{const secret='synthetic-'+randomBytes(24).toString('hex');assert.throws(()=>assertNoNativeTaskSecrets('please use '+secret,[secret]),/NATIVE_EXECUTION_SECRET_IN_TASK/);assert.doesNotThrow(()=>assertNoNativeTaskSecrets('safe request',[secret]));});

test('legacy artifact without redaction snapshot is held with explicit diagnostic',async()=>{const {generateKeyPairSync}=await import('node:crypto'),{readNativeArtifactSecrets}=await import('../src/native-execution-secret-snapshot.ts');await assert.rejects(readNativeArtifactSecrets('/tmp/ac-absent-'+randomBytes(16).toString('hex'),'job',generateKeyPairSync('ed25519').privateKey),/NATIVE_ARTIFACT_SECRET_SCAN_UNAVAILABLE/);});
