import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,open,readFile,readdir,lstat,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {z} from 'zod';
const cache='/tmp/ac-close-base/upstream/happier',server=join(cache,'apps/server');
let provenance:Promise<void>|undefined;
function verifyProvenance(){return provenance??=(async()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url)),exec=promisify(execFile),paths=(await exec('git',['ls-files','upstream/happier/apps/server/sources','upstream/happier/apps/server/scripts','upstream/happier/apps/server/prisma'],{cwd:root,maxBuffer:1024*1024})).stdout.trim().split('\n'),digest=createHash('sha256');
 for(const path of paths){const local=await readFile(join(root,path)),cached=await readFile(join('/tmp/ac-close-base',path));if(!local.equals(cached))throw Error('R3_HAPPIER_CACHE_SOURCE_MISMATCH '+path);digest.update(path+'\0');digest.update(createHash('sha256').update(local).digest());}
 const sourceSha256=digest.digest('hex');if(paths.length!==1164||sourceSha256!=='6084780b8c5211f3477f3783fbe06334de863158476ce022cc42331fa797b6a5')throw Error('R3_HAPPIER_SOURCE_PIN_CHANGED');
 const tree=(await exec('git',['rev-parse','HEAD:upstream/happier'],{cwd:root})).stdout.trim();console.log('R3_HAPPIER_SOURCE_PROVENANCE '+JSON.stringify({tree,files:paths.length,sourceSha256,cacheMatchesVendored:true}));
 })();}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function port(){const listener=net.createServer();await new Promise<void>((ok,fail)=>listener.once('error',fail).listen(0,'127.0.0.1',ok));const value=(listener.address() as net.AddressInfo).port;await new Promise<void>((ok,fail)=>listener.close(error=>error?fail(error):ok()));return value;}
