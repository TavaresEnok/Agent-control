// Installs two systemd user services (Happier server and gateway) for one installation file, so they
// restart on failure and come back after a reboot (needs `loginctl enable-linger <user>` once).
// Usage: npm run personal:services -- <instalação.json> [nome]      remove: ... --remove
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
const args=process.argv.slice(2),remove=args.includes('--remove'),[installation,given]=args.filter(a=>a!=='--remove');
if(!installation){console.log('Uso: npm run personal:services -- <instalação.json> [nome] [--remove]');process.exit(0);}
const file=resolve(installation),config=JSON.parse(await readFile(file,'utf8'));
const name=(given??basename(dirname(file))).replace(/[^A-Za-z0-9_-]/g,'-');
if(!name)throw Error('INVALID_SERVICE_NAME');
const root=resolve(import.meta.dirname,'..'),units=join(homedir(),'.config/systemd/user');
const systemctl=(...a)=>execFileSync('systemctl',['--user',...a],{stdio:'inherit'});
const happier=`agent-control-happier-${name}.service`,gateway=`agent-control-gateway-${name}.service`;
if(remove){
 const ownsHappier=!await readFile(join(config.dataDirectory,'happier-shared-from'),'utf8').then(()=>true,()=>false);
 for(const unit of ownsHappier?[gateway,happier]:[gateway]){try{systemctl('disable','--now',unit);}catch{}await rm(join(units,unit),{force:true});}
 systemctl('daemon-reload');console.log(JSON.stringify({removed:[gateway,happier]}));process.exit(0);
}
if(config.activation!=='personal')throw Error('PERSONAL_ACTIVATION_REQUIRED');
const path=[dirname(process.execPath),'/usr/local/bin','/usr/bin','/bin'].join(':');
const unit=(description,exec,extra='')=>`[Unit]
Description=${description} (${name})
${extra}
[Service]
WorkingDirectory=${root}
Environment=PATH=${path}
ExecStart=${exec}
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
`;
// A project that shares another installation's Happier only gets a gateway, started after that Happier.
const sharedFrom=await readFile(join(config.dataDirectory,'happier-shared-from'),'utf8').then(t=>t.trim(),()=>null);
const happierUnit=sharedFrom?`agent-control-happier-${basename(dirname(sharedFrom)).replace(/[^A-Za-z0-9_-]/g,'-')}.service`:happier;
await mkdir(units,{recursive:true});
if(!sharedFrom)await writeFile(join(units,happier),unit('Agent Control: Happier server',`${process.execPath} ${join(root,'scripts/personal-happier.mjs')} ${file}`));
await writeFile(join(units,gateway),unit('Agent Control: gateway',`${process.execPath} --import tsx ${join(root,'src/server-main.ts')} serve ${file}`,`After=${happierUnit}\nWants=${happierUnit}`));
systemctl('daemon-reload');if(!sharedFrom)systemctl('enable','--now',happier);systemctl('enable','--now',gateway);
console.log(JSON.stringify({installed:sharedFrom?[gateway]:[happier,gateway],happier:happierUnit,logs:`journalctl --user -u ${gateway} -f`}));
