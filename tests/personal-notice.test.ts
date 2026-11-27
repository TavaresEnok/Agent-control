import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PERSONAL_NOTICE_WINDOW_MS,suppressRepeatedPersonalNotice} from '../src/personal-notice.ts';

const queue='Tarefa na fila.';
const block='Atenção — 1 bloqueio(s):\n- Plano 1: na fila de capacidade.';

test('the same notice inside ten minutes is suppressed and after ten minutes it is not',()=>{
 const recent=[{text:queue,ageMs:PERSONAL_NOTICE_WINDOW_MS-1}];
 assert.equal(suppressRepeatedPersonalNotice({text:queue,localId:'progress-1-na fila',recent}),true);
 assert.equal(suppressRepeatedPersonalNotice({text:queue,localId:'progress-1-na fila',recent:[{text:queue,ageMs:PERSONAL_NOTICE_WINDOW_MS}]}),false);
 assert.equal(suppressRepeatedPersonalNotice({text:block,localId:'notice-1',recent:[{text:block,ageMs:0}]}),true);
 assert.equal(suppressRepeatedPersonalNotice({text:block,localId:'notice-1',recent:[{text:block,ageMs:PERSONAL_NOTICE_WINDOW_MS}]}),false);
 assert.equal(suppressRepeatedPersonalNotice({text:'Tarefa programando.',localId:'progress-1-programando',recent:[{text:'Tarefa programando.',ageMs:0}]}),false);
});

test('a manager reply, a proposal and a team report are never suppressed',()=>{
 const recent=[{text:queue,ageMs:0},{text:block,ageMs:0}];
 assert.equal(suppressRepeatedPersonalNotice({text:queue,kind:'manager-reply',recent}),false);
 assert.equal(suppressRepeatedPersonalNotice({text:block,localId:'answer-1',recent}),false);
 assert.equal(suppressRepeatedPersonalNotice({text:'Proposta de plano 3. Responda aprovar.',localId:'proposal-1',recent:[{text:'Proposta de plano 3. Responda aprovar.',ageMs:0}]}),false);
 assert.equal(suppressRepeatedPersonalNotice({text:'Programador (grok · grok-4 · medium) terminou.',localId:'team-1-completed',recent:[{text:'Programador (grok · grok-4 · medium) terminou.',ageMs:0}]}),false);
 assert.equal(suppressRepeatedPersonalNotice({text:'Equipe:\n• Gerente: grok',kind:'team-report',recent:[{text:'Equipe:\n• Gerente: grok',ageMs:0}]}),false);
});

test('operational log events omit private error and repeated notice text',async t=>{
 const {logLedgerSessionError}=await import('../src/ledger-session-errors.ts');
 const {ConversationEndpoint}=await import('../src/conversation.ts');
 const privateText='PRIVATE-SYNTHETIC-MARKER';
 const notice='Atenção — '+privateText;
 const log=t.mock.method(console,'error',()=>{});
 logLedgerSessionError(new Error(privateText));
 logLedgerSessionError(Object.assign(new Error(privateText),{code:privateText}));
 logLedgerSessionError(Object.assign(new Error(privateText),{code:'25P03'}));
 const endpoint=Object.assign(Object.create(ConversationEndpoint.prototype),{
  options:{personalConversation:true,authority:{contextId:'synthetic'}},
  ledger:{pool:{query:async()=>({rows:[{text:notice,age_ms:0}]})}},
 }) as {say(id:string,text:string):Promise<void>};
 await endpoint.say('notice-1',notice);
 assert.deepEqual(log.mock.calls.map(call=>call.arguments),[
  ['LEDGER_SESSION_ERROR','UNKNOWN'],
  ['LEDGER_SESSION_ERROR','UNKNOWN'],
  ['LEDGER_SESSION_ERROR','25P03'],
  ['{"event":"PERSONAL_NOTICE_SUPPRESSED"}'],
 ]);
});
