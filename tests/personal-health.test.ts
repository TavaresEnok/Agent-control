import assert from 'node:assert/strict';
import {test} from 'node:test';
import {diskNotice,dueNotices,loginNotices,loginProblem,repeatedErrorNotices} from '../src/personal-health.ts';

const now=new Date('2026-11-16T12:00:00Z');
const day=24*3600_000;

test('only the same error line repeated ten times is a notice',()=>{
 const lines=(text:string,n:number)=>Array(n).fill(text);
 const log=[
  ...lines('RECONCILIATION_FAILED NATIVE_JOB_RECONCILIATION_FAILED: 11111111-2222-3333-4444-555555555555 NATIVE_EXECUTION_SUPERVISOR_UNAVAILABLE',6),
  ...lines('RECONCILIATION_FAILED NATIVE_JOB_RECONCILIATION_FAILED: 99999999-2222-3333-4444-555555555555 NATIVE_EXECUTION_SUPERVISOR_UNAVAILABLE',4),
  ...lines('{"event":"PERSONAL_NOTICE_SUPPRESSED","text":"Tarefa na fila."}',50),
  ...lines('Started agent-control-gateway-ispagent.service - Agent Control: gateway (ispagent).',20),
  ...lines('MANAGER_RECONNECTED 11111111-2222-3333-4444-555555555555',20),
  ...lines('TypeError: boom',9),
 ].join('\n');
 const notices=repeatedErrorNotices(log);
 assert.equal(notices.length,1);
 assert.match(notices[0]!.text,/\(10 vezes em 5 min\)/);
 assert.equal(notices[0]!.key,'error:RECONCILIATION_FAILED NATIVE_JOB_RECONCILIATION_FAILED: * NATIVE_EXECUTION_SUPERVISOR_UNAVAILABLE');
 assert.equal(repeatedErrorNotices(log+'\nTypeError: boom').length,2);
});

test('an error notice never carries a URL, a path or a long token',()=>{
 const line='GIT_PUSH_FAILED https://user:pass@example.com/repo.git /home/app/.agent-control/ispagent/ssh/id key=abcdefghijklmnopqrstuvwxyz0123456789';
 const [notice]=repeatedErrorNotices(Array(10).fill(line).join('\n'));
 assert.ok(notice);
 assert.equal(notice!.text.includes('pass@'),false);
 assert.equal(notice!.text.includes('/home/app'),false);
 assert.equal(notice!.text.includes('abcdefghijklmnopqrstuvwxyz'),false);
 assert.match(notice!.text,/GIT_PUSH_FAILED <url> <caminho>/);
});

test('disk notice starts at 90 percent',()=>{
 assert.equal(diskNotice(89.9),null);
 assert.match(diskNotice(90)!.text,/^Disco do servidor em 90%/);
});

test('login problems come from the login file only',async()=>{
 const claude=(days:number)=>({claudeAiOauth:{accessToken:'a',refreshToken:'r',expiresAt:now.getTime()-1000,refreshTokenExpiresAt:now.getTime()+days*day}});
 assert.equal(loginProblem('claude',claude(10),now),null);
 assert.deepEqual(loginProblem('claude',claude(2.5),now),{days:2});
 assert.deepEqual(loginProblem('claude',claude(-1),now),{days:0});
 assert.deepEqual(loginProblem('claude',{claudeAiOauth:{accessToken:'a'}},now),{days:null});
 assert.equal(loginProblem('grok',{'https://auth.x.ai::x':{key:'k',refresh_token:'r',expires_at:'2020-01-01T00:00:00Z'}},now),null);
 assert.deepEqual(loginProblem('grok',{},now),{days:null});
 assert.equal(loginProblem('codex',{tokens:{refresh_token:'r'},last_refresh:'2020-01-01T00:00:00Z'},now),null);
 assert.deepEqual(loginProblem('codex',null,now),{days:null});
 const files:Record<string,string>={
  '/a/11111111-1111-1111-1111-111111111111/.credentials.json':JSON.stringify(claude(1)),
  '/a/22222222-2222-2222-2222-222222222222/.grok/auth.json':JSON.stringify({'https://auth.x.ai::x':{refresh_token:'r'}}),
 };
 const notices=await loginNotices('/a',[
  {id:'11111111-1111-1111-1111-111111111111',provider:'claude'},
  {id:'22222222-2222-2222-2222-222222222222',provider:'grok'},
  {id:'33333333-3333-3333-3333-333333333333',provider:'codex'},
 ],now,'/i.json',async path=>{if(path in files)return files[path]!;throw new Error('ENOENT');});
 assert.deepEqual(notices.map(n=>n.text),[
  'O login do Claude vence em 1 dia. Entre de novo: npm run gateway -- account-add /i.json claude Claude.',
  'O Codex está sem login válido. Entre de novo: npm run gateway -- account-add /i.json codex Codex.',
 ]);
});

test('a notice waits its own interval and old keys are forgotten',()=>{
 const notice={key:'disk',text:'x',repeatMs:6*3600_000};
 const first=dueNotices([notice],{old:new Date(now.getTime()-8*day).toISOString()},now);
 assert.equal(first.due.length,1);assert.deepEqual(Object.keys(first.sent),[]);
 first.sent.disk=now.toISOString();
 assert.equal(dueNotices([notice],first.sent,new Date(now.getTime()+3600_000)).due.length,0);
 assert.equal(dueNotices([notice],first.sent,new Date(now.getTime()+7*3600_000)).due.length,1);
});
