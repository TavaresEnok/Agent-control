// Installs systemd user services for one installation file, so they restart on failure and come back
// after a reboot (needs `loginctl enable-linger <user>` once). Installs the Docker filter and the gateway.
// Usage: npm run personal:services -- <instalação.json> [nome]      remove: ... --remove
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {systemdEnvironment,systemdExecStart,systemdPathValue} from './systemd-exec.mjs';
const args=process.argv.slice(2),remove=args.includes('--remove'),[installation,given]=args.filter(a=>!a.startsWith('--'));
if(!installation){console.log('Uso: npm run personal:services -- <instalação.json> [nome] [--remove]');process.exit(0);}
const file=resolve(installation),config=JSON.parse(await readFile(file,'utf8'));
const name=(given??basename(dirname(file))).replace(/[^A-Za-z0-9_-]/g,'-');
if(!name)throw Error('INVALID_SERVICE_NAME');
const root=resolve(import.meta.dirname,'..'),units=join(homedir(),'.config/systemd/user');
const systemctl=(...a)=>execFileSync('systemctl',['--user',...a],{stdio:'inherit'});
const gateway=`agent-control-gateway-${name}.service`;
const dockerFilter=`agent-control-docker-filter-${name}.service`;
if(remove){
 for(const unit of [gateway,dockerFilter]){try{systemctl('disable','--now',unit);}catch{}await rm(join(units,unit),{force:true});}
 systemctl('daemon-reload');console.log(JSON.stringify({removed:[gateway,dockerFilter]}));process.exit(0);
}
if(config.activation!=='personal')throw Error('PERSONAL_ACTIVATION_REQUIRED');
const path=[dirname(process.execPath),'/usr/local/bin','/usr/bin','/bin'].join(':');
const unit=(description,argv,extra='',environment=[])=>`[Unit]
Description=${description} (${name})
${extra}
[Service]
WorkingDirectory=${systemdPathValue(root)}
Environment=${systemdEnvironment('PATH',path)}
${environment.map(([key,value])=>`Environment=${systemdEnvironment(key,value)}\n`).join('')}ExecStart=${systemdExecStart(argv)}
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
`;
await mkdir(units,{recursive:true});
// The gateway reaches Docker only through the filter (src/docker-filter.ts): fixed routes, no privileged create, host mounts
// only under the installation, the project roots, the registered repositories and /tmp (read from the installation on every check). It protects fully once the gateway
// user is outside the docker group; until then it still refuses what the product never asks for.
const filterSocket=join(config.dataDirectory,'docker-filter.sock');
await writeFile(join(units,dockerFilter),unit('Agent Control: filtro do Docker',[process.execPath,'--import','tsx',join(root,'src/docker-filter.ts'),filterSocket,'/var/run/docker.sock','@'+file],'Before='+gateway));
// --egress turns on the allowlist proxy for every personal worker, planner and manager call (AC_PERSONAL_EGRESS=1).
const egress=args.includes('--egress')||['observe','enforce'].includes(config.egress?.mode);
const gatewayEnvironment=[['AC_DOCKER_SOCKET',filterSocket],...(egress?[['AC_PERSONAL_EGRESS','1']]:[])];
await writeFile(join(units,gateway),unit('Agent Control: gateway',[process.execPath,'--import','tsx',join(root,'src/server-main.ts'),'serve',file],`After=${dockerFilter}\nRequires=${dockerFilter}`,gatewayEnvironment));
systemctl('daemon-reload');systemctl('enable','--now',dockerFilter);systemctl('enable','--now',gateway);
console.log(JSON.stringify({installed:[dockerFilter,gateway],egress,logs:`journalctl --user -u ${gateway} -f`}));
