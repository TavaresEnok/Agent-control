import {constants} from 'node:fs';
import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,rm,lstat,realpath,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {z} from 'zod';
import {Ledger} from './ledger.ts';
import {Refusal} from './contracts.ts';

const exec=promisify(execFile),limit=32*1024*1024,scope='ac-r3-migration-disposable-recovery-v1';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const Envelope=z.object({scope:z.literal(scope),sourceDatabase:z.string().regex(/^ac_implementation_test_r3[a-z0-9_]+$/),sourceInstallationId:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),nonce:z.string().length(24),tag:z.string().length(32),ciphertext:z.string().max(limit*2)}).strict();
async function docker(container:string,args:string[]){return exec('docker',['exec',container,...args],{encoding:'buffer',timeout:30000,maxBuffer:limit});}
async function validateContainer(container:string,connectionString:string){
 if(!/^[a-f0-9]{64}$/.test(container))throw new Refusal('RECOVERY_DISPOSABLE_CONTAINER_REQUIRED');
 const inspect=JSON.parse((await exec('docker',['inspect',container],{timeout:5000,maxBuffer:65536})).stdout)[0];
 const url=new URL(connectionString),ports=inspect.NetworkSettings?.Ports?.['5432/tcp'];
 if(inspect.Config?.Labels?.['ac.r3.front']!=='migration'||inspect.Config?.Labels?.['ac.disposable']!=='true'||
  !['127.0.0.1','localhost'].includes(url.hostname)||!ports?.some((port:any)=>port.HostIp==='127.0.0.1'&&port.HostPort===url.port)||decodeURIComponent(url.username)!=='postgres')throw new Refusal('RECOVERY_DISPOSABLE_CONTAINER_REQUIRED');
 return url;
}
async function privateBytes(path:string,max=limit){
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||stat.size>max)throw new Refusal('RECOVERY_PRIVATE_FILE_REQUIRED');const bytes=await file.readFile();if(bytes.length>max)throw new Refusal('RECOVERY_PRIVATE_FILE_REQUIRED');return bytes;}finally{await file.close();}
}
/** Fresh labelled laboratory only. Existing backup/vault tools remain the operational gate.
 * The source must already be quiescent; this helper never closes a live installation. */
export async function backupLaboratoryDatabase(options:{containerId:string;sourceUrl:string;directory:string;canonicalHistoryFile:string;vaultArchiveFile:string}){
 const url=await validateContainer(options.containerId,options.sourceUrl),name=url.pathname.slice(1);
 if(!/^ac_implementation_test_r3[a-z0-9_]+$/.test(name))throw new Refusal('RECOVERY_SOURCE_DATABASE_REQUIRED');
 if(resolve(options.directory)!==options.directory||await realpath(options.directory)!==options.directory)throw new Refusal('RECOVERY_DIRECTORY_REQUIRED');
 const info=await lstat(options.directory);if(!info.isDirectory()||(info.mode&0o077)!==0||info.uid!==process.getuid?.())throw new Refusal('RECOVERY_DIRECTORY_REQUIRED');
 const ledger=new Ledger(options.sourceUrl);let sourceInstallationId:string;
 try{
  if((await ledger.pool.query('SELECT enabled FROM ac_admission_control WHERE id=1')).rows[0]?.enabled!==false||
   (await ledger.pool.query('SELECT 1 FROM ac_managers WHERE lease_until>clock_timestamp()')).rowCount||
   (await ledger.pool.query("SELECT 1 FROM ac_accounts WHERE mode<>'synthetic'")).rowCount||
   (await ledger.pool.query("SELECT 1 FROM ac_import_batches WHERE state='staging'")).rowCount)throw new Refusal('RECOVERY_SOURCE_MUST_BE_QUIESCENT_SYNTHETIC');
  sourceInstallationId=(await ledger.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id;
 }finally{await ledger.pool.end();}
 const dump=(await docker(options.containerId,['pg_dump','-U','postgres','-d',name,'-Fc'])).stdout;
 const key=randomBytes(32),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce),header={scope,sourceDatabase:name,sourceInstallationId,sha256:sha(dump)};
 const history=await privateBytes(options.canonicalHistoryFile),vault=await privateBytes(options.vaultArchiveFile);
 const payload=Buffer.from(JSON.stringify({database:dump.toString('base64'),canonicalHistory:history.toString('base64'),vaultArchive:vault.toString('base64')}));
 cipher.setAAD(Buffer.from(JSON.stringify(header)));const ciphertext=Buffer.concat([cipher.update(payload),cipher.final()]);payload.fill(0);history.fill(0);vault.fill(0);
 const basename='ac-r3-recovery-'+randomUUID(),archiveFile=join(options.directory,basename+'.json'),keyFile=join(options.directory,basename+'.key');
 try{await writeFile(keyFile,key,{mode:0o600,flag:'wx'});await writeFile(archiveFile,JSON.stringify({...header,nonce:nonce.toString('hex'),tag:cipher.getAuthTag().toString('hex'),ciphertext:ciphertext.toString('base64')}),{mode:0o600,flag:'wx'});return {archiveFile,keyFile,sha256:header.sha256,sourceInstallationId};}
 finally{key.fill(0);dump.fill(0);ciphertext.fill(0);}
}
/** Restore only to a generated fresh DB. The old installation identity DATA is omitted via
 * pg_restore TOC; a new identity is inserted without bypassing the immutable identity trigger. */
