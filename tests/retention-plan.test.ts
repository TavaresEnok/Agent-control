import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {explainDiskAdmission,requiredFreeBytes} from '../src/disk-admission.ts';
import {planRetention,type RetentionPlan} from '../src/retention-plan.ts';

const ages={cache:1_000,log:1_000,worktree:1_000,backup:1_000};
const disk=(availableBytes:number,extra:Partial<{minFreeBytes:number;estimatedWriteBytes:number;additionalReservedBytes:number}>={})=>({
 availableBytes,minFreeBytes:extra.minFreeBytes??0,estimatedWriteBytes:extra.estimatedWriteBytes??1,additionalReservedBytes:extra.additionalReservedBytes??0,
});
const rules=(availableBytes:number,extra?:Parameters<typeof disk>[1])=>({schemaVersion:1 as const,minAgeMs:ages,disk:disk(availableBytes,extra)});
const ref=(status:'active'|'uncertain'|'released')=>({jobId:'job-1',status});
type Item=Parameters<typeof planRetention>[0] extends infer _ ? {
 id:string;kind:'acceptance_evidence'|'evidence'|'log'|'backup'|'worktree'|'cache';ageMs:number;sizeBytes:number;
 state:'active'|'idle'|'uncertain';references:{jobId:string;status:'active'|'uncertain'|'released'}[];
 regenerable?:boolean;restoreProven?:boolean;backupGroup?:string;acceptance?:boolean;
} : never;
const artifact=(item:Item)=>item;
const inventory=(artifacts:Item[])=>({schemaVersion:1 as const,artifacts});
const code=(plan:RetentionPlan,id:string)=>plan.decisions.find(decision=>decision.id===id);

test('protected inventory is kept and each item has a reason',()=>{
 const plan=planRetention(inventory([
  artifact({id:'accept',kind:'acceptance_evidence',ageMs:9_999_999,sizeBytes:50,state:'idle',references:[],acceptance:true}),
  artifact({id:'evidence',kind:'evidence',ageMs:9_999_999,sizeBytes:50,state:'idle',references:[]}),
  artifact({id:'flagged',kind:'log',ageMs:9_999_999,sizeBytes:50,state:'idle',references:[],acceptance:true}),
  artifact({id:'active-ref',kind:'cache',ageMs:9_999_999,sizeBytes:50,state:'idle',references:[ref('active')],regenerable:true}),
  artifact({id:'uncertain-ref',kind:'log',ageMs:9_999_999,sizeBytes:50,state:'idle',references:[ref('uncertain')]}),
  artifact({id:'uncertain-state',kind:'worktree',ageMs:9_999_999,sizeBytes:50,state:'uncertain',references:[]}),
  artifact({id:'active-state',kind:'cache',ageMs:9_999_999,sizeBytes:50,state:'active',references:[],regenerable:true}),
  artifact({id:'unproven',kind:'backup',ageMs:9_999_999,sizeBytes:50,state:'idle',references:[],backupGroup:'db',restoreProven:false}),
  artifact({id:'only-backup',kind:'backup',ageMs:9_999_999,sizeBytes:50,state:'idle',references:[],backupGroup:'solo',restoreProven:true}),
  artifact({id:'frozen-cache',kind:'cache',ageMs:9_999_999,sizeBytes:50,state:'idle',references:[],regenerable:false}),
 ]),rules(10));
 for(const decision of plan.decisions){
  assert.equal(decision.action,'keep');
  assert.equal(decision.reason.length>0,true);
 }
 assert.equal(code(plan,'accept')?.code,'ACCEPTANCE_EVIDENCE');
 assert.equal(code(plan,'evidence')?.code,'EVIDENCE_PRESERVED');
 assert.equal(code(plan,'flagged')?.code,'ACCEPTANCE_EVIDENCE');
 assert.equal(code(plan,'active-ref')?.code,'REFERENCED_BY_ACTIVE_JOB');
 assert.equal(code(plan,'uncertain-ref')?.code,'REFERENCED_BY_UNCERTAIN_JOB');
 assert.equal(code(plan,'uncertain-state')?.code,'STATE_UNCERTAIN');
 assert.equal(code(plan,'active-state')?.code,'STATE_ACTIVE');
 assert.equal(code(plan,'unproven')?.code,'BACKUP_RESTORE_UNPROVEN');
 assert.equal(code(plan,'only-backup')?.code,'UNIQUE_VALID_BACKUP');
 assert.equal(code(plan,'frozen-cache')?.code,'NOT_REGENERABLE');
 assert.deepEqual(plan.proposalOrder,[]);
 assert.equal(plan.proposedBytes,0);
 assert.equal(plan.mode,'dry-run');
 assert.equal(plan.deletesNothing,true);
});

