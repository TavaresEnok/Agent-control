// Publishes one installation's Happier server on a public HTTPS name through the host's edge Caddy.
//
//   npm run personal:public -- <instalação.json> <subdomínio> [--check]
//
// Requirements: the name's A record points to this server; the account and conversation already
// exist (personal-connect), because publishing closes anonymous sign-up. --check only verifies.
// The gateway keeps talking to Happier on 127.0.0.1; only the app uses the public name.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,rename,access} from 'node:fs/promises';
import {resolve4} from 'node:dns/promises';
import {basename,dirname,join,resolve} from 'node:path';

const args=process.argv.slice(2),check=args.includes('--check'),[installation,domainArg]=args.filter(a=>a!=='--check');
if(!installation||!domainArg){console.log('Uso: npm run personal:public -- <instalação.json> <subdomínio> [--check]');process.exit(installation||domainArg?1:0);}
const domain=domainArg.trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/+$/,'');
if(!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))throw Error('DOMAIN_INVALID');
const file=resolve(installation),config=JSON.parse(await readFile(file,'utf8'));
if(config.activation!=='personal')throw Error('PERSONAL_ACTIVATION_REQUIRED');
const upstream=new URL(config.happier.upstreamOrigin);
if(upstream.hostname!=='127.0.0.1')throw Error('HAPPIER_UPSTREAM_MUST_BE_LOCAL');
const label=basename(dirname(file)).replace(/[^A-Za-z0-9_-]/g,'-');
const sites=process.env.AC_CADDY_SITES??'/home/app/infra/caddy/sites',container=process.env.AC_CADDY_CONTAINER??'edge_caddy';
const step=line=>console.log('» '+line);
const exists=path=>access(path).then(()=>true,()=>false);

// 1. The conversation must exist before sign-up closes.
if(!config.managerTransport?.contexts?.length||!await exists(join(config.dataDirectory,'happier-account.key')))
 throw Error('PERSONAL_CONNECT_REQUIRED: rode antes npm run gateway -- personal-connect '+file);
// 2. Local Happier answers.
const local=await fetch(config.happier.upstreamOrigin+'/v1/account/profile',{signal:AbortSignal.timeout(5000)}).then(r=>r.status,()=>0);
if(local!==401)throw Error('HAPPIER_NOT_RUNNING: suba o serviço do Happier desta instalação');
step('Happier local responde em '+config.happier.upstreamOrigin);
// 3. DNS points here.
const publicIp=(await (await fetch('https://api.ipify.org',{signal:AbortSignal.timeout(8000)})).text()).trim();
let addresses=[];try{addresses=await resolve4(domain);}catch{}
if(!addresses.includes(publicIp)){
 console.log(`» o DNS de ${domain} ainda não aponta para ${publicIp} (resolve para: ${addresses.join(', ')||'nada'}). Crie um registro A ${domain} → ${publicIp} e rode de novo.`);
 process.exit(2);
}
step(`DNS ok: ${domain} → ${publicIp}`);
if(check){step('verificação concluída; nada foi alterado');process.exit(0);}

// 4. Caddy site (automatic Let's Encrypt certificate; WebSocket upgrades are proxied by default).
const site=join(sites,`happier-${label}.caddy`);
const body=`# Happier (${label}) para o app — gerado por personal:public. O gateway usa ${config.happier.upstreamOrigin} direto.
${domain} {
\timport seguranca
\treverse_proxy ${upstream.host}
}
`;
const previous=await readFile(site,'utf8').catch(()=>null);
await writeFile(site+'.tmp',body,{mode:0o664});await rename(site+'.tmp',site);
const caddy=(...a)=>execFileSync('docker',['exec',container,'caddy',...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
try{caddy('validate','--config','/etc/caddy/Caddyfile','--adapter','caddyfile');caddy('reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile');}
catch(error){
 if(previous===null)await (await import('node:fs/promises')).rm(site,{force:true});else await writeFile(site,previous);
 throw Error('CADDY_REJECTED_CONFIG: '+String(error.stderr??error.message).trim().split('\n').pop());
}
step('site criado no Caddy: '+site);

// 5. Close sign-up and advertise the public URL, then restart Happier with it.
await writeFile(join(config.dataDirectory,'happier-public-url'),'https://'+domain+'\n',{mode:0o600});
const unit=`agent-control-happier-${label}.service`;
let restarted=false;
try{execFileSync('systemctl',['--user','restart',unit],{stdio:'ignore'});restarted=true;step('Happier reiniciado com cadastro anônimo fechado ('+unit+')');}
catch{step(`reinicie o Happier desta instalação para fechar o cadastro anônimo (serviço ${unit} não encontrado)`);}
if(restarted)for(let i=0;i<60;i++){if(await fetch(config.happier.upstreamOrigin+'/v1/account/profile',{signal:AbortSignal.timeout(3000)}).then(r=>r.status===401,()=>false))break;await new Promise(done=>setTimeout(done,2000));}

// 6. End-to-end: certificate issued and the API answers through the public name.
let status=0;
for(let i=0;i<30&&status!==401;i++){status=await fetch(`https://${domain}/v1/account/profile`,{signal:AbortSignal.timeout(8000)}).then(r=>r.status,()=>0);if(status!==401)await new Promise(done=>setTimeout(done,5000));}
if(status!==401)throw Error(`PUBLIC_CHECK_FAILED: https://${domain} não respondeu como o Happier (status ${status}). Veja: docker logs ${container} --tail 50`);
step(`https://${domain} responde com certificado válido`);
console.log(`
Pronto. No app Happier:
  1. Servidor → adicionar https://${domain} e selecionar
  2. Restaurar conta → Restaurar com chave secreta
     (a chave: npm run gateway -- app-key ${file})
Para despublicar: apague ${site}, recarregue o Caddy e remova ${join(config.dataDirectory,'happier-public-url')}.`);
