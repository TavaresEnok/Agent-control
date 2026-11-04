import {readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {verifyRestore,type RestoreVerification} from './restore-verifier.ts';

/** Process status for one verification. 0 is only `apto`. */
export const RESTORE_VERIFY_EXIT_APTO=0;
export const RESTORE_VERIFY_EXIT_USAGE=1;
export const RESTORE_VERIFY_EXIT_PARCIAL=2;
export const RESTORE_VERIFY_EXIT_INAPTO=3;
const READ_LIMIT=1024*1024;
const USAGE='uso: node --import tsx src/restore-verify-cli.ts --manifest MANIFEST.json --observation observacao.json [--digest HEX | --digest-file ARQUIVO] [--effects efeitos.json] [--manifest-truncated]\nexit 0 apto; 1 uso; 2 parcial; 3 inapto\n';

type Args={
 manifest:string;
 observation:string;
 digest?:string;
 digestFile?:string;
 effects?:string;
 manifestTruncated:boolean;
};

function runningAsScript(){
 const entry=process.argv[1];
 if(!entry)return false;
 try{return import.meta.url===pathToFileURL(realpathSync(entry)).href;}
 catch{return false;}
}
function parseArgs(argv:readonly string[]):Args|{error:string}{
 const out:Partial<Args>&{manifestTruncated:boolean}={manifestTruncated:false};
 const take=(name:string)=>{
  const value=argv[index+1];
  if(value===undefined||value.startsWith('--'))return null;
  index+=1;
  return value;
 };
 let index=0;
 while(index<argv.length){
  const flag=argv[index];
  if(flag==='--manifest-truncated'){out.manifestTruncated=true;index+=1;continue;}
  if(flag==='--manifest'||flag==='--observation'||flag==='--digest'||flag==='--digest-file'||flag==='--effects'){
   const value=take(flag);
   if(value===null)return {error:'argumento ausente'};
   if(flag==='--manifest'){if(out.manifest)return {error:'manifesto repetido'};out.manifest=value;}
   else if(flag==='--observation'){if(out.observation)return {error:'observacao repetida'};out.observation=value;}
   else if(flag==='--digest'){if(out.digest!==undefined)return {error:'digest repetido'};out.digest=value;}
   else if(flag==='--digest-file'){if(out.digestFile)return {error:'arquivo de digest repetido'};out.digestFile=value;}
   else{if(out.effects)return {error:'efeitos repetidos'};out.effects=value;}
   index+=1;
   continue;
  }
  return {error:'argumento desconhecido'};
 }
 if(!out.manifest||!out.observation)return {error:'manifesto e observacao sao obrigatorios'};
 if(out.digest!==undefined&&out.digestFile!==undefined)return {error:'digest e arquivo de digest sao exclusivos'};
 return {manifest:out.manifest,observation:out.observation,digest:out.digest,digestFile:out.digestFile,effects:out.effects,manifestTruncated:out.manifestTruncated};
}
async function readBounded(path:string){
 const bytes=await readFile(path);
 if(bytes.byteLength>READ_LIMIT)return {ok:false as const,reason:'grande'};
 return {ok:true as const,text:bytes.toString('utf8')};
}
function proofFromText(text:string):{state:'value';value:string}|{state:'absent'}|{state:'invalid'}{
 const trimmed=text.trim();
 if(trimmed==='')return {state:'absent'};
 if(/^[a-f0-9]{64}$/.test(trimmed))return {state:'value',value:trimmed};
 let parsed:unknown;
 try{parsed=JSON.parse(trimmed);}catch{return {state:'invalid'};}
 if(parsed===null||typeof parsed!=='object'||Array.isArray(parsed))return {state:'invalid'};
 const record=parsed as Record<string,unknown>;
 if(!Object.prototype.hasOwnProperty.call(record,'manifestDigest'))return {state:'absent'};
 const digest=record.manifestDigest;
 if(digest===undefined||digest===null||digest==='')return {state:'absent'};
 if(typeof digest!=='string')return {state:'invalid'};
 return {state:'value',value:digest};
}
function exitFor(report:RestoreVerification){
 if(report.verdict==='apto')return RESTORE_VERIFY_EXIT_APTO;
 if(report.verdict==='parcial')return RESTORE_VERIFY_EXIT_PARCIAL;
 return RESTORE_VERIFY_EXIT_INAPTO;
}
/** Read a manifest, an expected digest outside it, and a restore observation.
 * Prints `verifyRestore`. A missing expected digest is inapto, never apto. */
export async function executeRestoreVerifyCli(argv:readonly string[],stderr:NodeJS.WritableStream=process.stderr,stdout:NodeJS.WritableStream=process.stdout){
 const parsed=parseArgs(argv);
 if('error' in parsed){stderr.write(USAGE);return RESTORE_VERIFY_EXIT_USAGE;}
 let manifest:unknown=null;
 let manifestTruncated=parsed.manifestTruncated;
 try{
  const file=await readBounded(parsed.manifest);
  if(!file.ok)manifestTruncated=true;
  else{
   try{manifest=JSON.parse(file.text);}
   catch{manifest=null;manifestTruncated=true;}
  }
 }catch{stderr.write(USAGE);return RESTORE_VERIFY_EXIT_USAGE;}
 let observed:unknown;
 try{
  const file=await readBounded(parsed.observation);
  if(!file.ok){stderr.write(USAGE);return RESTORE_VERIFY_EXIT_USAGE;}
  observed=JSON.parse(file.text);
 }catch{stderr.write(USAGE);return RESTORE_VERIFY_EXIT_USAGE;}
 let externalEffects:unknown=undefined;
 if(parsed.effects){
  try{
   const file=await readBounded(parsed.effects);
   if(!file.ok){stderr.write(USAGE);return RESTORE_VERIFY_EXIT_USAGE;}
   externalEffects=JSON.parse(file.text);
  }catch{stderr.write(USAGE);return RESTORE_VERIFY_EXIT_USAGE;}
 }
 const input:Record<string,unknown>={manifest,manifestTruncated,observed};
 if(externalEffects!==undefined)input.externalEffects=externalEffects;
 if(parsed.digest!==undefined)input.expectedManifestDigest=parsed.digest;
 else if(parsed.digestFile){
  let proof:{state:'value';value:string}|{state:'absent'}|{state:'invalid'};
  try{
   const file=await readBounded(parsed.digestFile);
   if(!file.ok){stderr.write(USAGE);return RESTORE_VERIFY_EXIT_USAGE;}
   proof=proofFromText(file.text);
  }catch{stderr.write(USAGE);return RESTORE_VERIFY_EXIT_USAGE;}
  if(proof.state==='invalid'){stderr.write(USAGE);return RESTORE_VERIFY_EXIT_USAGE;}
  if(proof.state==='value')input.expectedManifestDigest=proof.value;
 }
 const report=verifyRestore(input);
 stdout.write(JSON.stringify(report)+'\n');
 return exitFor(report);
}
if(runningAsScript()){
 process.exitCode=await executeRestoreVerifyCli(process.argv.slice(2));
}
