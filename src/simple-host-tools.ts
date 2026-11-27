// Prefer a complete collector installation on the host. The repository and
// toolchain enter a private, offline mount namespace as read-only bind mounts.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {access,readFile,stat} from 'node:fs/promises';
import {promisify} from 'node:util';
import type {VerificationModule} from './ledger.ts';

type Module=VerificationModule|'verify';
export type HostCollector={module:Module;identity:string;command:string[]};
const exec=promisify(execFile);
const files:Record<Exclude<Module,'desempenho'>,string[]>={
 verify:['/opt/agent-control/verify-tools.lock.json','/opt/agent-control/rules/seguranca.yaml'],
 qa:['/opt/qa-tools/qa-tools.lock.json','/opt/qa-tools/collect.mjs'],
 arquitetura:['/opt/arquitetura-tools/tools.lock.json','/opt/arquitetura-tools/collect.mjs'],
 dependencias:['/opt/dependencias-tools/dependencias-tools.lock.json','/opt/dependencias-tools/collect.mjs'],
 banco:['/opt/banco/tools.sha256','/opt/banco/collector.rb'],
 prontidao:['/opt/prontidao/tools.lock.json','/opt/prontidao/run-collector.mjs'],
 documentacao:['/opt/documentacao-tools/tools.lock.json','/opt/documentacao-tools/collect.mjs'],
 conformidade:['/opt/conformidade/tools.lock.json','/opt/conformidade/collector.py'],
};

const binds=['/bin','/lib','/lib64','/usr','/sbin','/etc/passwd','/etc/group','/etc/ld.so.cache','/etc/ssl/certs',
 '/opt/agent-control','/opt/qa-tools','/opt/qa-coverage','/opt/arquitetura-tools','/opt/dependencias-tools','/opt/banco',
 '/opt/prontidao','/opt/testssl','/opt/documentacao-tools','/opt/conformidade','/opt/java','/opt/ort','/ms-playwright'];

export function hostCollectorArgs(tool:HostCollector,repository:string,options:{databases?:string;output?:string;evidence?:string}={}){
 const args=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--uid','65532','--gid','65532','--clearenv',
  '--setenv','PATH','/usr/local/bin:/usr/bin:/bin:/usr/lib/postgresql/17/bin','--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp',
  '--setenv','PLAYWRIGHT_BROWSERS_PATH','/ms-playwright','--proc','/proc','--dev','/dev','--tmpfs','/tmp'];
 for(const path of binds)args.push('--ro-bind-try',path,path);
 args.push('--ro-bind',repository,tool.module==='verify'?'/repository':'/repo');
 if(options.databases)args.push('--ro-bind',options.databases,'/databases');
 if(options.output)args.push('--bind',options.output,'/output');
 if(options.evidence)args.push('--ro-bind',options.evidence,'/run/prontidao-evidence.json');
 return [...args,'--chdir',options.output?'/output':'/tmp','--',...tool.command];
}

export async function findHostCollector(module:Module):Promise<HostCollector|undefined>{
 // Performance measures a configured service and observer in separate containers.
 if(module==='desempenho')return;
 const command=module==='banco'?['/usr/bin/ruby','--disable=rubyopt','/opt/banco/collector.rb']:[`/usr/local/bin/${module}-entrypoint.sh`];
 try{
  await access(command[0]!,constants.X_OK);
  if(module==='verify'){
   for(const name of ['gitleaks','osv-scanner','syft','grype','opengrep','hadolint','trivy','checkov']){
    await access('/usr/local/bin/'+name,constants.X_OK);
   }
  }
  const hash=createHash('sha256');
  for(const path of [command[0]!,...files[module]]){
   const info=await stat(path);
   if(!info.isFile()||info.uid!==0||(info.mode&0o022))return;
   hash.update(path).update('\0').update(await readFile(path));
  }
  const probe={module,identity:'',command:['/bin/true']};
  await exec('/usr/bin/bwrap',hostCollectorArgs(probe,'/usr/share/doc').slice(1),{timeout:3000});
  return {module,identity:`host-${module}@sha256:${hash.digest('hex')}`,command};
 }catch{return;}
}
