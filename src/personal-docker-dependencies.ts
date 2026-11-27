import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Installation} from './installation.ts';
import type {HealthNotice} from './personal-health.ts';

const exec=promisify(execFile);
const runDocker=async(args:string[])=>(await exec('docker',args,{timeout:15_000,maxBuffer:64*1024})).stdout;

export async function checkPersonalDockerDependencies(config:Installation['dockerDependencies'],docker=runDocker){
 const lines:string[]=[];
 const notices:HealthNotice[]=[];
 let failed=false;
 for(const name of config?.containers??[]){
  const report=(kind:string,text:string)=>{
   lines.push(text);
   notices.push({key:`docker:${name}:${kind}`,text,repeatMs:60*60*1000});
   if(kind==='failed')failed=true;
  };
  const inspect=async()=>{
   const format='{{.Id}} {{.Name}} {{.HostConfig.RestartPolicy.Name}} {{.State.Status}}';
   const [id,actual,policy,status]= (await docker(['container','inspect','--format',format,name])).trim().split(' ');
   if(!id||!(/^[a-f0-9]{64}$/).test(id)||actual!=='/'+name||!status)throw new Error('DOCKER_INSPECT_INVALID');
   return {id,policy,status};
  };
  let before:Awaited<ReturnType<typeof inspect>>;
  try{before=await inspect();}
  catch{
   report('failed',`Docker: não foi possível inspecionar ${name}. Verifique o daemon, as permissões do vigia e o nome do contêiner.`);
   continue;
  }
  try{
   let policyChanged=false,started=false;
   if(before.policy!=='unless-stopped'){
    await docker(['container','update','--restart','unless-stopped',before.id]);
    policyChanged=true;
   }
   if(config?.autoStart&&(before.status==='exited'||before.status==='created')){
    await docker(['container','start',before.id]);
    started=true;
   }
   const after=policyChanged||started?await inspect():before;
   if(after.id!==before.id||after.policy!=='unless-stopped')throw new Error('DOCKER_POLICY_UNCONFIRMED');
   if(after.status!=='running'){
    report('failed',`Docker: ${name} está fora do ar. Confira com docker container inspect ${name} e, se estiver parado, use docker container start ${name}.`);
   }else if(policyChanged||started){
    report('recovered',`Docker: ${name} está de pé com restart unless-stopped${started?' após início automático':''}.`);
   }else{
    lines.push(`Docker: ${name} está de pé com restart unless-stopped.`);
   }
  }catch{
   report('failed',`Docker: não foi possível confirmar a política ou recuperar ${name}. Confira com docker container inspect ${name} e docker logs ${name}.`);
  }
 }
 return {lines,notices,failed};
}
