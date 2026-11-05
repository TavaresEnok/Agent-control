import {readFile} from 'node:fs/promises';
import {Ledger} from '../../src/ledger.ts';
import {NativeProtocolCompatibility,type NativeProtocolSpec} from '../../src/native-protocol-compatibility.ts';
const input=JSON.parse(await readFile(process.argv[2],'utf8')) as {url:string;principal:string;spec:NativeProtocolSpec};
const db=new Ledger(input.url);try{await new NativeProtocolCompatibility(db).verify(input.principal,input.spec);}finally{await db.close();}
