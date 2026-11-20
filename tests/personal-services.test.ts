import {describe,test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmod,copyFile,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-expect-error plain ES module without declarations
import {systemdArgument,systemdEnvironment,systemdExecStart,systemdPathValue} from '../scripts/systemd-exec.mjs';

/** The systemd rules for one quoted word: backslash escapes, `%%` is `%`, `$$` is `$`. */
function parseExecStart(line:string){
 const words:string[]=[];let index=0;
 while(index<line.length){
  if(line[index]===' '){index++;continue;}
  assert.equal(line[index],'"',`expected a quoted word at ${index} in ${line}`);
  index++;let word='';
  for(;;){
   assert.ok(index<line.length,'unterminated quote');
   const char=line[index++];
   if(char==='"')break;
   if(char==='\\'){word+=line[index++];continue;}
   if(char==='%'||char==='$'){assert.equal(line[index],char,`unescaped ${char} in ${line}`);index++;word+=char;continue;}
   word+=char;
  }
  words.push(word);
 }
 return words;
}

describe('systemd escaping',{concurrency:false},()=>{
test('arguments with spaces, quotes, backslashes, % and $ survive the systemd parser as one word each',()=>{
 const argv=['/opt/my node/bin/node','--import','tsx','/srv/Agent Control/src/server-main.ts','serve','/data/a "b"/c\\d/100%/$HOME/installation.json'];
 assert.deepEqual(parseExecStart(systemdExecStart(argv)),argv);
 assert.equal(systemdArgument('a b'),'"a b"');
 assert.equal(systemdArgument('50%'),'"50%%"');
 assert.equal(systemdArgument('$X'),'"$$X"');
});
test('line breaks and NUL are refused; an empty command is refused',()=>{
 assert.throws(()=>systemdArgument('a\nb'),/SYSTEMD_VALUE_HAS_LINE_BREAK/);
 assert.throws(()=>systemdArgument('a\rb'),/SYSTEMD_VALUE_HAS_LINE_BREAK/);
 assert.throws(()=>systemdPathValue('/a\nExecStart=/bin/sh'),/SYSTEMD_VALUE_HAS_LINE_BREAK/);
 assert.throws(()=>systemdEnvironment('PATH','/a\nExecStart=/bin/sh'),/SYSTEMD_VALUE_HAS_LINE_BREAK/);
 assert.throws(()=>systemdExecStart([]),/SYSTEMD_EXEC_EMPTY/);
 assert.throws(()=>systemdEnvironment('BAD NAME','x'),/SYSTEMD_ENV_NAME_INVALID/);
 assert.throws(()=>systemdPathValue('relative/dir'),/SYSTEMD_PATH_NOT_ABSOLUTE/);
});
test('Environment and WorkingDirectory keep a path with spaces and a percent sign intact',()=>{
 assert.equal(systemdEnvironment('PATH','/opt/my node/bin:/usr/bin'),'"PATH=/opt/my node/bin:/usr/bin"');
 assert.equal(systemdPathValue('/srv/Agent Control 100%'),'/srv/Agent Control 100%%');
});

test('the real personal-services script writes units whose ExecStart keeps a repository path with spaces in one word',async()=>{
 const base=await realpath(await mkdtemp(join(tmpdir(),'ac-services-')));
 try{
  const root=join(base,'Agent Control');
  await mkdir(join(root,'scripts'),{recursive:true});
  for(const name of ['personal-services.mjs','systemd-exec.mjs'])await copyFile(join(import.meta.dirname,'..','scripts',name),join(root,'scripts',name));
  const home=join(base,'home'),bin=join(base,'bin'),data=join(base,'My Data');
  await mkdir(home,{recursive:true});await mkdir(bin);await mkdir(data);
  await writeFile(join(bin,'systemctl'),'#!/bin/sh\nexit 0\n');await chmod(join(bin,'systemctl'),0o755);
  const installation=join(base,'My Installation','installation.json');
  await mkdir(join(base,'My Installation'));
  await writeFile(installation,JSON.stringify({activation:'personal',dataDirectory:data,managerTransport:{transport:'happier'}}));
  execFileSync(process.execPath,[join(root,'scripts/personal-services.mjs'),installation,'espaco'],{env:{...process.env,HOME:home,PATH:`${bin}:${process.env.PATH}`},stdio:'pipe'});
  const units=join(home,'.config/systemd/user');
  const gateway=await readFile(join(units,'agent-control-gateway-espaco.service'),'utf8');
  const happier=await readFile(join(units,'agent-control-happier-espaco.service'),'utf8');
  const line=(text:string,key:string)=>text.split('\n').find(l=>l.startsWith(key+'='))!.slice(key.length+1);
  assert.deepEqual(parseExecStart(line(gateway,'ExecStart')),[process.execPath,'--import','tsx',join(root,'src/server-main.ts'),'serve',installation]);
  assert.deepEqual(parseExecStart(line(happier,'ExecStart')),[process.execPath,join(root,'scripts/personal-happier.mjs'),installation]);
  assert.equal(line(gateway,'WorkingDirectory'),root);
  assert.match(line(gateway,'Environment'),/^"PATH=.*"$/);
 }finally{await rm(base,{recursive:true,force:true});}
});
});
