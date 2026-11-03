import {createServer,createConnection,isIP,type Socket} from 'node:net';
/** A job-local, bounded bridge. Its destination comes only from the signed
 * launch; it never accepts a host or port from a model or shell request. */
export function isPrivateToolAddress(address:string){
 if(isIP(address)!==4)return false;
 const parts=address.split('.').map(Number);
 return parts[0]===10||(parts[0]===172&&parts[1]>=16&&parts[1]<=31)||(parts[0]===192&&parts[1]===168);
}
export async function startToolForwarder(address:string){
 if(!isPrivateToolAddress(address))throw Error('INVALID_TOOL_ADDRESS');
 const sockets=new Set<Socket>();let active=0;
 const server=createServer(client=>{
  if(active>=8){client.destroy();return;}active++;sockets.add(client);
  const peer=createConnection({host:address,port:19493});sockets.add(peer);
  let closed=false;const close=()=>{if(closed)return;closed=true;active--;sockets.delete(client);sockets.delete(peer);client.destroy();peer.destroy();};
  client.once('error',close);peer.once('error',close);client.once('close',close);peer.once('close',close);
  peer.setTimeout(5000,close);peer.once('connect',()=>{peer.setTimeout(0);client.pipe(peer);peer.pipe(client);});
 });
 server.maxConnections=8;
 server.on('error',()=>{for(const socket of sockets)socket.destroy();});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(19492,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
 return {close(){for(const socket of sockets)socket.destroy();server.close();}};
}
