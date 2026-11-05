#!/usr/bin/node
import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
const home=process.env.HOME, config=JSON.parse(readFileSync(home+'/fixture.json','utf8'));
appendFileSync(home+'/trace',JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),env:Object.keys(process.env).sort(),home,codeHome:process.env.CODEX_HOME})+'\n');
const rl=createInterface({input:process.stdin});
rl.on('line',line=>{
 const msg=JSON.parse(line);appendFileSync(home+'/trace',JSON.stringify(msg)+'\n');
 if(msg.method==='initialized')return;
 if(config.mode==='hang')return;
 if(config.mode==='overflow'){process.stdout.write('x'.repeat(300000));return;}
 const send=result=>process.stdout.write(JSON.stringify({id:msg.id,result})+'\n');
 if(msg.method==='initialize')send({});
 else if(msg.method==='account/read')send({account:config.mode==='auth'?{type:'apiKey'}:{type:'chatgpt',email:'Fixture@Example.invalid',accountId:'subject'}});
 else if(msg.method==='account/rateLimits/read')send(config.mode==='malformed'?{rateLimits:{}}:{rateLimits:{primary:{usedPercent:20,resetsAt:1793714400,windowDurationMins:300},secondary:{usedPercent:35,resetsAt:1793714400,windowDurationMins:10080}}});
 else process.exit(3);
});
