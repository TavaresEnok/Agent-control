// A evidência versionada em docs/validation/evidence só é regravada com AC_WRITE_EVIDENCE=1.
// Sem a opção, o teste ainda monta e grava o JSON, mas numa pasta temporária apagada quando o processo sai.
import {mkdtempSync,rmSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve} from 'node:path';

let scratch:string|undefined;
const scratchDirectory=()=>{
 if(scratch===undefined){
  const directory=mkdtempSync(join(tmpdir(),'ac-evidence-'));
  scratch=directory;
  process.once('exit',()=>rmSync(directory,{recursive:true,force:true}));
 }
 return scratch;
};

/** Caminho onde a evidência `name` é gravada nesta execução. */
export function evidencePath(name:string,root=process.cwd()):string{
 if(basename(name)!==name)throw Error('EVIDENCE_NAME_INVALID');
 return process.env.AC_WRITE_EVIDENCE==='1'?resolve(root,'docs/validation/evidence',name):join(scratchDirectory(),name);
}

export async function writeEvidence(name:string,body:string,root?:string):Promise<string>{
 const path=evidencePath(name,root);
 await writeFile(path,body);
 return path;
}
