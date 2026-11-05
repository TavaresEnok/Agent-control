import {readFile} from 'node:fs/promises';
import {verify} from 'node:crypto';
const canonical=value=>JSON.stringify(order(value));
function order(value){if(Array.isArray(value))return value.map(order);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,order(value[key])]));return value;}
export async function verifiedLaunch(kind){
 const signed=JSON.parse(await readFile('/input/launch.json','utf8'));
 const key=await readFile('/runner/'+(kind==='planning'?'planning':'execution')+'-public-key.pem','utf8');
 if(!verify(null,Buffer.from('agent-control:native-'+kind+'-launch:v1\n'+canonical(signed.payload)),key,Buffer.from(signed.signature,'hex'))||signed.payload.expiresAt<Date.now())throw Error('FIXTURE_SIGNED_LAUNCH_INVALID');
 return signed.payload;
}
