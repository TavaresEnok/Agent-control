import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {Refusal} from './contracts.ts';
import {readPrivateFile} from './installation.ts';

const exec=promisify(execFile);
export const commonToolTag='agent-control-exam-tools:simple';
export async function simpleToolsImage(dataDirectory:string){
 try{
  const {image}=JSON.parse((await readPrivateFile(join(dataDirectory,'simple-tools-image.json'))).toString());
  if(typeof image!=='string'||!/^sha256:[a-f0-9]{64}$/.test(image))throw new Refusal('VERIFY_IMAGE_UNPINNED');
  return image as string;
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 // An existing single-user installation can use the shared local build.
 // Resolve once per run, so moving the tag cannot switch a running collector.
 const id=(await exec('docker',['image','inspect','--format','{{.Id}}',commonToolTag]).catch(()=>{throw new Refusal('SIMPLE_TOOLS_IMAGE_MISSING',503);})).stdout.trim();
 if(!/^sha256:[a-f0-9]{64}$/.test(id))throw new Refusal('VERIFY_IMAGE_UNPINNED');
 return id;
}