test('only a redundant proven backup is proposed and a released reference does not protect a log',()=>{
 const plan=planRetention(inventory([
  artifact({id:'newer',kind:'backup',ageMs:5_000,sizeBytes:10,state:'idle',references:[],backupGroup:'db',restoreProven:true}),
  artifact({id:'older',kind:'backup',ageMs:9_000,sizeBytes:10,state:'idle',references:[],backupGroup:'db',restoreProven:true}),
  artifact({id:'same-a',kind:'backup',ageMs:8_000,sizeBytes:10,state:'idle',references:[],backupGroup:'tie',restoreProven:true}),
  artifact({id:'same-b',kind:'backup',ageMs:8_000,sizeBytes:10,state:'idle',references:[],backupGroup:'tie',restoreProven:true}),
  artifact({id:'released-log',kind:'log',ageMs:4_000,sizeBytes:7,state:'idle',references:[ref('released')]}),
  artifact({id:'young-log',kind:'log',ageMs:4,sizeBytes:7,state:'idle',references:[]}),
 ]),rules(100));
 assert.equal(plan.admission.admitted,true);
 assert.equal(code(plan,'newer')?.code,'RETAIN_NEWEST_VALID_BACKUP');
 assert.equal(code(plan,'older')?.code,'PROPOSE_REDUNDANT_PROVEN_BACKUP');
 assert.equal(code(plan,'same-a')?.code,'RETAIN_NEWEST_VALID_BACKUP');
 assert.equal(code(plan,'same-b')?.code,'PROPOSE_REDUNDANT_PROVEN_BACKUP');
 assert.equal(code(plan,'released-log')?.action,'propose');
 assert.equal(code(plan,'young-log')?.code,'BELOW_MIN_AGE');
 assert.deepEqual(plan.proposalOrder,['released-log','older','same-b']);
});

test('a full disk refuses admission, lists regenerable caches first and deletes nothing',()=>{
 const artifacts=[
  artifact({id:'cache-young',kind:'cache',ageMs:1,sizeBytes:5_000,state:'idle',references:[],regenerable:true}),
  artifact({id:'cache-old',kind:'cache',ageMs:50_000,sizeBytes:1_000,state:'idle',references:[],regenerable:true}),
  artifact({id:'log-old',kind:'log',ageMs:50_000,sizeBytes:100,state:'idle',references:[]}),
  artifact({id:'wt-old',kind:'worktree',ageMs:50_000,sizeBytes:80,state:'idle',references:[]}),
  artifact({id:'wt-young',kind:'worktree',ageMs:2,sizeBytes:9_000,state:'idle',references:[]}),
  artifact({id:'older',kind:'backup',ageMs:50_000,sizeBytes:40,state:'idle',references:[],backupGroup:'db',restoreProven:true}),
  artifact({id:'newer',kind:'backup',ageMs:5_000,sizeBytes:40,state:'idle',references:[],backupGroup:'db',restoreProven:true}),
  artifact({id:'accept',kind:'acceptance_evidence',ageMs:50_000,sizeBytes:9_000,state:'idle',references:[]}),
  artifact({id:'only-backup',kind:'backup',ageMs:50_000,sizeBytes:9_000,state:'idle',references:[],backupGroup:'solo',restoreProven:true}),
  artifact({id:'unproven',kind:'backup',ageMs:50_000,sizeBytes:9_000,state:'idle',references:[],backupGroup:'solo',restoreProven:false}),
  artifact({id:'active-ref',kind:'cache',ageMs:50_000,sizeBytes:9_000,state:'idle',references:[ref('active')],regenerable:true}),
  artifact({id:'uncertain-ref',kind:'cache',ageMs:50_000,sizeBytes:9_000,state:'idle',references:[ref('uncertain')],regenerable:true}),
 ];
 const policy=rules(999,{minFreeBytes:400,estimatedWriteBytes:600,additionalReservedBytes:0});
 const plan=planRetention(inventory(artifacts),policy);
 const required=requiredFreeBytes(400,600,0n);
 const verdict=explainDiskAdmission(999n,required);
 assert.equal(plan.admission.admitted,false);
 assert.equal(plan.admission.code,'STORAGE_LOW_SPACE');
 assert.equal(plan.admission.reason,verdict.reason);
 assert.match(plan.admission.reason,/New work is refused/);
 assert.match(plan.admission.reason,/does not delete/);
 assert.deepEqual(plan.proposalOrder,['cache-young','cache-old','log-old','wt-old','older']);
 assert.equal(code(plan,'cache-young')?.code,'DISK_FULL_REGENERABLE_CACHE');
 assert.equal(code(plan,'wt-young')?.code,'BELOW_MIN_AGE');
 assert.equal(code(plan,'accept')?.action,'keep');
 assert.equal(code(plan,'only-backup')?.code,'UNIQUE_VALID_BACKUP');
 assert.equal(code(plan,'unproven')?.code,'BACKUP_RESTORE_UNPROVEN');
 assert.equal(code(plan,'active-ref')?.code,'REFERENCED_BY_ACTIVE_JOB');
 assert.equal(code(plan,'uncertain-ref')?.code,'REFERENCED_BY_UNCERTAIN_JOB');
 assert.equal(plan.deletesNothing,true);
 assert.equal(plan.proposedBytes,5_000+1_000+100+80+40);
 const boundary=planRetention(inventory([artifact({id:'cache-young',kind:'cache',ageMs:1,sizeBytes:5,state:'idle',references:[],regenerable:true})]),rules(1_000,{minFreeBytes:400,estimatedWriteBytes:600}));
 assert.equal(boundary.admission.admitted,true);
 assert.equal(boundary.proposalOrder.length,0);
 assert.equal(code(boundary,'cache-young')?.code,'BELOW_MIN_AGE');
});

