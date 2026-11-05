import {readFile,lstat,realpath} from 'node:fs/promises';
import {Ledger} from '../../src/ledger.ts';
import {NativeExecutionSupervisor} from '../../src/native-execution-supervisor.ts';
import {digest} from '../../src/contracts.ts';

const file=process.argv[2];
if(!file||!/^\/tmp\/ac-finalizer-live-[^/]+\/reconciler\.json$/.test(file))throw Error('ISOLATED_FINALIZER_FIXTURE_REQUIRED');
const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.nlink!==1||await realpath(file)!==file)throw Error('INVALID_PRIVATE_FIXTURE');
const f=JSON.parse(await readFile(file,'utf8')),url=new URL(f.url);
if(!['db','127.0.0.1','localhost'].includes(url.hostname)||!/^\/ac_implementation_test_livefinalizer_[a-f0-9]{20}$/.test(url.pathname))throw Error('ISOLATED_DATABASE_REQUIRED');
const db=new Ledger(f.url);
try{
 const supervisor=new NativeExecutionSupervisor(db,f.supervisorConfig);
 const labels={'agent-control.contract':'native-execution-v1','agent-control.job':f.input.jobId,'agent-control.launch':digest(f.input)};
 const physical=(id:string)=>({Id:id,Image:f.supervisorConfig.workerImage,Config:{Labels:labels},State:{Status:'exited',Running:false,ExitCode:0,FinishedAt:f.finished}});
 Object.defineProperty(supervisor,'docker',{value:{inspect:async(name:string)=>name===f.worker||name.startsWith('ac-native-worker-')?physical(f.worker):physical(f.tools),stop:async()=>{}}});
 let settled=false;for(let i=0;i<100;i++){
  if((await supervisor.reconcileCancellation(f.principal,f.authority,f.input.jobId)).state==='reconciled'){settled=true;break;}
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 if(!settled)throw Error('FINALIZER_RECONCILIATION_UNCONFIRMED');
}finally{await db.close();}
