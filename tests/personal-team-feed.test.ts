import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {dockerLogText,teamMessage} from '../src/personal-team-feed.ts';
import {personalControlWord} from '../src/personal-conversation.ts';

const frame=(text:string)=>{const body=Buffer.from(text);const head=Buffer.alloc(8);head[0]=1;head.writeUInt32BE(body.length,4);return Buffer.concat([head,body]);};

test('docker multiplexed QA logs become plain text',()=>{
 assert.equal(dockerLogText(Buffer.concat([frame('a\n'),frame('b\n')])),'a\nb\n');
 assert.equal(dockerLogText(Buffer.from('plain')),'plain');
});

test('each role reports who ran it and what it produced',async()=>{
 const root=await mkdtemp(join(tmpdir(),'team-')),repo=root;
 const reviewer=randomUUID(),programmer=randomUUID(),qa=randomUUID();
 await mkdir(join(root,reviewer,'output'),{recursive:true});await mkdir(join(root,programmer,'output'),{recursive:true});await mkdir(join(root,qa),{recursive:true});
 await writeFile(join(root,reviewer,'output','execution-result.json'),JSON.stringify({output:JSON.stringify({verdict:'reject',findings:[{severity:'high',summary:'falta teste'}]})}));
 await writeFile(join(root,programmer,'output','execution-result.json'),JSON.stringify({output:'Adicionei a seção.'}));
 await writeFile(join(root,qa,'qa-logs.bin'),frame('QA files checked: 3, failures: 0\n'));
 const base={provider:'claude',model:'claude-sonnet-5-5',effort:'medium',base:null};
 const review=await teamMessage({...base,id:reviewer,kind:'reviewer',state:'completed',receipt:{}},{executionHost:root,repo});
 assert.match(review!.text,/^Revisor \(claude · claude-sonnet-5-5 · medium\) rejeitou:\n• \[high\] falta teste/);
 const prog=await teamMessage({...base,provider:'grok',model:'grok-4.7',id:programmer,kind:'programmer',state:'completed',receipt:{payload:{artifact:null}}},{executionHost:root,repo});
 assert.match(prog!.text,/Programador \(grok · grok-4.7 · medium\) terminou\.\n«Adicionei a seção\.»/);
 const check=await teamMessage({id:qa,kind:'qa',state:'completed',provider:null,model:null,effort:null,base:null,receipt:{status:'passed'}},{executionHost:root,repo});
 assert.equal(check!.text,'QA passou: QA files checked: 3, failures: 0.');
 const running=await teamMessage({...base,id:programmer,kind:'programmer',state:'running',receipt:null},{executionHost:root,repo});
 assert.equal(running!.id,'team-'+programmer+'-running');
 assert.equal(await teamMessage({...base,id:'../x',kind:'reviewer',state:'completed',receipt:{}},{executionHost:root,repo}).then(m=>m!.text),'Revisor (claude · claude-sonnet-5-5 · medium) não concluiu a revisão.');
});

test('equipe and status ask for the team panel',()=>{
 assert.equal(personalControlWord(' Equipe '),'team');assert.equal(personalControlWord('status'),'team');assert.equal(personalControlWord('aprovar'),'approve');
});
