// Fixed laboratory verifier. No provider, shell, key material or arbitrary command is accepted.
import { readFileSync,mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
const [snapshot,operationId,role,providedPath,encodedComposition]=process.argv.slice(2);
if(!/^[a-f0-9-]{36}$/.test(operationId)||!['qa','review','judge'].includes(role))throw Error('INVALID_VERIFIER_ARGUMENT');
if(providedPath==='--composition'){
 const sources=JSON.parse(Buffer.from(encodedComposition??'','base64').toString('utf8'));
 if(!Array.isArray(sources)||sources.length<2||sources.length>4)throw Error('INVALID_COMPOSITION');
 const temporary=mkdtempSync(join(tmpdir(),'ac-verify-'));
 try{
  mkdirSync(join(temporary,'objects'));
  const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_LITERAL_PATHSPECS:'1',
   GIT_INDEX_FILE:join(temporary,'index'),GIT_OBJECT_DIRECTORY:join(temporary,'objects'),GIT_ALTERNATE_OBJECT_DIRECTORIES:join(resolve(snapshot),'.git/objects')};
  const git=(...args)=>execFileSync('git',['-C',snapshot,...args],{encoding:'utf8',env,timeout:15000,maxBuffer:1000000}).trim();
  const head=git('rev-parse','HEAD'),parents=git('rev-list','--parents','-n','1',head).split(' ');
  if(parents.length!==2)throw Error('INVALID_COMPOSITION');
  const base=parents[1],seen=[];let tree=git('rev-parse',`${base}^{tree}`);
  for(const [i,source] of sources.entries()){
   if(!source||source.base!==base||!Array.isArray(source.writePaths)||source.writePaths.length===0||
     !/^[a-f0-9]{40}$/.test(source.commit)||!/^[a-f0-9]{40}$/.test(source.tree)||
     git('rev-parse',`refs/agent-control/sources/${i}`)!==source.commit||git('rev-parse',`${source.commit}^{tree}`)!==source.tree||
     git('rev-list','--parents','-n','1',source.commit)!==`${source.commit} ${base}`)throw Error('INVALID_COMPOSITION');
   const paths=git('diff-tree','--no-commit-id','--name-only','--no-renames','-r','-z',base,source.commit).split('\0').filter(Boolean);
   for(const path of paths){
    if(!source.writePaths.some(scope=>typeof scope==='string'&&(path===scope||path.startsWith(scope+'/')))||
      seen.some(prior=>path===prior||path.startsWith(prior+'/')||prior.startsWith(path+'/')))throw Error('INVALID_COMPOSITION');
    const entry=git('ls-tree',source.commit,'--',path);if(entry&&!/^(100644|100755) blob /.test(entry))throw Error('INVALID_COMPOSITION');
    seen.push(path);
   }
   git('read-tree','-m',base,tree,source.commit);if(git('ls-files','-u'))throw Error('INVALID_COMPOSITION');tree=git('write-tree');
  }
  if(tree!==git('rev-parse','HEAD^{tree}'))throw Error('INVALID_COMPOSITION');
  console.log(JSON.stringify({role,status:'passed',checks:['source-identities','scopes','composition-tree'],synthetic:true}));
 }finally{rmSync(temporary,{recursive:true,force:true});}
 process.exit(0);
}
const outputPath=providedPath??`synthetic-${operationId}.txt`;
if(!/^(?!\.)(?!.*(?:^|\/)\.)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(outputPath)||outputPath.length>240)throw Error('INVALID_VERIFIER_ARGUMENT');
const source=readFileSync(join(resolve(snapshot),outputPath),'utf8');
let passed;
if(role==='qa')passed=source===`Synthetic isolated effect ${operationId}\n`;
else passed=source.length<200&&source.startsWith('Synthetic isolated effect ')&&source.endsWith('\n')&&!source.includes('\0');
console.log(JSON.stringify({role,status:passed?'passed':'failed',checks:role==='qa'?['exact-fixture-result']:['fixture-format','size','no-nul'],synthetic:true}));
process.exit(passed?0:1);
