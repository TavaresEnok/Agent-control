import {test} from 'node:test';
import assert from 'node:assert/strict';
import {networkInterfaces} from 'node:os';
import {createConnection,createServer,type Socket} from 'node:net';
import {isPrivateToolAddress,startToolForwarder} from '../src/native-tool-forwarder.ts';

test('the local tool bridge forwards bytes only to the fixed private peer',async()=>{
 const addresses=Object.values(networkInterfaces()).flatMap(v=>v??[]).filter(a=>!a.internal&&a.family==='IPv4'&&isPrivateToolAddress(a.address));
 if(!addresses.length)throw Error('ISOLATED_PRIVATE_NETWORK_REQUIRED');
 const live=new Set<Socket>();const target=createServer(socket=>{live.add(socket);socket.on('close',()=>live.delete(socket));socket.on('error',()=>{});socket.pipe(socket);});
 await new Promise<void>((resolve,reject)=>{target.once('error',reject);target.listen(19493,'0.0.0.0',resolve);});
 let bridge:Awaited<ReturnType<typeof startToolForwarder>>|undefined,client:Socket|undefined;
 try{
  bridge=await startToolForwarder(addresses[0].address);
  const response=await new Promise<Buffer>((resolve,reject)=>{
   client=createConnection({host:'127.0.0.1',port:19492});client.setTimeout(3000,()=>reject(Error('BRIDGE_TIMEOUT')));client.once('error',reject);
   client.once('connect',()=>client!.write(Buffer.from('synthetic payload')));client.once('data',resolve);
  });
  assert.equal(response.toString(),'synthetic payload');
 }finally{
  client?.destroy();bridge?.close();for(const socket of live)socket.destroy();await new Promise<void>(resolve=>target.close(()=>resolve()));
 }
});
