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
