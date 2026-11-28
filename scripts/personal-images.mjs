// Rebuilds the three personal native images and runs personal:setup.
// Usage: npm run personal:images -- <instalação.json> [nome]
//
// The Docker daemon is shared with other projects. This command therefore never runs a cleanup that acts on the whole daemon
// (untagged images, build cache, system): it removes only the build contexts it created itself, and it records the IDs of the images
// it replaced so that `personal:maintenance --retencao-artefatos` can prove and remove exactly those, later, by id.
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,rmSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {basename,dirname,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {installationName,ownerLabelArgs} from './ac-labels.mjs';

const root=resolve(import.meta.dirname,'..');
const contextName=/^native-(planning|execution|tools)-image-[A-Za-z0-9]+$/;
const imagePattern=/^sha256:[a-f0-9]{64}$/;
const defaultRun=(command,args,options)=>spawnSync(command,args,{encoding:'utf8',...options});

/** Removes a build context only when it is a direct child of the product's `.state` and has exactly the name the prepare scripts give it. */
export function discardContext(context,stateRoot,remove=rmSync){
 const path=resolve(context);
 if(!path.startsWith(stateRoot+sep)||dirname(path)!==stateRoot||!contextName.test(basename(path)))return false;
 remove(path,{recursive:true,force:true});
 return true;
}

const imageId=(run,tag)=>{
 const result=run('docker',['image','inspect',tag,'--format','{{.Id}}'],{stdio:['ignore','pipe','ignore']});
 const found=(result.stdout??'').trim();
 return !result.error&&!result.status&&imagePattern.test(found)?found:undefined;
};

/** Builds each tag. Remembers the id the tag pointed to before and after, and always discards the context this run created. */
/** `owner` adds the installation's ownership labels to each image, with the item's kind (`native-<kind>`). */
export function buildImages({builds,stateRoot,run=defaultRun,remove=rmSync,owner}){
 const built=[];
 for(const {tag,context,kind} of builds){
  const previous=imageId(run,tag);
  const labels=owner?ownerLabelArgs({installation:owner.installation,kind:'native-'+kind}):[];
  const result=run('docker',['build','-t',tag,...labels,context],{stdio:'inherit'});
  discardContext(context,stateRoot,remove);
  if(result.error||result.status)throw new Error('BUILD_FAILED:'+tag);
  built.push({tag,kind,previous,current:imageId(run,tag)});
 }
 return built;
}

/** The images that a rebuild left without a tag: the previous id of a tag whose id changed. */
export function replacedImages(built){
 return built.filter(item=>item.previous&&item.current&&item.previous!==item.current).map(item=>({tag:item.tag,imageId:item.previous}));
}

export function readProjectId(installationFile){
 const id=JSON.parse(readFileSync(installationFile,'utf8'))?.project?.id;
 if(typeof id!=='string'||!id)throw new Error('PROJECT_ID_MISSING');
 return id;
}

/** Records each replaced image as a candidate through the product's own command. Failure is reported and never stops the rebuild. */
export function registerReplaced({run=defaultRun,root:productRoot=root,installationFile,projectId,replaced}){
 const registered=[],failed=[];
 for(const {imageId:id} of replaced){
  const result=run(process.execPath,['--import','tsx','src/personal-maintenance-cli.ts',installationFile,'--registrar-imagem','--projeto',projectId,'--modulo','native-runtime','--imagem',id],{cwd:productRoot,stdio:'ignore'});
  (result.error||result.status?failed:registered).push(id);
 }
 return {registered,failed};
}

async function main(){
 const [installation,given]=process.argv.slice(2);
 if(!installation){console.log('Uso: npm run personal:images -- <instalação.json> [nome]');process.exit(0);}
 const file=resolve(installation);
 const name=(given??basename(dirname(file))).replace(/[^A-Za-z0-9_-]/g,'-');
 if(!name)throw Error('INVALID_SERVICE_NAME');
 const env={...process.env};
 const resolved=(bin)=>execFileSync('readlink',['-f',execFileSync('which',[bin],{encoding:'utf8'}).trim()],{encoding:'utf8'}).trim();
 if(!env.AC_NATIVE_CLAUDE_BIN)env.AC_NATIVE_CLAUDE_BIN=resolved('claude');
 if(!env.AC_NATIVE_GROK_BIN)env.AC_NATIVE_GROK_BIN=resolved('grok');
 const npmRoot=execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim();
 const elf=execFileSync('find',[npmRoot+'/@openai','-type','f','-name','codex','-size','+1M'],{encoding:'utf8'}).split('\n').map(line=>line.trim()).find(Boolean);
 if(!elf)throw Error('CODEX_ELF_NOT_FOUND');
 const sha=createHash('sha256').update(await readFile(elf)).digest('hex');
 const prepare=(script)=>{
  const result=spawnSync(process.execPath,[resolve(import.meta.dirname,script),elf,sha],{env,encoding:'utf8',stdio:['inherit','pipe','inherit']});
  if(result.error||result.status)process.exit(result.status??1);
  const line=result.stdout.trim().split('\n').findLast(row=>row.startsWith('{'));
  if(!line)throw Error('PREPARE_OUTPUT_MISSING');
  const parsed=JSON.parse(line);if(!parsed.context||parsed.prepared!==true)throw Error('PREPARE_CONTEXT_MISSING');
  return parsed.context;
 };
 const contexts={planning:prepare('prepare-native-planning-image.mjs'),execution:prepare('prepare-native-execution-image.mjs'),tools:prepare('prepare-native-tools-image.mjs')};
 // Each build context holds copies of the CLI binaries (hundreds of MB): it is removed right after its build, whatever the outcome.
 const stateRoot=resolve(root,'.state');
 let built;
 try{
  const dataDirectory=JSON.parse(readFileSync(file,'utf8'))?.dataDirectory;
  built=buildImages({stateRoot,owner:typeof dataDirectory==='string'?{installation:installationName(dataDirectory)}:undefined,builds:[
   {tag:'ac-native-planning:personal',context:contexts.planning,kind:'planning'},
   {tag:'ac-native-execution:personal',context:contexts.execution,kind:'execution'},
   {tag:'ac-native-tools:personal',context:contexts.tools,kind:'tools'}]});
 }catch(error){
  for(const context of Object.values(contexts))discardContext(context,stateRoot);
  console.error(String(error?.message??error));process.exit(1);
 }
 const id=tag=>execFileSync('docker',['image','inspect',tag,'--format','{{.Id}}'],{encoding:'utf8'}).trim();
 // The replaced images stay in Docker, and the build cache stays with the daemon: both are shared. Their ids are only recorded here.
 try{
  const replaced=replacedImages(built);
  const outcome=registerReplaced({installationFile:file,projectId:readProjectId(file),replaced});
  if(replaced.length)console.log(`Imagens substituídas registradas para a retenção: ${outcome.registered.length} de ${replaced.length}${outcome.failed.length?` (falharam: ${outcome.failed.length}; registre com --registrar-imagem --modulo native-runtime)`:''}.`);
 }catch{console.error('Aviso: as imagens substituídas não puderam ser registradas para a retenção.');}
 const setup=spawnSync(process.execPath,[resolve(import.meta.dirname,'personal-setup.mjs'),file],{stdio:'inherit',env:{...env,
  AC_NATIVE_PLANNING_IMAGE:id('ac-native-planning:personal'),AC_NATIVE_WORKER_IMAGE:id('ac-native-execution:personal'),AC_NATIVE_TOOLS_IMAGE:id('ac-native-tools:personal')}});
 if(setup.error||setup.status)process.exit(setup.status??1);
 console.log(`Reinicie o gateway: systemctl --user restart agent-control-gateway-${name}`);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