export async function restoreLaboratoryDatabase(options:{containerId:string;sourceUrl:string;archiveFile:string;keyFile:string;directory:string}){
 const url=await validateContainer(options.containerId,options.sourceUrl);
 const envelope=Envelope.parse(JSON.parse((await privateBytes(options.archiveFile)).toString('utf8'))),key=await privateBytes(options.keyFile,32);
 const {scope:archiveScope,sourceDatabase,sourceInstallationId,sha256,nonce,tag,ciphertext}=envelope;
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(nonce,'hex'));
 decipher.setAAD(Buffer.from(JSON.stringify({scope:archiveScope,sourceDatabase,sourceInstallationId,sha256})));decipher.setAuthTag(Buffer.from(tag,'hex'));
 let payloadBytes:Buffer;
 try{payloadBytes=Buffer.concat([decipher.update(Buffer.from(ciphertext,'base64')),decipher.final()]);}catch{throw new Refusal('RECOVERY_ARCHIVE_AUTHENTICATION_FAILED');}finally{key.fill(0);}
 if(sourceDatabase!==url.pathname.slice(1))throw new Refusal('RECOVERY_SOURCE_DATABASE_MISMATCH');
 const payload=z.object({database:z.string().max(limit*2),canonicalHistory:z.string().max(limit*2),vaultArchive:z.string().max(limit*2)}).strict().parse(JSON.parse(payloadBytes.toString('utf8')));payloadBytes.fill(0);
 const dump=Buffer.from(payload.database,'base64');
 if(sha(dump)!==sha256)throw new Refusal('RECOVERY_DUMP_DIGEST_MISMATCH');
 const suffix=randomUUID().replaceAll('-',''),database='ac_r3_restore_'+suffix,containerDirectory='/tmp/ac-r3-recovery-'+suffix,local=join(options.directory,'restore-'+suffix);
 const target=new URL(url);target.pathname='/'+database;
 if(resolve(options.directory)!==options.directory||await realpath(options.directory)!==options.directory||((await lstat(options.directory)).mode&0o077)!==0)throw new Refusal('RECOVERY_DIRECTORY_REQUIRED');
 const artifactsDirectory=join(options.directory,'recovered-artifacts-'+suffix);
 const admin=new pg.Client({connectionString:options.sourceUrl});await admin.connect();
 let created=false;
 try{
  await mkdir(local,{mode:0o700});await writeFile(join(local,'database.dump'),dump,{mode:0o600,flag:'wx'});dump.fill(0);
  await docker(options.containerId,['mkdir',containerDirectory]);
  await exec('docker',['cp',join(local,'database.dump'),options.containerId+':'+containerDirectory+'/database.dump'],{timeout:10000});
  const toc=(await docker(options.containerId,['pg_restore','--list',containerDirectory+'/database.dump'])).stdout.toString('utf8');
  const lines=toc.split('\n'),identity=lines.filter(line=>/^\d+;.* TABLE DATA public ac_installation_identity /.test(line));
  if(identity.length!==1)throw new Refusal('RECOVERY_IDENTITY_TOC_INVALID');
  await writeFile(join(local,'restore.list'),lines.filter(line=>line!==identity[0]).join('\n'),{mode:0o600,flag:'wx'});
  await exec('docker',['cp',join(local,'restore.list'),options.containerId+':'+containerDirectory+'/restore.list'],{timeout:10000});
  await admin.query(`CREATE DATABASE "${database}"`);created=true;
  await docker(options.containerId,['pg_restore','-U','postgres','--no-owner','--no-acl','--exit-on-error','--use-list',containerDirectory+'/restore.list','-d',database,containerDirectory+'/database.dump']);
  const restored=new Ledger(target.href),installationId=randomUUID();
  try{await restored.tx(async c=>{
   await c.query('INSERT INTO ac_installation_identity(singleton,id) VALUES(true,$1)',[installationId]);
   await c.query("UPDATE ac_admission_control SET enabled=false,revision=revision+1,reason='r3-restored-awaiting-reconciliation',updated_at=clock_timestamp() WHERE id=1");
   await c.query('UPDATE ac_contexts SET paused=true,pause_revision=pause_revision+1');
   await c.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second'");
   await c.query("UPDATE ac_capacity_grants SET state='uncertain' WHERE state<>'released'");
   await c.query("UPDATE ac_quota_observations SET status='unknown',source='r3-restored-awaiting-probe',expires_at=clock_timestamp()");
   await c.query('UPDATE ac_browser_sessions SET revoked=true');await c.query('UPDATE ac_operator_bootstrap SET used=true');
   await c.query("UPDATE ac_installation_reservations SET state='uncertain' WHERE state<>'released'");
   await c.query("UPDATE ac_installation_refreshes SET state='uncertain' WHERE state<>'finished'");
   await c.query('UPDATE ac_installation_domains SET paused=true,epoch=epoch+1');
   await c.query("INSERT INTO ac_installation_history(domain_id,kind,detail) SELECT id,'installation.restored',$1 FROM ac_installation_domains",[{sourceInstallationId,installationId,admission:'closed'}]);
  });}finally{await restored.pool.end();}
  await mkdir(artifactsDirectory,{mode:0o700});
  await writeFile(join(artifactsDirectory,'canonical-history.json'),Buffer.from(payload.canonicalHistory,'base64'),{mode:0o600,flag:'wx'});
  await writeFile(join(artifactsDirectory,'context-vault.archive'),Buffer.from(payload.vaultArchive,'base64'),{mode:0o600,flag:'wx'});
  return {database,url:target.href,artifactsDirectory,installationId,sourceInstallationId,admission:'closed' as const,physicalReconciliation:'required' as const,vaultActivation:'blocked-until-rewrapped' as const};
 }catch(error){await rm(artifactsDirectory,{recursive:true,force:true});if(created)await admin.query(`DROP DATABASE "${database}"`);throw error;}
 finally{await admin.end();await rm(local,{recursive:true,force:true});await docker(options.containerId,['rm','-rf',containerDirectory]);}
}
