import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {chmod, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {privateDirectory} from './installation.ts';

const {generateVAPIDKeys, sendNotification, WebPushError}=createRequire(import.meta.url)('web-push') as typeof import('web-push');

/** Generic contact for the push service. Never the installation owner's email. */
export const personalPushSubject='mailto:agent-control@localhost';
const personalPushTitle='Nova mensagem no Agent Control';

/** Whether a personal-mode manager message should wake the phone. Pure: the same text and flag always decide the same way. */
export function personalPushBody(text:string,ownerQuestionReply:boolean):string|null{
 const trimmed=text.trim();
 const notify=trimmed.startsWith('Proposta de plano')||text.includes('execução concluída')||text.includes('falhou')||trimmed.startsWith('Atenção')||ownerQuestionReply;
 if(!notify)return null;
 return '';
}
const subscriptionLimit=20;
const sentLimit=400;
const chains=new Map<string,Promise<unknown>>();
const keyFileSchema=z.object({publicKey:z.string().min(1).max(300),privateKey:z.string().min(1).max(300)}).strict();
const subscriptionSchema=z.object({
 id:z.uuid(),endpoint:z.string().url().max(2000),
 keys:z.object({p256dh:z.string().regex(/^[A-Za-z0-9_-]{16,200}$/),auth:z.string().regex(/^[A-Za-z0-9_-]{10,200}$/)}).strict(),
 createdAt:z.string().min(1).max(40),label:z.string().max(80),
}).strict();
const subscriptionFileSchema=z.object({subscriptions:z.array(subscriptionSchema).max(subscriptionLimit)}).strict();
const sentFileSchema=z.object({ids:z.array(z.string().min(1).max(500)).max(sentLimit)}).strict();
export type PersonalPushSubscription=z.infer<typeof subscriptionSchema>;
export type PersonalPushNotice={messageId:string;title:string;body:string;url:string};
export type PersonalPushSender=(subscription:{endpoint:string;keys:{p256dh:string;auth:string}},payload:string,vapid:{subject:string;publicKey:string;privateKey:string})=>Promise<void>;

const defaultSender:PersonalPushSender=(subscription,payload,vapid)=>sendNotification(subscription,payload,{vapidDetails:vapid,TTL:12*60*60,urgency:'high'}).then(()=>undefined);

function exclusive<T>(directory:string,fn:()=>Promise<T>):Promise<T>{
 const previous=chains.get(directory)??Promise.resolve();
 const run=previous.then(fn,fn);
 chains.set(directory,run.then(()=>undefined,()=>undefined));
 return run;
}
async function writePrivate(path:string,content:string){
 const temporary=`${path}.${randomUUID()}.tmp`;
 await writeFile(temporary,content,{mode:0o600,flag:'wx'});
 await chmod(temporary,0o600);
 await rename(temporary,path);
 await chmod(path,0o600);
}
async function pushDirectory(dataDirectory:string){
 const root=resolve(dataDirectory);
 if(root!==dataDirectory)throw new Refusal('NON_CANONICAL_PRIVATE_DIRECTORY');
 const directory=join(root,'push');
 await mkdir(directory,{recursive:true,mode:0o700});
 await chmod(directory,0o700);
 await privateDirectory(directory);
 return directory;
}
async function readJson(path:string){
 try{return JSON.parse(await readFile(path,'utf8')) as unknown;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}
async function loadKeys(directory:string){
 const path=join(directory,'vapid.json');
 const existing=await readJson(path);
 if(existing!==undefined)return keyFileSchema.parse(existing);
 const generated=generateVAPIDKeys();
 await writePrivate(path,JSON.stringify({publicKey:generated.publicKey,privateKey:generated.privateKey})+'\n');
 return generated;
}
async function loadSubscriptions(directory:string){
 const value=await readJson(join(directory,'subscriptions.json'));
 if(value===undefined)return [] as PersonalPushSubscription[];
 return subscriptionFileSchema.parse(value).subscriptions;
}
async function saveSubscriptions(directory:string,subscriptions:PersonalPushSubscription[]){
 await writePrivate(join(directory,'subscriptions.json'),JSON.stringify({subscriptions})+'\n');
}
async function loadSent(directory:string){
 const value=await readJson(join(directory,'sent.json'));
 if(value===undefined)return [] as string[];
 return sentFileSchema.parse(value).ids;
}
function cleanLabel(label:string){return label.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,80);}
const pushHosts=new Set(['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com']);
function httpsEndpoint(value:string){
 let url:URL;
 try{url=new URL(value);}catch{return false;}
 if(url.protocol!=='https:'||url.username!==''||url.password!==''||url.port!=='')return false;
 const host=url.hostname;
 if(pushHosts.has(host))return true;
 return host.endsWith('.notify.windows.com')&&!host.endsWith('..notify.windows.com')&&host.split('.').length>3;
}
function statusCode(error:unknown){
 if(error instanceof WebPushError)return error.statusCode;
 if(typeof error==='object'&&error!==null&&'statusCode' in error&&typeof error.statusCode==='number')return error.statusCode;
 return undefined;
}
function sentKey(notice:PersonalPushNotice){return notice.url+'\n'+notice.messageId;}

export async function listPersonalPush(dataDirectory:string){
 const directory=await pushDirectory(dataDirectory);
 return exclusive(directory,async()=>{
  const keys=await loadKeys(directory);
  const subscriptions=await loadSubscriptions(directory);
  return {publicKey:keys.publicKey,subscriptions:subscriptions.map(item=>({id:item.id,label:item.label,createdAt:item.createdAt}))};
 });
}
export async function subscribePersonalPush(dataDirectory:string,input:{endpoint:string;keys:{p256dh:string;auth:string}},label=''){
 if(!httpsEndpoint(input.endpoint))throw new Refusal('INVALID_CONTRACT',400);
 const directory=await pushDirectory(dataDirectory);
 return exclusive(directory,async()=>{
  await loadKeys(directory);
  const subscriptions=await loadSubscriptions(directory);
  const current=subscriptionSchema.omit({id:true,createdAt:true,label:true}).parse(input);
  const labelText=cleanLabel(label);
  const existing=subscriptions.find(item=>item.endpoint===current.endpoint);
  if(existing){
   existing.keys=current.keys;existing.label=labelText;
   await saveSubscriptions(directory,subscriptions);
   return {id:existing.id};
  }
  if(subscriptions.length>=subscriptionLimit)throw new Refusal('SUBSCRIPTION_LIMIT',409);
  const created:PersonalPushSubscription={id:randomUUID(),endpoint:current.endpoint,keys:current.keys,createdAt:new Date().toISOString(),label:labelText};
  subscriptions.push(subscriptionSchema.parse(created));
  await saveSubscriptions(directory,subscriptions);
  return {id:created.id};
 });
}
export async function unsubscribePersonalPush(dataDirectory:string,id:string){
 const directory=await pushDirectory(dataDirectory);
 return exclusive(directory,async()=>{
  const subscriptions=await loadSubscriptions(directory);
  const next=subscriptions.filter(item=>item.id!==id);
  if(next.length===subscriptions.length)return false;
  await saveSubscriptions(directory,next);
  return true;
 });
}
export async function deliverPersonalPush(dataDirectory:string,notice:PersonalPushNotice,sender:PersonalPushSender=defaultSender){
 const directory=await pushDirectory(dataDirectory);
 const prepared=await exclusive(directory,async()=>{
  const keys=await loadKeys(directory);
  const subscriptions=(await loadSubscriptions(directory)).filter(item=>httpsEndpoint(item.endpoint));
  const ids=await loadSent(directory);
  const key=sentKey(notice);
  if(ids.includes(key)||subscriptions.length===0)return null;
  await writePrivate(join(directory,'sent.json'),JSON.stringify({ids:[...ids,key].slice(-sentLimit)})+'\n');
  return {keys,subscriptions};
 });
 if(!prepared)return;
 const payload=JSON.stringify({title:personalPushTitle,body:'',url:notice.url});
 for(const subscription of prepared.subscriptions){
  try{await sender({endpoint:subscription.endpoint,keys:subscription.keys},payload,{subject:personalPushSubject,publicKey:prepared.keys.publicKey,privateKey:prepared.keys.privateKey});}
  catch(error){
   const status=statusCode(error);
   if(status===404||status===410)await unsubscribePersonalPush(dataDirectory,subscription.id);
   else console.error(JSON.stringify({event:'PERSONAL_PUSH_FAILED',status:status??null}));
  }
 }
}
export async function sendPersonalPushTest(dataDirectory:string,sender?:PersonalPushSender){
 await deliverPersonalPush(dataDirectory,{messageId:'test-'+randomUUID(),title:'Agent Control',body:'Teste do Agent Control',url:'/'},sender);
}
