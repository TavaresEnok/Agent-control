// Repositórios sintéticos dos testes ficam em .state/projects (a admissão de projeto aceita esse lugar),
// mas são apagados quando o processo do teste sai, inclusive depois de uma falha.
import {rmSync} from 'node:fs';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';

const created:string[]=[];
process.once('exit',()=>{for(const repo of created)rmSync(repo,{recursive:true,force:true});});

export async function projectRepository(prefix:string):Promise<string>{
 if(!/^[A-Za-z0-9-]+$/.test(prefix))throw Error('PROJECT_PREFIX_INVALID');
 await mkdir('.state/projects',{recursive:true});
 const repo=await mkdtemp(resolve('.state/projects',prefix));
 created.push(repo);
 return repo;
}
