import { createHash,createPublicKey,timingSafeEqual,verify } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { canonical, Id, Refusal } from './contracts.ts';
import { Ledger } from './ledger.ts';
export const OperatorProof=z.object({deviceId:Id,expiresAt:z.number().int().positive(),signature:z.string().regex(/^[a-f0-9]{128}$/)}).strict();
export type OperatorProof=z.infer<typeof OperatorProof>;
export function operatorMessage(principal:string,command:Record<string,unknown>,proof:Pick<OperatorProof,'deviceId'|'expiresAt'>,installationId:string){
 const {deliveryAttemptId,...semantic}=command;
 return canonical({domain:'agent-control-human-command-v1',installationId,principal,deviceId:proof.deviceId,expiresAt:proof.expiresAt,command:semantic});
}
/** Registered operator signing keys are different from manager session keys and provider credentials. */
function operatorKey(value:string){
 const encoded=z.string().min(40).max(200).regex(/^[A-Za-z0-9+/]+=*$/).parse(value);
 const key=createPublicKey({key:Buffer.from(encoded,'base64'),format:'der',type:'spki'});
 if(key.asymmetricKeyType!=='ed25519')throw new Refusal('OPERATOR_KEY_TYPE_UNSUPPORTED');
 return encoded;
}
const bootstrapDigest=(token:string)=>createHash('sha256').update('agent-control-bootstrap-v1\0').update(token).digest('hex');
export class Operators{
 constructor(readonly ledger:Ledger){}
 async enroll(admin:string,principal:string,deviceId:string,publicKey:string){
  Id.parse(deviceId);
  z.string().min(1).max(200).parse(principal);
  const encoded=operatorKey(publicKey);
  await this.ledger.tx(async c=>{
   if(!(await c.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1',[admin])).rowCount)throw new Refusal('CONTROL_ADMIN_REQUIRED',403);
   const prior=(await c.query('SELECT principal_id,public_key,state FROM ac_operator_keys WHERE id=$1',[deviceId])).rows[0];
   if(prior){if(prior.principal_id!==principal||prior.public_key!==encoded||prior.state!=='active')throw new Refusal('OPERATOR_DEVICE_CONFLICT');return;}
   await c.query("INSERT INTO ac_operator_keys(id,principal_id,public_key,state,enrolled_by) VALUES($1,$2,$3,'active',$4)",[deviceId,principal,encoded,admin]);
  });
 }
 async prepareBootstrap(admin:string,principal:string,token:string){
  z.string().min(1).max(200).parse(principal);z.string().regex(/^[a-f0-9]{64}$/).parse(token);
  await this.ledger.tx(async c=>{
   if(!(await c.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1',[admin])).rowCount)throw new Refusal('CONTROL_ADMIN_REQUIRED',403);
   await c.query(`INSERT INTO ac_operator_bootstrap(principal_id,token_digest,expires_at,created_by)
    VALUES($1,$2,clock_timestamp()+interval '10 minutes',$3) ON CONFLICT(principal_id) DO UPDATE
    SET token_digest=excluded.token_digest,expires_at=excluded.expires_at,failed_attempts=0,used=false,created_by=excluded.created_by`,
    [principal,bootstrapDigest(token),admin]);
  });
 }
 async bootstrap(principal:string,raw:{deviceId:string;publicKey:string;token:string}){
  const input=z.object({deviceId:Id,publicKey:z.string().min(40).max(200),token:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(raw);
  const encoded=operatorKey(input.publicKey);
  const outcome=await this.ledger.tx(async c=>{
   const item=(await c.query('SELECT *,expires_at>clock_timestamp() valid FROM ac_operator_bootstrap WHERE principal_id=$1 FOR UPDATE',[principal])).rows[0];
   if(!item||item.used||!item.valid||item.failed_attempts>=5)return false;
   const expected=Buffer.from(item.token_digest,'hex'),actual=Buffer.from(bootstrapDigest(input.token),'hex');
   if(expected.length!==actual.length||!timingSafeEqual(expected,actual)){
    await c.query('UPDATE ac_operator_bootstrap SET failed_attempts=failed_attempts+1 WHERE principal_id=$1',[principal]);return false;
   }
   const existing=(await c.query('SELECT principal_id,public_key,state FROM ac_operator_keys WHERE id=$1',[input.deviceId])).rows[0];
   if(existing&&(existing.principal_id!==principal||existing.public_key!==encoded||existing.state!=='active'))throw new Refusal('OPERATOR_DEVICE_CONFLICT');
   const inserted=await c.query("INSERT INTO ac_operator_keys(id,principal_id,public_key,state,enrolled_by) VALUES($1,$2,$3,'active',$4) ON CONFLICT(id) DO NOTHING RETURNING id",
    [input.deviceId,principal,encoded,item.created_by]);
   if(!inserted.rowCount){
    const bound=(await c.query('SELECT principal_id,public_key,state FROM ac_operator_keys WHERE id=$1',[input.deviceId])).rows[0];
    if(!bound||bound.principal_id!==principal||bound.public_key!==encoded||bound.state!=='active')throw new Refusal('OPERATOR_DEVICE_CONFLICT');
   }
   await c.query('UPDATE ac_operator_bootstrap SET used=true WHERE principal_id=$1',[principal]);
   return true;
  });
  if(!outcome)throw new Refusal('OPERATOR_BOOTSTRAP_REFUSED',403);
 }
 async enrollFromDevice(c:pg.PoolClient,principal:string,deviceId:string,publicKey:string){
  Id.parse(deviceId);const encoded=operatorKey(publicKey);
  const prior=(await c.query('SELECT principal_id,public_key,state FROM ac_operator_keys WHERE id=$1',[deviceId])).rows[0];
  if(prior){if(prior.principal_id!==principal||prior.public_key!==encoded||prior.state!=='active')throw new Refusal('OPERATOR_DEVICE_CONFLICT');return;}
  await c.query("INSERT INTO ac_operator_keys(id,principal_id,public_key,state,enrolled_by) VALUES($1,$2,$3,'active',$2)",[deviceId,principal,encoded]);
 }
 async revokeFromDevice(c:pg.PoolClient,principal:string,deviceId:string){
  const changed=await c.query("UPDATE ac_operator_keys SET state='revoked' WHERE id=$1 AND principal_id=$2 AND state='active'",[Id.parse(deviceId),principal]);
  if(!changed.rowCount)throw new Refusal('OPERATOR_DEVICE_FORBIDDEN',403);
 }
 async revoke(principal:string,deviceId:string){
  await this.ledger.tx(async c=>{
   const device=(await c.query('SELECT * FROM ac_operator_keys WHERE id=$1 FOR UPDATE',[Id.parse(deviceId)])).rows[0];
   if(!device)throw new Refusal('OPERATOR_DEVICE_FORBIDDEN',403);
   if(device.principal_id!==principal&&!(await c.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1',[principal])).rowCount)
    throw new Refusal('OPERATOR_DEVICE_FORBIDDEN',403);
   await c.query("UPDATE ac_operator_keys SET state='revoked' WHERE id=$1",[deviceId]);
  });
 }
 async verify(c:pg.PoolClient,principal:string,command:Record<string,unknown>,raw:unknown){
  const proof=OperatorProof.parse(raw);
  const now=Number((await c.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint now')).rows[0].now);
  if(proof.expiresAt<now||proof.expiresAt>now+300000)throw new Refusal('OPERATOR_PROOF_EXPIRED',403);
  const row=(await c.query("SELECT public_key FROM ac_operator_keys WHERE id=$1 AND principal_id=$2 AND state='active' FOR SHARE",[proof.deviceId,principal])).rows[0];
  if(!row)throw new Refusal('OPERATOR_DEVICE_NOT_ENROLLED',403);
  const key=createPublicKey({key:Buffer.from(row.public_key,'base64'),format:'der',type:'spki'});
  const installation=(await c.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0];
  if(!installation)throw new Refusal('INSTALLATION_IDENTITY_MISSING');
  if(!verify(null,Buffer.from(operatorMessage(principal,command,proof,installation.id)),key,Buffer.from(proof.signature,'hex')))
   throw new Refusal('OPERATOR_SIGNATURE_INVALID',403);
 }
}
