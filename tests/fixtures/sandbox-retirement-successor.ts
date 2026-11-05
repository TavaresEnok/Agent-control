import {readFile} from 'node:fs/promises';
import {SandboxBroker} from '../../src/sandbox-broker.ts';
const file=process.argv[2];
if(process.env.AC_R2_SANDBOX_PHYSICAL!=='1'||!file?.startsWith('/tmp/ac-r2-sandbox-')||process.getuid?.()!==0)throw Error('ISOLATED_ROOT_FIXTURE_REQUIRED');
const {config,value,spec,work}=JSON.parse(await readFile(file,'utf8'));
if(!config.hostRoot.startsWith('/tmp/ac-r2-sandbox-')||!process.env.AC_TEST_DATABASE_URL?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_ROOT_FIXTURE_REQUIRED');
config.databaseUrl=process.env.AC_TEST_DATABASE_URL;
const broker=new SandboxBroker(config,Buffer.alloc(32,51));
try{const result=await (broker as any).retireManagedWriter(value,spec,work);process.stdout.write(JSON.stringify(result));}
finally{await broker.close();}