test('the plan is deterministic for every permutation and does not mutate the inventory',()=>{
 const artifacts=[
  artifact({id:'b',kind:'log',ageMs:5_000,sizeBytes:3,state:'idle',references:[]}),
  artifact({id:'a',kind:'cache',ageMs:5_000,sizeBytes:9,state:'idle',references:[],regenerable:true}),
  artifact({id:'d',kind:'acceptance_evidence',ageMs:5_000,sizeBytes:8,state:'idle',references:[]}),
  artifact({id:'c',kind:'worktree',ageMs:5_000,sizeBytes:4,state:'uncertain',references:[]}),
 ];
 const policy=rules(0,{minFreeBytes:1,estimatedWriteBytes:1});
 const permutations=(items:typeof artifacts):typeof artifacts[]=>{
  if(items.length<=1)return [items.slice()];
  const out:typeof artifacts[]=[];
  for(let index=0;index<items.length;index++){
   const rest=items.slice(0,index).concat(items.slice(index+1));
   for(const tail of permutations(rest))out.push([items[index]!,...tail]);
  }
  return out;
 };
 const baseline=planRetention(inventory(artifacts),policy);
 for(const order of permutations(artifacts)){
  assert.deepEqual(planRetention(inventory(order),policy),baseline);
 }
 let seed=0xC0FFEE;
 const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/0x100000000;};
 const full=[
  ...artifacts,
  artifact({id:'older',kind:'backup',ageMs:8_000,sizeBytes:2,state:'idle',references:[],backupGroup:'db',restoreProven:true}),
  artifact({id:'newer',kind:'backup',ageMs:2_000,sizeBytes:2,state:'idle',references:[],backupGroup:'db',restoreProven:true}),
  artifact({id:'only-backup',kind:'backup',ageMs:8_000,sizeBytes:2,state:'idle',references:[],backupGroup:'solo',restoreProven:true}),
 ];
 const fullBaseline=planRetention(inventory(full),policy);
 const before=full.map(item=>item.id);
 for(let round=0;round<10;round++){
  const shuffled=full.slice();
  for(let index=shuffled.length-1;index>0;index--){
   const swap=Math.floor(random()*(index+1));
   const current=shuffled[index]!;shuffled[index]=shuffled[swap]!;shuffled[swap]=current;
  }
  assert.deepEqual(planRetention(inventory(shuffled),policy),fullBaseline);
 }
 assert.deepEqual(full.map(item=>item.id),before);
 assert.equal(planRetention(inventory(full),policy) instanceof Promise,false);
});

test('invalid inventory is refused before a plan exists',()=>{
 const cache={id:'cache',kind:'cache' as const,ageMs:10,sizeBytes:1,state:'idle' as const,references:[],regenerable:true};
 assert.throws(()=>planRetention(inventory([cache,cache]),rules(10)),/RETENTION_DUPLICATE_ID/);
 assert.throws(()=>planRetention(inventory([{...cache,id:'bad',kind:'acceptance_evidence',acceptance:false,regenerable:undefined}]),rules(10)),/RETENTION_INVENTORY_INVALID/);
 assert.throws(()=>planRetention(inventory([{...cache,backupGroup:'db'}]),rules(10)),/RETENTION_INVENTORY_INVALID/);
 assert.throws(()=>planRetention({schemaVersion:1,artifacts:[cache]},{schemaVersion:1,minAgeMs:ages,disk:disk(1,{estimatedWriteBytes:0})}),/RETENTION_POLICY_INVALID/);
});

test('the retention module has no filesystem or database effect',async()=>{
 const source=await readFile(new URL('../src/retention-plan.ts',import.meta.url),'utf8');
 assert.doesNotMatch(source,/from ['"]node:fs|from ['"]node:child_process|from ['"]pg['"]|unlink\(|rmSync\(|child_process/);
 const plan=planRetention(inventory([artifact({id:'cache-old',kind:'cache',ageMs:5_000,sizeBytes:4,state:'idle',references:[],regenerable:true})]),rules(0,{minFreeBytes:1,estimatedWriteBytes:1}));
 assert.equal(plan.proposalOrder[0],'cache-old');
 assert.equal(plan.decisions[0]?.action,'propose');
 assert.equal(typeof plan.digest,'string');
 assert.equal(plan.digest.length,64);
});
