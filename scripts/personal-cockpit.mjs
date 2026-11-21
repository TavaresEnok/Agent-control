// Publishes one installation's cockpit (the Cezar web page served by the gateway) on a public HTTPS
// name, so it can be opened and installed as an app on the phone. Sign-in is "Entrar pelo Happier":
// the Happier app on the phone authorizes the browser; nobody without the account gets in.
//
//   npm run personal:cockpit -- <instalação.json> <subdomínio> [--check]
//
// Requirements: the Happier server is already published (personal:public), because the phone app
// authorizes through it; the name's A record points to this server. The name may be the Happier's own:
// Happier keeps /v1 /v2 /v3 /health /ready /.well-known and the cockpit gets every other path.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,rename,rm,access} from 'node:fs/promises';
import {resolve4} from 'node:dns/promises';
import {basename,dirname,join,resolve} from 'node:path';

const args=process.argv.slice(2),check=args.includes('--check'),[installation,domainArg]=args.filter(a=>a!=='--check');
if(!installation||!domainArg){console.log('Uso: npm run personal:cockpit -- <instalação.json> <subdomínio> [--check]');process.exit(installation||domainArg?1:0);}
const domain=domainArg.trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/+$/,'');
if(!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))throw Error('DOMAIN_INVALID');
const file=resolve(installation),config=JSON.parse(await readFile(file,'utf8'));
if(config.activation!=='personal')throw Error('PERSONAL_ACTIVATION_REQUIRED');
if(config.http.listen!=='127.0.0.1')throw Error('GATEWAY_MUST_LISTEN_LOCALLY');
const exists=path=>access(path).then(()=>true,()=>false);
const step=line=>console.log('» '+line);
const sharedFrom=await readFile(join(config.dataDirectory,'happier-shared-from'),'utf8').then(t=>t.trim(),()=>null);
const happierData=sharedFrom?JSON.parse(await readFile(sharedFrom,'utf8')).dataDirectory:config.dataDirectory;
const happierPublic=(await readFile(join(happierData,'happier-public-url'),'utf8').catch(()=>'')).trim();
if(!happierPublic)throw Error('HAPPIER_NOT_PUBLISHED: rode antes npm run personal:public para o Happier');
const sameName=new URL(happierPublic).hostname===domain;
// Local transport (managerTransport.transport="local") retired Happier: the site serves only the panel, with no /v1 route.
const routeHappier=sameName&&config.managerTransport?.transport!=='local';
const label=basename(dirname(file)).replace(/[^A-Za-z0-9_-]/g,'-');
const sites=process.env.AC_CADDY_SITES??'/home/app/infra/caddy/sites',container=process.env.AC_CADDY_CONTAINER??'edge_caddy';

const publicIp=(await (await fetch('https://api.ipify.org',{signal:AbortSignal.timeout(8000)})).text()).trim();
let addresses=[];try{addresses=await resolve4(domain);}catch{}
if(!addresses.includes(publicIp)){
 console.log(`» o DNS de ${domain} ainda não aponta para ${publicIp} (resolve para: ${addresses.join(', ')||'nada'}). Crie um registro A ${domain} → ${publicIp} e rode de novo.`);
 process.exit(2);
}
step(`DNS ok: ${domain} → ${publicIp}`);
if(check){step('verificação concluída; nada foi alterado');process.exit(0);}

// 1. Caddy site in front of the local gateway.
const happierLabel=sharedFrom?basename(dirname(sharedFrom)).replace(/[^A-Za-z0-9_-]/g,'-'):label;
const happierUpstream=new URL((sharedFrom?JSON.parse(await readFile(sharedFrom,'utf8')):config).happier.upstreamOrigin).host;
const site=join(sites,sameName?`happier-${happierLabel}.caddy`:`cockpit-${label}.caddy`);
const body=routeHappier?`# Happier (${happierLabel}) e cockpit (${label}) no mesmo nome — gerado por personal:cockpit.
${domain} {
\timport seguranca
\t@happier path /v1/* /v2/* /v3/* /health /ready /.well-known/*
\thandle @happier {
\t\treverse_proxy ${happierUpstream}
\t}
\thandle {
\t\treverse_proxy 127.0.0.1:${config.http.port}
\t}
}
`:`# Cockpit Agent Control (${label}) — gerado por personal:cockpit. O gateway escuta só em 127.0.0.1.
${domain} {
\timport seguranca
\treverse_proxy 127.0.0.1:${config.http.port}
}
`;
const previous=await readFile(site,'utf8').catch(()=>null);
await writeFile(site+'.tmp',body,{mode:0o664});await rename(site+'.tmp',site);
const caddy=(...a)=>execFileSync('docker',['exec',container,'caddy',...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
try{caddy('validate','--config','/etc/caddy/Caddyfile','--adapter','caddyfile');caddy('reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile');}
catch(error){
 if(previous===null)await rm(site,{force:true});else await writeFile(site,previous);
 throw Error('CADDY_REJECTED_CONFIG: '+String(error.stderr??error.message).trim().split('\n').pop());
}
step('site criado no Caddy: '+site);

// 2. The browser session cookie is bound to the public origin, and the phone app authorizes through
//    the public Happier. The gateway keeps talking to Happier on 127.0.0.1 (upstreamOrigin).
const next={...config,http:{...config.http,publicOrigin:'https://'+domain},happier:{...config.happier,webOrigin:happierPublic,publicServerOrigin:happierPublic}};
if(!await exists(file+'.before-cockpit'))await writeFile(file+'.before-cockpit',JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
await writeFile(file+'.tmp',JSON.stringify(next,null,2)+'\n',{mode:0o600});await rename(file+'.tmp',file);
step('instalação apontada para https://'+domain);
const unit=`agent-control-gateway-${label}.service`;
try{execFileSync('systemctl',['--user','restart',unit],{stdio:'ignore'});step('gateway reiniciado ('+unit+')');}
catch{step(`reinicie o gateway desta instalação (serviço ${unit} não encontrado)`);}

// 3. End-to-end: certificate issued, the page and its app manifest load through the public name.
let status=0;
for(let i=0;i<30&&status!==200;i++){status=await fetch(`https://${domain}/manifest.webmanifest`,{signal:AbortSignal.timeout(8000)}).then(r=>r.status,()=>0);if(status!==200)await new Promise(done=>setTimeout(done,5000));}
if(routeHappier&&status===200){
 const happier=await fetch(`https://${domain}/v1/account/profile`,{signal:AbortSignal.timeout(8000)}).then(r=>r.status,()=>0);
 if(happier!==401)throw Error(`HAPPIER_ROUTE_BROKEN: https://${domain}/v1 respondeu ${happier}; restaure ${site} com o conteúdo anterior`);
 step('o Happier continua respondendo em /v1');
}
if(status!==200)throw Error(`PUBLIC_CHECK_FAILED: https://${domain} não respondeu (status ${status}). Veja: docker logs ${container} --tail 50`);
step(`https://${domain} responde com certificado válido`);
console.log(`
Pronto. No celular:
  1. Abra https://${domain} no navegador (Chrome no Android, Safari no iPhone)
  2. ${routeHappier?'Toque em "Entrar pelo Happier" e depois em "Autorizar no aplicativo Happier"; aprove no app e volte':'Entre com usuário e senha (transporte local, sem o Happier)'}
  3. Instale: menu do navegador → "Adicionar à tela inicial" / "Instalar app"
Para despublicar: ${sameName?'rode de novo npm run personal:public para o Happier (o site volta a ser só dele)':'apague '+site+' e recarregue o Caddy'} e restaure ${file}.before-cockpit.`);
