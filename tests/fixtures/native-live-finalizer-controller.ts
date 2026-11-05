import {readFile} from 'node:fs/promises';
import {Ledger} from '../../src/ledger.ts';
import {NativeArtifactFinalizer} from '../../src/native-artifact-finalizer.ts';

const file=process.argv[2];
if(!file||!/^\/tmp\/ac-finalizer-live-[^/]+\/controller\.json$/.test(file))throw Error('ISOLATED_FINALIZER_FIXTURE_REQUIRED');
const f=JSON.parse(await readFile(file,'utf8')),url=new URL(f.url);
if(!['db','127.0.0.1','localhost'].includes(url.hostname)||!/^\/ac_implementation_test_livefinalizer_[a-f0-9]{20}$/.test(url.pathname))throw Error('ISOLATED_DATABASE_REQUIRED');
const db=new Ledger(f.url);
try{
 let checks=0;
 await new NativeArtifactFinalizer(db,f.root).finalize(f.principal,f.authority,f.binding,async()=>{
  if(++checks!==2)return;
  // Freeze the actual spawned Ruby before input is released. The parent test
  // observes the committed handle, then kills this controller process.
  const children=(await readFile(`/proc/self/task/${process.pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean);
  if(children.length!==1)throw Error('RUBY_CHILD_NOT_UNIQUE');
  const pid=Number(children[0]);
  const cmd=await readFile(`/proc/${pid}/cmdline`,'utf8');
  if(!cmd.includes('native_finalize.rb'))throw Error('RUBY_CHILD_MISMATCH');
  process.kill(-pid,'SIGSTOP');
 });
}finally{await db.close();}
