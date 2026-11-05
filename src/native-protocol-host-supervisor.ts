/** Runs under the exact executable inode of the trusted host controller, never
 * an interpreter supplied by the candidate image. No caller code/command/path. */
export const nativeProtocolHostSupervisor = String.raw`
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');const run=promisify(execFile);
const op=JSON.parse(process.argv[1]);
if(!/^[a-f0-9-]{36}$/.test(op.id)||!/^sha256:[a-f0-9]{64}$/.test(op.worker_image)||!['version','rpc'].includes(op.phase)||op.container_name!=='ac-protocol-'+op.phase+'-'+op.id||!Number.isSafeInteger(Number(op.deadline_ms)))process.exit(70);
const env={PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C.UTF-8'};
let terminalCode=null;let id=null,created=false,stopped=false,started=false,attached,cleaning;
const send=value=>{if(process.connected)try{process.send(value,()=>{});}catch{}};
const inspect=async name=>{try{return JSON.parse((await run('/usr/bin/docker',['inspect',name],{env,timeout:10000,maxBuffer:262144})).stdout)[0];}catch(error){if(/(?:no such object|no such container)/i.test(String(error.stderr??'')))return null;throw error;}};
const valid=value=>value&&value.Image===op.worker_image&&value.Config?.Labels?.['agent-control.protocol-operation']===op.id&&value.Config?.Labels?.['agent-control.protocol-deadline']===String(op.deadline_ms)&&(!id||value.Id===id)&&/^[a-f0-9]{64}$/.test(value.Id);
const isolated=value=>value.HostConfig?.NetworkMode==='none'&&value.HostConfig?.ReadonlyRootfs===true&&value.HostConfig?.Privileged===false&&value.HostConfig?.PidMode!=='host'&&value.HostConfig?.PidsLimit===32&&value.HostConfig?.Memory===134217728&&value.HostConfig?.NanoCpus===500000000&&value.Config?.User==='65534:65534'&&Array.isArray(value.HostConfig?.CapDrop)&&value.HostConfig.CapDrop.includes('ALL')&&JSON.stringify(value.Config?.Entrypoint)===JSON.stringify(['/usr/local/bin/codex'])&&JSON.stringify(value.Config?.Cmd)===JSON.stringify([op.phase==='version'?'--version':'app-server'])&&Array.isArray(value.Mounts)&&value.Mounts.every(mount=>mount.Type==='tmpfs'&&mount.Destination==='/tmp');
const cleanup=()=>{
 stopped=true;if(!created)return;
 if(cleaning)return cleaning;
 cleaning=(async()=>{try{
  const physical=await inspect(id??op.container_name);if(physical){if(!physical.State?.Running&&physical.State?.Status==='exited'&&Number.isInteger(physical.State?.ExitCode))terminalCode=physical.State.ExitCode;if(!valid(physical))throw Error('identity');id=physical.Id;await run('/usr/bin/docker',['rm','-f','-v',id],{env,timeout:10000,maxBuffer:65536});if(await inspect(id))throw Error('removal');}
  attached?.kill('SIGKILL');send({type:'retired',id,exitCode:terminalCode});setTimeout(()=>process.exit(0),10);
 }catch{send({type:'uncertain'});process.exit(75);}})();return cleaning;
};
const timer=setTimeout(()=>void cleanup(),Math.max(1,Number(op.deadline_ms)-Date.now()));
process.on('disconnect',()=>void cleanup());process.on('SIGTERM',()=>void cleanup());process.on('SIGINT',()=>void cleanup());
process.stdin.on('error',()=>void cleanup());process.stdout.on('error',()=>void cleanup());process.stderr.on('error',()=>void cleanup());
process.on('message',message=>{if(message?.stop){void cleanup();return;}
 if(!message?.start||message.id!==id||started||stopped||Date.now()>=Number(op.deadline_ms)){void cleanup();return;}
 started=true;attached=spawn('/usr/bin/docker',['start','-a','-i',id],{env,stdio:['pipe','pipe','pipe']});
 attached.stdin.on('error',()=>void cleanup());attached.on('error',()=>void cleanup());
 attached.stdout.on('error',()=>void cleanup());attached.stderr.on('error',()=>void cleanup());
 process.stdin.pipe(attached.stdin);attached.stdout.pipe(process.stdout);attached.stderr.pipe(process.stderr);attached.on('exit',()=>void cleanup());
});
(async()=>{try{
 if(stopped||Date.now()>=Number(op.deadline_ms)){created=true;await cleanup();return;}
 const candidate=JSON.parse((await run('/usr/bin/docker',['image','inspect',op.worker_image],{env,timeout:10000,maxBuffer:262144})).stdout)[0];if(candidate.Id!==op.worker_image||Object.keys(candidate.Config?.Volumes??{}).length)throw Error('unsupported image volumes');
 const args=['create','--name',op.container_name,'--label','agent-control.protocol-check=true','--label','agent-control.protocol-image='+op.worker_image,'--label','agent-control.protocol-operation='+op.id,'--label','agent-control.protocol-deadline='+op.deadline_ms,'--network','none','--read-only','--user','65534:65534','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--memory','128m','--cpus','0.5','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--env','HOME=/tmp','--entrypoint','/usr/local/bin/codex','-i',op.worker_image,op.phase==='version'?'--version':'app-server'];
 const output=await run('/usr/bin/docker',args,{env,timeout:10000,maxBuffer:8192});id=output.stdout.trim();if(!/^[a-f0-9]{64}$/.test(id))throw Error('id');
 created=true;const physical=await inspect(id);if(!valid(physical)||!isolated(physical))throw Error('identity');
 if(stopped||Date.now()>=Number(op.deadline_ms)){await cleanup();return;}
 send({type:'created',id});
 }catch{created=true;await cleanup();}})();
`;
