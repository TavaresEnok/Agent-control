// Backup of this isolated laboratory only. Production quiescence/key custody remain separate gates.
import { createCipheriv,createHash,randomBytes } from 'node:crypto';
import { createReadStream,createWriteStream } from 'node:fs';
import { mkdir,readFile,writeFile,stat,lstat,readdir,rm } from 'node:fs/promises';
import { spawn,execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { resolve,join } from 'node:path';
const root=resolve(new URL('..',import.meta.url).pathname);
if(process.cwd()!==root)throw Error('RUN_FROM_ISOLATED_REPOSITORY');
const compose=['compose','-f','deploy/compose.lab.yml'];
const running=execFileSync('docker',[...compose,'ps','--status','running','--services'],{encoding:'utf8'}).trim().split('\n');
if(running.some(service=>service&&service!=='db'))throw Error('LAB_EXECUTORS_MUST_BE_STOPPED');
if(!running.includes('db'))throw Error('ISOLATED_DATABASE_MUST_BE_RUNNING');
const backupId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(4).toString('hex');
const base=join(root,'.state/backups'),work=join(base,'staging-'+backupId),archive=join(base,backupId+'.acbackup'),keyFile=join(base,'keys',backupId+'.key');
await mkdir(work,{recursive:true,mode:0o700});await mkdir(join(base,'keys'),{recursive:true,mode:0o700});
const files=[];
async function scan(relative){
 const absolute=join(root,relative),info=await lstat(absolute);
 if(info.isSymbolicLink()||(!info.isDirectory()&&!info.isFile()))throw Error('SPECIAL_BACKUP_SOURCE_REFUSED');
 if(info.isDirectory()){for(const name of (await readdir(absolute)).sort())await scan(join(relative,name));return;}
 const hash=createHash('sha256');for await(const chunk of createReadStream(absolute))hash.update(chunk);
 files.push({path:relative,size:info.size,sha256:hash.digest('hex')});
}
try{
 const sources=['.state/happier','.state/projects','.state/browser-fixture.json'],missingOptional=[];
 try{await lstat(join(root,'.state/keys'));sources.push('.state/keys');}
 catch(error){if(error.code!=='ENOENT')throw error;missingOptional.push('.state/keys');}
 for(const source of sources)await scan(source);
 const dump=spawn('docker',[...compose,'exec','-T','db','pg_dump','-U','ac_lab','-d','ac_implementation_test','-Fc'],{stdio:['ignore','pipe','inherit']});
 const dumpDone=new Promise((ok,fail)=>{dump.once('error',fail);dump.once('exit',code=>code===0?ok():fail(Error('PG_DUMP_FAILED')));});
 await Promise.all([pipeline(dump.stdout,createWriteStream(join(work,'database.dump'),{mode:0o600})),dumpDone]);
 const databaseHash=createHash('sha256');for await(const chunk of createReadStream(join(work,'database.dump')))databaseHash.update(chunk);
 const manifest={schemaVersion:1,scope:'isolated-synthetic-lab',backupId,root,createdAt:new Date().toISOString(),
  commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sources,missingOptional,files,databaseSha256:databaseHash.digest('hex'),
  limitation:'Requires the same isolated root for absolute Git worktree links. No production restore/admission is authorized.'};
 await writeFile(join(work,'MANIFEST.json'),JSON.stringify(manifest,null,2),{mode:0o600});
 const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const header=Buffer.from(JSON.stringify({schemaVersion:1,backupId,algorithm:'aes-256-gcm',iv:iv.toString('base64')})+'\n');
 cipher.setAAD(header);
 await writeFile(keyFile,key,{mode:0o600,flag:'wx'});
 const output=createWriteStream(archive,{mode:0o600,flags:'wx'});output.write(header);
 const tar=spawn('tar',['-cf','-','-C',root,...sources,'-C',work,'database.dump','MANIFEST.json'],{stdio:['ignore','pipe','inherit']});
 const tarDone=new Promise((ok,fail)=>{tar.once('error',fail);tar.once('exit',code=>code===0?ok():fail(Error('ARCHIVE_FAILED')));});
 await Promise.all([pipeline(tar.stdout,cipher,output),tarDone]);
 await writeFile(archive+'.tag',cipher.getAuthTag(),{mode:0o600,flag:'wx'});
 const hash=createHash('sha256');for await(const chunk of createReadStream(archive))hash.update(chunk);
 const result={scope:manifest.scope,archive,tagFile:archive+'.tag',keyFile,sha256:hash.digest('hex'),sourceFiles:files.length,
  size:(await stat(archive)).size,warning:'Key material is local and separate from the archive. Off-host custody is not provided.'};
 await writeFile(archive+'.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
}catch(error){for(const path of [archive,archive+'.tag',archive+'.json',keyFile])await rm(path,{force:true});throw error;}
finally{await rm(work,{recursive:true,force:true});}
