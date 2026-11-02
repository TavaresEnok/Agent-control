// Authenticates and extracts a backup to a NEW directory; never writes a live database/repository.
import { createDecipheriv,createHash,randomBytes } from 'node:crypto';
import { createReadStream,createWriteStream } from 'node:fs';
import { readFile,mkdir,rm,open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { resolve,join } from 'node:path';
const [archiveArg,keyArg]=process.argv.slice(2);
if(!archiveArg||!keyArg)throw Error('USAGE: node scripts/restore-lab.mjs archive key-file');
const root=resolve(new URL('..',import.meta.url).pathname),archive=resolve(archiveArg),keyFile=resolve(keyArg);
const destination=join(root,'.state/restores',Date.now()+'-'+randomBytes(4).toString('hex'));
await mkdir(destination,{recursive:true,mode:0o700});const tarPath=join(destination,'authenticated.tar');
try{
 const file=await open(archive,'r');const prefix=Buffer.alloc(4096);const {bytesRead}=await file.read(prefix,0,prefix.length,0);await file.close();
 const newline=prefix.subarray(0,bytesRead).indexOf(10);if(newline<0)throw Error('INVALID_BACKUP_HEADER');
 const header=prefix.subarray(0,newline+1),parsed=JSON.parse(header.toString('utf8'));
 if(parsed.schemaVersion!==1||parsed.algorithm!=='aes-256-gcm'||typeof parsed.iv!=='string')throw Error('UNSUPPORTED_BACKUP');
 const key=await readFile(keyFile),iv=Buffer.from(parsed.iv,'base64'),tag=await readFile(archive+'.tag');
 if(key.length!==32||iv.length!==12||tag.length!==16)throw Error('INVALID_BACKUP_KEYS');
 const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(header);decipher.setAuthTag(tag);
 await pipeline(createReadStream(archive,{start:newline+1}),decipher,createWriteStream(tarPath,{mode:0o600,flags:'wx'}));
 // Validate every entry before extraction. Reject links/devices and any path outside the new directory.
 execFileSync('python3',['-c',
  "import tarfile,sys,pathlib\nwith tarfile.open(sys.argv[1]) as t:\n for m in t.getmembers():\n  p=pathlib.PurePosixPath(m.name)\n  if p.is_absolute() or '..' in p.parts or not (m.isfile() or m.isdir()): raise SystemExit('UNSAFE_BACKUP_ENTRY')\n  if not (m.name in ('database.dump','MANIFEST.json') or m.name.startswith('.state/')): raise SystemExit('UNEXPECTED_BACKUP_ENTRY')\n",tarPath],{stdio:['ignore','pipe','pipe']});
 execFileSync('tar',['-xf',tarPath,'-C',destination,'--no-same-owner','--no-same-permissions'],{stdio:['ignore','pipe','pipe']});
 const manifest=JSON.parse(await readFile(join(destination,'MANIFEST.json'),'utf8'));
 if(manifest.schemaVersion!==1||manifest.scope!=='isolated-synthetic-lab'||!Array.isArray(manifest.files))throw Error('INVALID_BACKUP_MANIFEST');
 for(const item of manifest.files){
  if(typeof item.path!=='string'||!item.path.startsWith('.state/')||item.path.split('/').includes('..'))throw Error('INVALID_MANIFEST_PATH');
  const hash=createHash('sha256');for await(const chunk of createReadStream(join(destination,item.path)))hash.update(chunk);
  if(hash.digest('hex')!==item.sha256)throw Error('BACKUP_CONTENT_MISMATCH');
 }
 const databaseHash=createHash('sha256');for await(const chunk of createReadStream(join(destination,'database.dump')))databaseHash.update(chunk);
 if(databaseHash.digest('hex')!==manifest.databaseSha256)throw Error('DATABASE_BACKUP_MISMATCH');
 await rm(tarPath);
 console.log(JSON.stringify({authenticated:true,contentVerified:true,destination,scope:manifest.scope,
  admission:'not_started',database:'dump only; not imported',livePathsChanged:false}));
}catch(error){await rm(destination,{recursive:true,force:true});throw error;}
