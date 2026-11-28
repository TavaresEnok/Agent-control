import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {NativeQa} from '../src/native-qa.ts';
import {defaultPersonalQaContract} from '../src/personal-qa-config.ts';
import {sandboxContainerLabels} from '../src/sandbox-broker.ts';
import {nativeProtocolHostSupervisor} from '../src/native-protocol-host-supervisor.ts';

const image='sha256:'+'a'.repeat(64);
const owner={'com.agent-control.installation':'ispagent','com.agent-control.project':'chatisp'};

/** The specs are built without I/O: a QA instance with no ledger behind it is enough to read them. */
function qa(withOwner:boolean){
 const ledger={} as never;
 return new NativeQa(ledger,{ledger} as never,'/x/repo','/x/root',defaultPersonalQaContract(image),new Uint8Array(32),
  undefined,undefined,undefined,undefined,false,withOwner?{installation:'ispagent',project:'chatisp'}:undefined) as unknown as
  {preparedTestSpec(jobId:string,hash:string):{Labels:Record<string,string>}};
}

test('the QA container carries the ownership labels beside its identity labels, and only those it is given',()=>{
 const job=randomUUID();
 const labelled=qa(true).preparedTestSpec(job,'h').Labels;
 assert.deepEqual(labelled,{...owner,'com.agent-control.kind':'native-qa','agent-control.contract':'native-qa-v1','agent-control.job':job,'agent-control.request':'h'});
 // Without an installation the identity labels are exactly the old ones: nothing is invented.
 assert.deepEqual(qa(false).preparedTestSpec(job,'h').Labels,{'agent-control.contract':'native-qa-v1','agent-control.job':job,'agent-control.request':'h'});
});

test('the sandbox container carries the ownership labels only when the broker names its installation',()=>{
 const value={jobId:randomUUID(),grantId:randomUUID(),authority:{epoch:3}};
 const identity={'ac.scope':'isolated-synthetic','ac.job':value.jobId,'ac.grant':value.grantId,'ac.epoch':'3','ac.spec':'s'};
 assert.deepEqual(sandboxContainerLabels('managed-lab-x',value,'s'),{'com.agent-control.installation':'managed-lab-x','com.agent-control.kind':'sandbox',...identity});
 assert.deepEqual(sandboxContainerLabels(undefined,value,'s'),identity);
});

test('the protocol probe container is marked as the AC\'s by kind',()=>{
 assert.ok(nativeProtocolHostSupervisor.includes("'--label','com.agent-control.kind=native-protocol-check'"));
});
