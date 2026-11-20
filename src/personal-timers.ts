import {execFileSync} from 'node:child_process';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {Refusal} from './contracts.ts';
import {loadInstallation} from './installation.ts';
import {personalBackupRoot} from './personal-backup-paths.ts';
import {personalServiceName} from './personal-watch.ts';

export type PersonalTimerUnit={file:string;text:string};
export type PersonalTimerDeps={
 home?:string;
 systemctl?:(args:string[])=>void;
 execPath?:string;
 root?:string;
};

function serviceUnit(description:string,name:string,root:string,execPath:string,exec:string){
 const path=[dirname(execPath),'/usr/local/bin','/usr/bin','/bin'].join(':');
 return `[Unit]
Description=${description} (${name})

[Service]
Type=oneshot
WorkingDirectory=${root}
Environment=PATH=${path}
ExecStart=${exec}
UMask=0077
`;
}

function timerUnit(description:string,name:string,unit:string,schedule:string){
 return `[Unit]
Description=${description} (${name})

[Timer]
${schedule}
Unit=${unit}
Persistent=true

[Install]
WantedBy=timers.target
`;
}

/** Unit text for the 2-minute watch, the 03:30 backup, Sunday's maintenance and the monthly restore proof. No systemd calls. */
export function personalTimerUnits(input:{name:string;root:string;installationFile:string;execPath:string}){
 const {name,root,installationFile,execPath}=input;
 const backupDirectory=join(personalBackupRoot,name);
 const watchService=`agent-control-watch-${name}.service`;
 const watchTimer=`agent-control-watch-${name}.timer`;
 const backupService=`agent-control-backup-${name}.service`;
 const backupTimer=`agent-control-backup-${name}.timer`;
 const watchExec=`${execPath} ${join(root,'scripts/personal-watch.mjs')} ${installationFile}`;
 const backupExec=`${execPath} ${join(root,'scripts/personal-backup-rotate.mjs')} ${installationFile} ${backupDirectory}`;
 const maintenanceService=`agent-control-maintenance-${name}.service`;
 const maintenanceTimer=`agent-control-maintenance-${name}.timer`;
 const restoreService=`agent-control-restore-proof-${name}.service`;
 const restoreTimer=`agent-control-restore-proof-${name}.timer`;
 const maintenanceExec=`${execPath} ${join(root,'scripts/personal-maintenance.mjs')} ${installationFile}`;
 const restoreExec=`${execPath} ${join(root,'scripts/personal-restore-proof.mjs')} ${installationFile} ${backupDirectory}`;
 const units:PersonalTimerUnit[]=[
  {file:watchService,text:serviceUnit('Agent Control: watch',name,root,execPath,watchExec)},
  {file:watchTimer,text:timerUnit('Agent Control: watch',name,watchService,'OnBootSec=2min\nOnUnitActiveSec=2min')},
  {file:backupService,text:serviceUnit('Agent Control: backup',name,root,execPath,backupExec)},
  {file:backupTimer,text:timerUnit('Agent Control: backup',name,backupService,'OnCalendar=*-*-* 03:30:00\nAccuracySec=1min')},
  {file:maintenanceService,text:serviceUnit('Agent Control: maintenance',name,root,execPath,maintenanceExec)},
  {file:maintenanceTimer,text:timerUnit('Agent Control: maintenance',name,maintenanceService,'OnCalendar=Sun *-*-* 04:00:00\nAccuracySec=1min')},
  {file:restoreService,text:serviceUnit('Agent Control: restore proof',name,root,execPath,restoreExec)},
  {file:restoreTimer,text:timerUnit('Agent Control: restore proof',name,restoreService,'OnCalendar=*-*-01 04:30:00\nAccuracySec=1min')},
 ];
 const enable=[watchTimer,backupTimer,maintenanceTimer,restoreTimer];
 return {backupDirectory,units,enable,remove:[...enable,watchService,backupService,maintenanceService,restoreService]};
}

/** Write the user units, then daemon-reload and enable --now the timers. --remove drops them. */
export async function runPersonalTimers(argv:string[],deps:PersonalTimerDeps={}){
 const remove=argv.includes('--remove');
 const [installation]=argv.filter(arg=>arg!=='--remove');
 if(!installation||installation.startsWith('--')||argv.filter(arg=>arg!=='--remove').length!==1)throw new Refusal('TIMERS_USAGE');
 const installationFile=resolve(installation);
 const name=personalServiceName(installationFile);
 const root=deps.root??fileURLToPath(new URL('..',import.meta.url));
 const execPath=deps.execPath??process.execPath;
 const plan=personalTimerUnits({name,root,installationFile,execPath});
 const unitsDir=join(deps.home??homedir(),'.config/systemd/user');
 const systemctl=deps.systemctl??(args=>execFileSync('systemctl',['--user',...args],{stdio:'inherit'}));
 if(remove){
  for(const unit of plan.remove){
   try{systemctl(['disable','--now',unit]);}catch{/* already gone */}
   await rm(join(unitsDir,unit),{force:true});
  }
  systemctl(['daemon-reload']);
  return JSON.stringify({removed:plan.remove});
 }
 const config=await loadInstallation(installationFile);
 if(config.activation!=='personal')throw new Refusal('TIMERS_PERSONAL_REQUIRED');
 await mkdir(unitsDir,{recursive:true,mode:0o700});
 for(const unit of plan.units)await writeFile(join(unitsDir,unit.file),unit.text,{mode:0o644});
 systemctl(['daemon-reload']);
 for(const timer of plan.enable)systemctl(['enable','--now',timer]);
 return JSON.stringify({installed:plan.enable,backupDirectory:plan.backupDirectory});
}
