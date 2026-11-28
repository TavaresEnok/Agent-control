// Builds the common exam image (modules 2 to 9 in the simple isolation), proves it and only then pins it.
// Usage: npm run personal:tools-image -- <instalação.json> [--manter-cache]
//
// The Docker daemon is shared with other projects. The build runs on the builder dedicated to this installation
// (`agent-control-<instalação>`, created when missing, never made the default), so its cache can be pruned without touching
// the daemon's. The image is built under a candidate tag and becomes the common image only after the proof passes:
// `<dataDirectory>/simple-tools-image.json` is written last. A failed proof pins nothing. Nothing is deleted here: the images the
// common one replaces are only registered as candidates for `personal:maintenance --retencao-artefatos`, which proves them by id.
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {installationName,ownerLabelArgs} from './ac-labels.mjs';

const root=resolve(import.meta.dirname,'..');
const imagePattern=/^sha256:[a-f0-9]{64}$/;
const defaultRun=(command,args,options)=>spawnSync(command,args,{encoding:'utf8',...options});
export const COMMON_TAG='agent-control-exam-tools:simple';
/** The collectors that `deploy/simple-tools/collect.sh` dispatches; each is proved inside the image. */
export const PROVED_COLLECTORS=['verify','qa','arquitetura','dependencias','banco','prontidao','documentacao','conformidade'];
/** The module images that the common image replaces once pinned (modules 2 to 9). */
export const REPLACED_MODULES=['qa','arquitetura','dependencias','banco','prontidao','desempenho','documentacao','conformidade'];

const ok=result=>!result.error&&!result.status;
const stdout=result=>(result.stdout??'').trim();
const safeName=file=>basename(dirname(resolve(file))).replace(/[^A-Za-z0-9_-]/g,'-')||'installation';

/** Same name `personal:maintenance` prunes weekly: the builder belongs to this installation and to nothing else. */
export const builderName=installationFile=>'agent-control-'+safeName(installationFile);
export const candidateTag=installationFile=>'agent-control-exam-tools:candidate-'+safeName(installationFile);

/** Creates the dedicated builder when it is missing. It is never selected with `--use`, so the default builder stays the default. */
export function ensureBuilder({run=defaultRun,builder}){
 if(ok(run('docker',['buildx','inspect',builder],{stdio:'ignore'})))return 'existing';
 const created=run('docker',['buildx','create','--name',builder,'--driver','docker-container','--bootstrap'],{stdio:'inherit'});
 if(!ok(created))throw new Error('BUILDER_CREATE_FAILED:'+builder);
 return 'created';
}

const imageId=(run,reference)=>{
 const found=stdout(run('docker',['image','inspect','--format','{{.Id}}',reference],{stdio:['ignore','pipe','ignore']}));
 return imagePattern.test(found)?found:undefined;
};

/** Runs every collector's `--check` offline, read-only and unprivileged, the way the exams run it, plus the image's protocol labels. */
export function proveImage({run=defaultRun,image,installation}){
 const failures=[];
 const labels=stdout(run('docker',['image','inspect','--format','{{index .Config.Labels "io.agent-control.simple-tools"}} {{index .Config.Labels "org.agent-control.performance.protocol"}}',image],{stdio:['ignore','pipe','ignore']}));
 if(labels!=='1 6')failures.push('rótulos');
 for(const collector of PROVED_COLLECTORS){
  const result=run('docker',['run','--rm','--pull','never','--network','none','--read-only','--user','65532:65532','--cap-drop','ALL',
   '--security-opt','no-new-privileges','--pids-limit','64','--memory','512m','--tmpfs','/tmp:rw,exec,nosuid,nodev,mode=1777,size=64m',
   ...ownerLabelArgs({installation,kind:'exam-tools-proof'}),'--entrypoint','/usr/local/bin/ac-collect',image,collector,'--check'],{stdio:['ignore','ignore','inherit']});
  if(!ok(result))failures.push(collector);
 }
 return failures;
}

export function readPin(dataDirectory){
 try{const {image}=JSON.parse(readFileSync(join(dataDirectory,'simple-tools-image.json'),'utf8'));return imagePattern.test(image)?image:undefined;}
 catch(error){if(error?.code==='ENOENT')return undefined;throw error;}
}

/** Writes the pin atomically, private to the user. */
export function writePin({dataDirectory,image,builder,now=new Date()}){
 if(!imagePattern.test(image))throw new Error('IMAGE_INVALID');
 const file=join(dataDirectory,'simple-tools-image.json'),temporary=file+'.'+randomUUID()+'.tmp';
 try{
  writeFileSync(temporary,JSON.stringify({image,builder,provedAt:now.toISOString()})+'\n',{mode:0o600,flag:'wx'});
  renameSync(temporary,file);
 }finally{rmSync(temporary,{force:true});}
}

