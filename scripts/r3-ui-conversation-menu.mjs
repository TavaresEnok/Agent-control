// Synthetic caller proof using the current canonical Happier app and real menu.
// Credentials stay in browser memory/storage for this disposable fixture only.
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {cp,mkdir,readFile,readdir,realpath,stat,writeFile} from 'node:fs/promises';
import {resolve,join,sep,extname,dirname} from 'node:path';
import {createHash} from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
const ui=join(root,'upstream/happier/apps/ui');
const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.wasm':'application/wasm','.png':'image/png','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2','.css':'text/css','.ico':'image/x-icon'};
async function buildApp(directory,panelOrigin,happierOrigin){
 if(process.env.AC_R4_CONVERSATION_BUILD_DIR){
  const artifact=resolve(process.env.AC_R4_CONVERSATION_BUILD_DIR),manifest=JSON.parse(await readFile(join(artifact,'manifest.json'),'utf8'));
  if(manifest.schemaVersion!==1||manifest.panelOrigin!==panelOrigin||manifest.happierOrigin!==happierOrigin||!Array.isArray(manifest.files)||manifest.files.length<1)throw Error('CANONICAL_BUILD_MANIFEST_MISMATCH');
  const expectedTree=execFileSync('git',['rev-parse','HEAD:upstream/happier'],{cwd:root,encoding:'utf8'}).trim();
  if(manifest.happierTree!==expectedTree)throw Error('CANONICAL_BUILD_SOURCE_MISMATCH');
  execFileSync('git',['diff','--quiet','HEAD','--','upstream/happier'],{cwd:root});
  const output=join(artifact,'web');
  for(const file of manifest.files){const path=resolve(output,file.path);if(!path.startsWith(output+sep)||createHash('sha256').update(await readFile(path)).digest('hex')!==file.sha256)throw Error('CANONICAL_BUILD_DIGEST_MISMATCH')}
  await writeFile(join(directory,'happier-export.log'),'Reused immutable canonical export; every manifest file SHA256 verified; sourcePin='+manifest.sourcePin+'\n');
  return output;
 }

 const env={HOME:join(directory,'home'),PATH:process.env.PATH??'/usr/bin:/bin',CI:'1',EXPO_NO_TELEMETRY:'1',DO_NOT_TRACK:'1',
  EXPO_UNSTABLE_WEB_MODAL:'1',EXPO_PUBLIC_HAPPIER_SERVER_URL:happierOrigin,EXPO_PUBLIC_AGENT_CONTROL_ORIGIN:panelOrigin,
  NODE_PATH:join(root,'upstream/happier/node_modules'),NODE_OPTIONS:'--max-old-space-size=8192'};
 await mkdir(env.HOME,{recursive:true});
 const output=join(directory,'web');
 // Metro must watch the actual cache paths when this disposable worktree uses
 // dependency symlinks. Override only the fixture's watch roots, preserving the
 // canonical resolver/transformer and every application source file.
 const roots=await Promise.all([realpath(join(ui,'node_modules')),realpath(join(root,'upstream/happier/node_modules'))]);
 roots.push(dirname(await realpath(join(root,'upstream/happier/node_modules/expo'))));
 roots.push(dirname(await realpath(join(root,'upstream/happier/node_modules/@happier-dev/protocol'))));
 const override=join(directory,'metro.fixture.cjs');
 await writeFile(override,'const fs=require("node:fs");const config=require('+JSON.stringify(join(ui,'metro.config.js'))+');config.watchFolders=[...new Set([...(config.watchFolders||[]).map(p=>fs.realpathSync(p)),...'+JSON.stringify(roots)+'])];module.exports=config;');
 env.EXPO_OVERRIDE_METRO_CONFIG=override;
 const child=spawn(join(root,'upstream/happier/apps/stack/bin/hstack-exec'),['--',process.execPath,
  join(root,'upstream/happier/node_modules/expo/bin/cli'),'export',ui,'--platform','web','--output-dir',output,'--max-workers','2'],
  {cwd:ui,env,stdio:['ignore','pipe','pipe'],detached:true});
 let log='';child.stdout.on('data',chunk=>{log+=chunk});child.stderr.on('data',chunk=>{log+=chunk});
 try{
  await new Promise((ok,fail)=>{
   const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{};fail(Error('R3_HAPPIER_EXPORT_TIMEOUT'))},600000);
   child.once('error',error=>{clearTimeout(timer);fail(error)});
   child.once('exit',code=>{clearTimeout(timer);code===0?ok():fail(Error('R3_HAPPIER_EXPORT_FAILED_'+code))});
  });
 }finally{await writeFile(join(directory,'happier-export.log'),log)}
 if(process.env.AC_R4_CONVERSATION_EXPORT_DIR){
  const artifact=resolve(process.env.AC_R4_CONVERSATION_EXPORT_DIR);await mkdir(artifact);
  await cp(output,join(artifact,'web'),{recursive:true,errorOnExist:true,force:false});
  const files=[];
  async function collect(directory,prefix=''){for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const relative=prefix+entry.name,path=join(directory,entry.name);if(entry.isDirectory())await collect(path,relative+'/');else if(entry.isFile())files.push({path:relative,sha256:createHash('sha256').update(await readFile(path)).digest('hex')});else throw Error('CANONICAL_EXPORT_FILE_UNSUPPORTED')}}
  await collect(join(artifact,'web'));
  const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  const manifest={schemaVersion:1,sourcePin:git(['rev-parse','HEAD']),happierTree:git(['rev-parse','HEAD:upstream/happier']),panelOrigin,happierOrigin,files};
  await writeFile(join(artifact,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
  console.log('CANONICAL_EXPORT_READY '+artifact+' files='+files.length);
 }
 return output;
}
export async function proveConversationMenu({browserContext,panelOrigin,happierOrigin,sessionId,token,secret32base64,contextId,scratchDirectory}){
 if(!panelOrigin.startsWith('http://127.0.0.1:')||!happierOrigin.startsWith('http://127.0.0.1:')||Buffer.from(secret32base64,'base64').length!==32)throw Error('SYNTHETIC_LOOPBACK_ACCOUNT_REQUIRED');
 const directory=join(scratchDirectory,'canonical-conversation-menu');await mkdir(directory,{recursive:true});
 const output=await buildApp(directory,panelOrigin,happierOrigin);
 const server=createServer(async(req,res)=>{
  try{
   const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
   let path=resolve(output,'.'+pathname);if(!path.startsWith(output+sep)&&path!==output)throw Error('path');
   try{if(!(await stat(path)).isFile())path=join(output,'index.html')}catch{path=join(output,'index.html')}
   res.writeHead(200,{'content-type':types[extname(path)]??'application/octet-stream','cache-control':'no-store'});res.end(await readFile(path));
  }catch{res.writeHead(404);res.end()}
 });
 await new Promise((ok,fail)=>server.once('error',fail).listen(0,'127.0.0.1',ok));
 const origin='http://127.0.0.1:'+server.address().port;
 const page=await browserContext.newPage();
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const allowed=new Set([origin,panelOrigin,happierOrigin]);
 const localOnly=route=>{const url=new URL(route.request().url());return allowed.has(url.origin)||['data:','blob:'].includes(url.protocol)?route.continue():route.abort()};
 await browserContext.route('**/*',localOnly);
 await browserContext.routeWebSocket('**/*',route=>{const url=new URL(route.url());url.protocol=url.protocol==='wss:'?'https:':'http:';if(allowed.has(url.origin))route.connectToServer();else route.close()});
 // This is the current TokenStorage producer's server scope, not a global account override.
 const target=new URL(happierOrigin),profileId=(target.hostname+(target.port?'-'+target.port:'')).toLowerCase().replace(/[^a-z0-9._-]/g,'_').replace(/_+/g,'_');
 const normalized=new URL(happierOrigin);normalized.hostname='localhost';
 const urlScope=createHash('sha256').update(normalized.href.replace(/\/$/,'')).digest('base64url');
 await page.addInitScript(({token,secret,profileId,urlScope})=>{
  const value=JSON.stringify({token,secret});
  localStorage.setItem('auth_credentials__srv_'+profileId,value);
  localStorage.setItem('auth_credentials__srv_'+urlScope,value);
 },{token,secret:secret32base64,profileId,urlScope});
 let popup;
 try{
  await page.goto(origin+'/session/'+encodeURIComponent(sessionId),{waitUntil:'domcontentloaded',timeout:60000});
  const trigger=page.getByTestId('session-header-action-menu-trigger');
  await trigger.waitFor({state:'visible',timeout:120000});await trigger.click();
  const action=page.getByTestId('agent-control-configuration-menu-action');await action.waitFor({state:'visible',timeout:10000});
  await page.screenshot({path:join(directory,'canonical-menu.png'),fullPage:true});
  const opened=browserContext.waitForEvent('page',{timeout:15000});await action.click();popup=await opened;
  await popup.waitForURL(url=>url.origin===panelOrigin&&url.searchParams.get('acSession')===sessionId,{timeout:30000});
  await popup.waitForLoadState('domcontentloaded');
  const selected=popup.getByLabel('Conversa',{exact:true});await selected.waitFor({state:'visible',timeout:30000});
  await popup.waitForFunction(expected=>{const element=document.querySelector('select[aria-label="Conversa"]');return element?.value===expected&&element.disabled},contextId,{timeout:30000});
  await writeFile(join(directory,'caller-proof.json'),JSON.stringify({canonicalMenu:true,origin,sessionPinned:true,contextPinned:true,contextId,externalNetworkBlocked:true,pageErrors:errors},null,2));
  return {popup,evidenceDirectory:directory};
 }catch(error){
  await page.screenshot({path:join(directory,'canonical-menu-failure.png'),fullPage:true}).catch(()=>{});
  await writeFile(join(directory,'caller-failure.json'),JSON.stringify({error:error.message,pageErrors:errors,url:page.url(),title:await page.title().catch(()=>''),body:(await page.locator('body').innerText().catch(()=>'' )).slice(0,4000)},null,2));
  await popup?.close().catch(()=>{});throw error;
 }finally{
  await page.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));
 }
}
