import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Refusal} from '../src/contracts.ts';
import {deliverPersonalPush, listPersonalPush, personalPushSubject, sendPersonalPushTest, subscribePersonalPush, unsubscribePersonalPush, type PersonalPushSender} from '../src/personal-push.ts';

const endpoint=(n:number)=>`https://fcm.googleapis.com/device-${n}`;
const keys={p256dh:'A'.repeat(40),auth:'B'.repeat(24)};

async function directory(){
 const created=await mkdtemp(join(tmpdir(),'ac-push-'));
 return realpath(created);
}

test('vapid keys are created once inside a private directory and the subject is generic',async()=>{
 const root=await directory();
 try{
  const first=await listPersonalPush(root);
  const second=await listPersonalPush(root);
  assert.equal(second.publicKey,first.publicKey);
  assert.equal(personalPushSubject,'mailto:agent-control@localhost');
  assert.equal(personalPushSubject.includes('owner'),false);
  const folder=await stat(join(root,'push'));
  const file=await stat(join(root,'push','vapid.json'));
  assert.equal(folder.mode&0o777,0o700);
  assert.equal(file.mode&0o777,0o600);
  const stored=JSON.parse(await readFile(join(root,'push','vapid.json'),'utf8')) as {publicKey:string;privateKey:string};
  assert.equal(stored.publicKey,first.publicKey);
  assert.equal(JSON.stringify(second).includes(stored.privateKey),false);
  assert.deepEqual(second.subscriptions,[]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a device subscribes once, a gone subscription is removed, and the private key stays out of the send log',async()=>{
 const root=await directory();
 const sent:string[]=[];
 const sender:PersonalPushSender=async(subscription,payload,vapid)=>{
  sent.push(payload);
  assert.equal(vapid.subject,personalPushSubject);
  assert.equal(payload.includes(vapid.privateKey),false);
  if(subscription.endpoint.endsWith('device-1')){const error=new Error('gone');(error as {statusCode?:number}).statusCode=410;throw error;}
 };
 try{
  const first=await subscribePersonalPush(root,{endpoint:endpoint(1),keys},'celular');
  const again=await subscribePersonalPush(root,{endpoint:endpoint(1),keys:{...keys,auth:'C'.repeat(24)}},'celular novo');
  assert.equal(again.id,first.id);
  await subscribePersonalPush(root,{endpoint:endpoint(2),keys},'outro');
  const listed=await listPersonalPush(root);
  assert.equal(listed.subscriptions.length,2);
  assert.equal(JSON.stringify(listed).includes(endpoint(1)),false);
  assert.equal(listed.subscriptions[0]?.label,'celular novo');
  await deliverPersonalPush(root,{messageId:'m1',title:'Projeto',body:'linha',url:'/p/11111111-1111-4111-8111-111111111111/conversa'},sender);
  await deliverPersonalPush(root,{messageId:'m1',title:'Projeto',body:'linha',url:'/p/11111111-1111-4111-8111-111111111111/conversa'},sender);
  assert.equal(sent.length,2);
  const after=await listPersonalPush(root);
  assert.deepEqual(after.subscriptions.map(item=>item.id),[listed.subscriptions[1]?.id]);
  assert.equal(await unsubscribePersonalPush(root,after.subscriptions[0]!.id),true);
  assert.equal(await unsubscribePersonalPush(root,after.subscriptions[0]!.id),false);
  const gone=new Error('missing');(gone as {statusCode?:number}).statusCode=404;
  await subscribePersonalPush(root,{endpoint:endpoint(3),keys});
  await deliverPersonalPush(root,{messageId:'m2',title:'Projeto',body:'linha',url:'/p/x/conversa'},async()=>{throw gone;});
  assert.deepEqual((await listPersonalPush(root)).subscriptions,[]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('the installation keeps at most twenty subscriptions and the test notice uses the fixed text',async()=>{
 const root=await directory();
 const bodies:string[]=[];
 try{
  for(const allowed of ['https://updates.push.services.mozilla.com/wpush/v2/1','https://web.push.apple.com/Q','https://wns.notify.windows.com/w/?token=1']){
   const saved=await subscribePersonalPush(root,{endpoint:allowed,keys});
   assert.equal(await unsubscribePersonalPush(root,saved.id),true);
  }
  for(let index=0;index<20;index++)await subscribePersonalPush(root,{endpoint:endpoint(index),keys},`a${index}`);
  await assert.rejects(subscribePersonalPush(root,{endpoint:endpoint(20),keys}),(error:unknown)=>error instanceof Refusal&&error.code==='SUBSCRIPTION_LIMIT');
  await sendPersonalPushTest(root,async(_subscription,payload)=>{bodies.push(payload);});
  assert.equal(bodies.length,20);
  assert.equal(JSON.parse(bodies[0]!).body,'Teste do Agent Control');
  for(const blocked of ['http://fcm.googleapis.com/no','https://push.example.test/device','https://fcm.googleapis.com:8443/wp','https://user:pass@fcm.googleapis.com/wp','https://fcm.googleapis.com.evil.example/wp','https://notify.windows.com/w','https://wns.notify.windows.com.evil.example/w']){
   await assert.rejects(subscribePersonalPush(root,{endpoint:blocked,keys}),(error:unknown)=>error instanceof Refusal&&error.code==='INVALID_CONTRACT');
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