/** Records an image as a retention candidate through the product's own command. A failure is reported, never fatal. */
export function registerCandidate({run=defaultRun,productRoot=root,installationFile,projectId,module,image}){
 const result=run(process.execPath,['--import','tsx','src/personal-maintenance-cli.ts',installationFile,'--registrar-imagem','--projeto',projectId,'--modulo',module,'--imagem',image],{cwd:productRoot,stdio:'ignore'});
 return ok(result);
}

const moduleDigest=(productRoot,module)=>{
 try{const text=readFileSync(join(productRoot,'deploy','modules',module,'digest.txt'),'utf8').trim();return imagePattern.test(text)?text:undefined;}
 catch{return undefined;}
};

/** Build, prove, pin, register. Returns what happened; throws only when the build itself or the builder fails. */
export function buildCommonImage({run=defaultRun,installationFile,productRoot=root,keepCache=false,now=new Date()}){
 const file=resolve(installationFile);
 const config=JSON.parse(readFileSync(file,'utf8'));
 const dataDirectory=config?.dataDirectory,projectId=config?.project?.id;
 if(typeof dataDirectory!=='string'||!dataDirectory.startsWith('/'))throw new Error('DATA_DIRECTORY_MISSING');
 const installation=installationName(dataDirectory),builder=builderName(file),tag=candidateTag(file);
 ensureBuilder({run,builder});
 const previous=readPin(dataDirectory);
 let image,failures;
 try{
  const built=run('docker',['buildx','bake','--builder',builder,'--load','-f',join(productRoot,'deploy','simple-tools','docker-bake.hcl'),'common'],
   {cwd:productRoot,stdio:'inherit',env:{...process.env,AC_TOOLS_TAG:tag,AC_INSTALLATION:installation}});
  if(!ok(built))throw new Error('BUILD_FAILED:'+tag);
  image=imageId(run,tag);
  if(!image)throw new Error('BUILD_IMAGE_MISSING:'+tag);
  failures=proveImage({run,image,installation});
 }finally{
  // The dedicated builder's cache is ours alone; the daemon's cache and the default builder are never touched.
  if(!keepCache)run('docker',['buildx','prune','--builder',builder,'--all','--force'],{stdio:'ignore'});
 }
 const registered=[],unregistered=[];
 const register=(module,id)=>{if(!id)return;(projectId&&registerCandidate({run,productRoot,installationFile:file,projectId,module,image:id})?registered:unregistered).push(`${module} ${id.slice(0,19)}`);};
 if(failures.length){
  // Not pinned. The candidate stays tagged for inspection and is only registered, so the retention can prove and remove it by id.
  if(image!==previous)register('simple-tools',image);
  return {pinned:false,image,builder,failures,registered,unregistered};
 }
 writePin({dataDirectory,image,builder,now});
 // The tag follows the pin only after it is written; the pin, not the tag, is what the exams use.
 run('docker',['tag',image,COMMON_TAG],{stdio:'ignore'});
 if(previous!==image)register('simple-tools',previous);
 for(const module of REPLACED_MODULES){const id=moduleDigest(productRoot,module);if(id&&id!==image&&imageId(run,id)===id)register(module,id);}
 return {pinned:true,image,builder,failures,registered,unregistered};
}

function main(){
 const args=process.argv.slice(2),installation=args.find(arg=>!arg.startsWith('--'));
 if(!installation){console.log('Uso: npm run personal:tools-image -- <instalação.json> [--manter-cache]');process.exit(0);}
 let result;
 try{result=buildCommonImage({installationFile:installation,keepCache:args.includes('--manter-cache')});}
 catch(error){console.error(`Imagem comum não construída: ${String(error?.message??error)}. Nada foi fixado.`);process.exit(1);}
 if(!result.pinned){
  console.error(`Imagem comum ${result.image.slice(0,19)} reprovada na prova (${result.failures.join(', ')}). Nada foi fixado; a imagem anterior continua.`);
  process.exit(1);
 }
 console.log(`Imagem comum ${result.image.slice(0,19)} provada e fixada (builder ${result.builder}).`);
 if(result.registered.length)console.log(`Registradas para a retenção: ${result.registered.join('; ')}. Elas só saem quando não forem mais fixadas nem estiverem em uso.`);
 if(result.unregistered.length)console.log(`Não registradas (registre com --registrar-imagem): ${result.unregistered.join('; ')}.`);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main();