export class RecoveryHappier {
 private child?:ChildProcess;private stoppedVerified=false;origin='';
 constructor(readonly directory:string,readonly home:string){}
 async start(migrate=true){
  await verifyProvenance();this.stoppedVerified=false;await mkdir(this.directory,{recursive:true,mode:0o700});await mkdir(this.home,{recursive:true,mode:0o700});const httpPort=await port();this.origin='http://127.0.0.1:'+httpPort;
  const env={HOME:this.home,PATH:'/tmp/node-v22.23.3-linux-x64/bin:/home/app/.local/share/node24/bin:/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC',DOTENV_CONFIG_PATH:'/dev/null',CI:'1',DO_NOT_TRACK:'1',EXPO_NO_TELEMETRY:'1',PORT:String(httpPort),METRICS_ENABLED:'false',AUTH_ANONYMOUS_SIGNUP_ENABLED:'true',HAPPIER_FILES_BACKEND:'local',HAPPIER_DB_PROVIDER:'sqlite',HAPPY_DB_PROVIDER:'sqlite',HAPPIER_SERVER_LIGHT_DATA_DIR:this.directory,HAPPIER_SERVER_HOST:'127.0.0.1',HAPPY_SERVER_HOST:'127.0.0.1',DATABASE_URL:`file:${this.directory}/server.sqlite?socket_timeout=30&connection_limit=1`,HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY:'required_e2ee'};
  const args=[join(cache,'node_modules/tsx/dist/cli.mjs'),'--tsconfig',join(server,'tsconfig.json'),join(server,'sources/main.light.ts')];
  const log=await open(join(this.home,'server.log'),'a',0o600);
  try{
   if(migrate){const migrationScript=join(this.home,'migrate.mts');await writeFile(migrationScript,`import {applySqliteMigrations} from ${JSON.stringify(join(server,'scripts/prismaMigrations.ts'))};await applySqliteMigrations({databasePath:${JSON.stringify(join(this.directory,'server.sqlite'))},migrationsDir:${JSON.stringify(join(server,'prisma/sqlite/migrations'))}});`,{mode:0o600,flag:'wx'});const migration=spawn(process.execPath,[args[0]!,'--tsconfig',join(server,'tsconfig.json'),migrationScript],{cwd:server,env,stdio:['ignore',log.fd,log.fd]});const done=await once(migration,'exit');if(done[0]!==0)throw Error('R3_HAPPIER_MIGRATION_FAILED '+(await readFile(join(this.home,'server.log'),'utf8')).slice(-5000));}
   this.child=spawn(process.execPath,args,{cwd:server,env,stdio:['ignore',log.fd,log.fd],detached:true});
  }finally{await log.close();}
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){if(this.child.exitCode!==null)throw Error('R3_HAPPIER_EXITED '+(await readFile(join(this.home,'server.log'),'utf8')).slice(-5000));try{const result=await fetch(this.origin+'/v1/account/profile',{signal:AbortSignal.timeout(500)});if(result.status===401)return;}catch{}await new Promise(ok=>setTimeout(ok,100));}
  throw Error('R3_HAPPIER_START_TIMEOUT '+(await readFile(join(this.home,'server.log'),'utf8')).slice(-5000));
 }
 async stop(){const child=this.child;if(!child?.pid)return;const group=child.pid;
  const active=async()=>{for(const pid of await readdir('/proc')){if(!/^\d+$/.test(pid))continue;try{const stat=await readFile('/proc/'+pid+'/stat','utf8'),parts=stat.slice(stat.lastIndexOf(')')+2).split(' ');if(Number(parts[2])===group&&parts[0]!=='Z')return true;}catch{}}return false;};
  if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');process.kill(-group,'SIGTERM');await Promise.race([exit,new Promise(ok=>setTimeout(ok,3000))]);}
  if(await active()){try{process.kill(-group,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}
  const end=Date.now()+2000;while(await active()){if(Date.now()>end)throw Error('R3_HAPPIER_GROUP_STILL_ACTIVE');await new Promise(ok=>setTimeout(ok,25));}
  this.child=undefined;this.stoppedVerified=true;
 }
 async snapshot(file:string){if(this.child||!this.stoppedVerified)throw Error('R3_HAPPIER_MUST_BE_STOPPED');const files:{path:string;sha256:string;bytes:string}[]=[];
  const walk=async(relative:string)=>{for(const name of (await readdir(join(this.directory,relative))).sort()){const path=join(relative,name),absolute=join(this.directory,path),stat=await lstat(absolute);if(stat.isSymbolicLink())throw Error('R3_HAPPIER_SYMLINK_REFUSED');if(stat.isDirectory())await walk(path);else if(stat.isFile()){const bytes=await readFile(absolute);if(bytes.length>16*1024*1024||files.length>=128)throw Error('R3_HAPPIER_SNAPSHOT_LIMIT');files.push({path,sha256:hash(bytes),bytes:bytes.toString('base64')});}else throw Error('R3_HAPPIER_SPECIAL_FILE_REFUSED');}};
  await walk('');await writeFile(file,JSON.stringify({schemaVersion:1,scope:'ac-r3-happier-stopped',capturedAt:new Date().toISOString(),files}),{mode:0o600,flag:'wx'});return files.length;
 }
 async restore(file:string){const payload=z.object({schemaVersion:z.literal(1),scope:z.literal('ac-r3-happier-stopped'),capturedAt:z.string().datetime(),files:z.array(z.object({path:z.string().regex(/^[A-Za-z0-9_.\/-]+$/).refine(path=>!path.startsWith('/')&&!path.split('/').includes('..')),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.string().max(24*1024*1024)}).strict()).max(128)}).strict().parse(JSON.parse(await readFile(file,'utf8')));
  await mkdir(this.directory,{mode:0o700});for(const entry of payload.files){const bytes=Buffer.from(entry.bytes,'base64');if(hash(bytes)!==entry.sha256)throw Error('R3_HAPPIER_SNAPSHOT_HASH');const target=join(this.directory,entry.path);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{mode:0o600,flag:'wx'});}return payload;
 }
}
