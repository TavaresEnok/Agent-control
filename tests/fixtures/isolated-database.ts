import {randomUUID} from 'node:crypto';
import pg from 'pg';

/** Global-account tests must not inherit other test files' still-live managers.
 * Create/drop only a randomly named database owned by this fixture. */
export async function isolatedDatabase(base:string,label:string,beforeCreate?:(url:string)=>Promise<void>){
 const url=new URL(base);
 if(url.pathname!=='/ac_implementation_test'||!['db','127.0.0.1','localhost'].includes(url.hostname)||!/^\w{1,16}$/.test(label))
  throw Error('ISOLATED_DATABASE_REQUIRED');
 const name=`ac_implementation_test_${label}_${randomUUID().replaceAll('-','').slice(0,20)}`;
 url.pathname='/'+name;
 await beforeCreate?.(url.href);
 const admin=new pg.Client({connectionString:base});await admin.connect();
 try{await admin.query(`CREATE DATABASE "${name}"`);}finally{await admin.end();}
 return {url:url.href,async close(){
  const client=new pg.Client({connectionString:base});await client.connect();
  try{await client.query(`DROP DATABASE "${name}"`);}finally{await client.end();}
 }};
}
