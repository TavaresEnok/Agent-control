// Explicit opt-in disposable spool administration. No scan/prune of existing
// files, Docker storage, worktrees, backups, evidence or canonical logs.
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {StoragePool} from '../src/storage.ts';

const root=resolve(new URL('..',import.meta.url).pathname);
if(process.cwd()!==root)throw Error('RUN_FROM_ISOLATED_REPOSITORY');
const [action='status',poolId,principal,...rest]=process.argv.slice(2);
if(!['init','status','plan','apply'].includes(action)||!poolId||!principal||rest.length>0)
 throw Error('USAGE: node --import tsx scripts/storage-lab.mjs <init|status|plan|apply> <pool-uuid> <control-admin-principal>');
if(!/^[a-f0-9-]{36}$/.test(poolId))throw Error('POOL_UUID_REQUIRED');
const url=process.env.AC_TEST_DATABASE_URL;
if(!url)throw Error('AC_TEST_DATABASE_URL_REQUIRED');
const database=new URL(url);
if(database.pathname!=='/ac_implementation_test'||!['db','127.0.0.1','localhost'].includes(database.hostname))throw Error('ISOLATED_DATABASE_REQUIRED');
const base=join(root,'.state','retention-lab'),path=join(base,poolId),planPath=join(base,poolId+'.plan.json');
if(!path.startsWith(join(root,'.state')+sep))throw Error('ISOLATED_SPOOL_REQUIRED');
const ledger=new Ledger(url),pool=new StoragePool(ledger,poolId,path);
try{
 if(action==='init'){
  // Only init creates directories/policies. Repeated init cannot silently
  // replace a policy: expected revision 0 is checked in the ledger.
  await mkdir(base,{recursive:true,mode:0o700});
  if(await realpath(base)!==base)throw Error('SPOOL_PARENT_SYMLINK');
  await mkdir(path,{mode:0o700});
  const revision=await pool.configure(principal,{minFreeBytes:1024**3,budgetBytes:1024**3,maxObjectBytes:16*1024**2},0);
  console.log(JSON.stringify({poolId,revision,scope:'isolated-disposable-spool'}));
 }else if(action==='status')console.log(JSON.stringify(await pool.status(principal),null,2));
 else if(action==='plan'){
  const plan=await pool.plan(principal);await writeFile(planPath,JSON.stringify(plan,null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({dryRun:true,poolId,candidates:plan.candidates.length,bytes:plan.candidates.reduce((sum,c)=>sum+c.bytes,0),digest:plan.digest,planPath},null,2));
 }else{
  if(process.env.AC_STORAGE_APPLY!=='isolated-disposable-spool-only')throw Error('EXPLICIT_APPLY_REQUIRED');
  const plan=JSON.parse(await readFile(planPath,'utf8'));
  console.log(JSON.stringify({scope:'isolated-disposable-spool',...await pool.apply(principal,plan)}));
 }
}finally{await ledger.close();}
