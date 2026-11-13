import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cliEffort} from '../src/effort.ts';
import {managerChatCommand} from '../src/personal-manager-chat.ts';
import {grokProgrammerArgs} from '../src/grok-execution-adapter.ts';

test('xhigh stays on Claude and becomes high on Grok and Codex',()=>{
 assert.equal(cliEffort('claude','xhigh'),'xhigh');
 assert.equal(cliEffort('claude','max'),'max');
 assert.equal(cliEffort('grok','xhigh'),'high');
 assert.equal(cliEffort('grok','max'),'high');
 assert.equal(cliEffort('codex','max'),'high');
 assert.equal(cliEffort('codex','high'),'high');
 assert.equal(cliEffort('grok','low'),'low');
});

test('Claude argv keeps --effort xhigh and Grok argv caps at high',()=>{
 const claude=managerChatCommand('claude','claude-opus-5-5','xhigh','ping');
 assert.deepEqual(claude.args.slice(claude.args.indexOf('--effort'),claude.args.indexOf('--effort')+2),['--effort','xhigh']);
 const grok=managerChatCommand('grok','grok-4.7','xhigh','ping');
 assert.deepEqual(grok.args.slice(grok.args.indexOf('--reasoning-effort'),grok.args.indexOf('--reasoning-effort')+2),['--reasoning-effort','high']);
 const codex=managerChatCommand('codex','gpt-6.1-sol','max','ping');
 assert.ok(codex.args.includes('model_reasoning_effort=high'));
 assert.deepEqual(grokProgrammerArgs('grok-4.7','max','task').slice(4,6),['--reasoning-effort','high']);
});
