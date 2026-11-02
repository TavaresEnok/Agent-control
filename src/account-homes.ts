import {constants} from 'node:fs';
import {lstat,mkdir,open,realpath} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {isAbsolute,join,resolve,sep} from 'node:path';
import {Id,Refusal} from './contracts.ts';
import {Ledger} from './ledger.ts';
import type pg from 'pg';

type Identity={device:string;inode:string;uid:string};
export type AccountHomeMetadata={accountId:string;projectId:string;ownerId:string;uid:string;device:string;inode:string};
const flags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
const inside=(path:string,parent:string)=>path===parent||path.startsWith(parent+sep);
function identity(stat:{dev:number|bigint;ino:number|bigint;uid:number|bigint}):Identity{
 return {device:String(stat.dev),inode:String(stat.ino),uid:String(stat.uid)};
}
function same(a:Identity,b:Identity){return a.device===b.device&&a.inode===b.inode&&a.uid===b.uid;}

/** Private, controller-owned directories only. No CLI, mount, credentials,
 * content listing or network operation is performed by this class. */
export class AccountHomes{
 private readonly root:string;
 private readonly repositories:readonly string[];
 constructor(readonly ledger:Ledger,rootPrivateDirectory:string,protectedRepositories:readonly string[]){
  if(!isAbsolute(rootPrivateDirectory)||protectedRepositories.some(path=>!isAbsolute(path)))throw new Refusal('ACCOUNT_HOME_PATH_INVALID');
  this.root=resolve(rootPrivateDirectory);this.repositories=protectedRepositories.map(path=>resolve(path));
 }
 private async owner(c:pg.PoolClient,principal:string,projectId:string,accountId:string){
  const account=(await c.query(`SELECT a.id,a.owner_id,a.mode,a.enabled FROM ac_accounts a
   JOIN ac_account_access x ON x.account_id=a.id JOIN ac_memberships m ON m.project_id=x.project_id
   WHERE a.id=$1 AND x.project_id=$2 AND a.owner_id=$3 AND m.principal_id=$3 AND m.role='owner' FOR UPDATE OF a FOR SHARE OF x,m`,
   [accountId,projectId,principal])).rows[0];
  if(!account)throw new Refusal('ACCOUNT_FORBIDDEN',403);
  if(account.mode!=='synthetic'){
   if(account.enabled||(await c.query('SELECT 1 FROM ac_profiles WHERE account_id=$1 AND enabled LIMIT 1',[accountId])).rowCount)
    throw new Refusal('PROVIDER_RUNTIME_NOT_ACTIVATED');
  }
  return account;
 }
 private async rootHandle(){
  const uid=process.geteuid?.();if(uid===undefined)throw new Refusal('ACCOUNT_HOME_PLATFORM_UNSUPPORTED');
  for(const path of this.repositories){
   const repo=await realpath(path);
   if(inside(this.root,repo)||inside(repo,this.root))throw new Refusal('ACCOUNT_HOME_REPOSITORY_OVERLAP');
  }
  const info=await lstat(this.root,{bigint:true});
  if(info.isSymbolicLink()||!info.isDirectory()||(info.mode&0o7777n)!==0o700n||info.uid!==BigInt(uid)||await realpath(this.root)!==this.root)
   throw new Refusal('ACCOUNT_HOME_ROOT_UNSAFE');
  const handle=await open(this.root,flags);
  try{
   const opened=await handle.stat({bigint:true});
   if(!opened.isDirectory()||(opened.mode&0o7777n)!==0o700n||opened.uid!==BigInt(uid)||!same(identity(info),identity(opened)))throw new Refusal('ACCOUNT_HOME_ROOT_UNSAFE');
   return {handle,info:identity(opened),uid:String(uid)};
  }catch(error){await handle.close();throw error;}
 }
 private async homeInfo(root:FileHandle,rootIdentity:Identity,accountId:string,uid:string){
  const expected=join(this.root,accountId),anchored=join('/proc/self/fd',String(root.fd),accountId);
  const info=await lstat(anchored,{bigint:true});
  if(info.isSymbolicLink()||!info.isDirectory()||(info.mode&0o7777n)!==0o700n||String(info.uid)!==uid||
     String(info.dev)!==rootIdentity.device||String(info.ino)===rootIdentity.inode||await realpath(expected)!==expected)
   throw new Refusal('ACCOUNT_HOME_IDENTITY_MISMATCH');
  const home=await open(anchored,flags);
  try{
   const opened=await home.stat({bigint:true});
   if(!opened.isDirectory()||(opened.mode&0o7777n)!==0o700n||String(opened.uid)!==uid||!same(identity(info),identity(opened)))throw new Refusal('ACCOUNT_HOME_IDENTITY_MISMATCH');
   const current=await lstat(this.root,{bigint:true});
   if(current.isSymbolicLink()||!current.isDirectory()||(current.mode&0o7777n)!==0o700n||!same(identity(current),rootIdentity)||await realpath(this.root)!==this.root)
    throw new Refusal('ACCOUNT_HOME_ROOT_UNSAFE');
   return identity(opened);
  }finally{await home.close();}
 }
 private result(accountId:string,projectId:string,principal:string,home:Identity):AccountHomeMetadata{
  return {accountId,projectId,ownerId:principal,uid:home.uid,device:home.device,inode:home.inode};
 }
 private checkStored(row:pg.QueryResultRow,principal:string,projectId:string,root:Identity,home:Identity){
  if(row.project_id!==projectId||row.owner_id!==principal||row.root_path!==this.root||row.root_device!==root.device||row.root_inode!==root.inode||
    row.home_device!==home.device||row.home_inode!==home.inode||row.owner_uid!==home.uid)throw new Refusal('ACCOUNT_HOME_IDENTITY_MISMATCH');
 }
 async initialize(principal:string,projectId:string,accountId:string):Promise<AccountHomeMetadata>{
  Id.parse(projectId);Id.parse(accountId);
  return this.ledger.tx(async c=>{
   await this.owner(c,principal,projectId,accountId);
   const root=await this.rootHandle();
   try{
    const saved=(await c.query('SELECT * FROM ac_account_homes WHERE account_id=$1',[accountId])).rows[0];
    if(saved){const home=await this.homeInfo(root.handle,root.info,accountId,root.uid);this.checkStored(saved,principal,projectId,root.info,home);
     return this.result(accountId,projectId,principal,home);}
    const anchored=join('/proc/self/fd',String(root.handle.fd),accountId);
    try{await mkdir(anchored,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Refusal('ACCOUNT_HOME_UNREGISTERED');throw error;}
    const home=await this.homeInfo(root.handle,root.info,accountId,root.uid);
    await c.query(`INSERT INTO ac_account_homes(account_id,project_id,owner_id,root_path,root_device,root_inode,home_device,home_inode,owner_uid)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[accountId,projectId,principal,this.root,root.info.device,root.info.inode,home.device,home.inode,home.uid]);
    return this.result(accountId,projectId,principal,home);
   }finally{await root.handle.close();}
  });
 }
 async inspect(principal:string,projectId:string,accountId:string):Promise<AccountHomeMetadata>{
  Id.parse(projectId);Id.parse(accountId);
  return this.ledger.tx(async c=>{
   await this.owner(c,principal,projectId,accountId);
   const saved=(await c.query('SELECT * FROM ac_account_homes WHERE account_id=$1',[accountId])).rows[0];
   if(!saved)throw new Refusal('ACCOUNT_HOME_NOT_INITIALIZED');
   const root=await this.rootHandle();
   try{const home=await this.homeInfo(root.handle,root.info,accountId,root.uid);this.checkStored(saved,principal,projectId,root.info,home);
    return this.result(accountId,projectId,principal,home);
   }finally{await root.handle.close();}
  });
 }
 async loadMetadata(principal:string,projectId:string,accountId:string){return this.inspect(principal,projectId,accountId);}
}
