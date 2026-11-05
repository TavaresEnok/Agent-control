import {test} from 'node:test';
import assert from 'node:assert/strict';
import {managedRetirementTerminalAllowed} from '../src/sandbox-broker.ts';

test('managed retirement requires a consistent physical terminal and durable discard decision',()=>{
 const artifact={commit:'artifact'};
 const base={state:'completed',operation_state:'running',intent_state:'accepted',parent_state:'accepted',receipt:{exitCode:0,implementation:artifact},operation_receipt:null};
 assert.equal(managedRetirementTerminalAllowed(base),false);
 assert.equal(managedRetirementTerminalAllowed({...base,parent_state:'canceled'}),true);
 assert.equal(managedRetirementTerminalAllowed({...base,intent_state:'failed'}),true);
 assert.equal(managedRetirementTerminalAllowed({...base,operation_state:'completed',operation_receipt:artifact}),true);
 assert.equal(managedRetirementTerminalAllowed({...base,operation_state:'completed',operation_receipt:{commit:'other'}}),false);
 assert.equal(managedRetirementTerminalAllowed({...base,state:'failed',receipt:{exitCode:137}}),true);
 assert.equal(managedRetirementTerminalAllowed({...base,state:'failed',receipt:{exitCode:0}}),false);
 assert.equal(managedRetirementTerminalAllowed({...base,state:'failed',operation_state:'completed',receipt:{exitCode:137}}),false);
 assert.equal(managedRetirementTerminalAllowed({...base,state:'running',parent_state:'canceled'}),false);
});
