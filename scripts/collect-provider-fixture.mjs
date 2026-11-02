// Explicit laboratory collector only. No process spawn, login or network adapter.
import {readFile,lstat} from 'node:fs/promises';
import {z} from 'zod';
import {Ledger} from '../src/ledger.ts';
import {ProviderCollectors} from '../src/providers.ts';
const url=process.env.AC_TEST_DATABASE_URL;
if(!url||!['db','127.0.0.1','localhost'].includes(new URL(url).hostname)||new URL(url).pathname!=='/ac_implementation_test')throw Error('ISOLATED_DATABASE_REQUIRED');
const path=process.argv[2];if(!path)throw Error('FIXTURE_CONFIGURATION_REQUIRED');
const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||info.size>8192)throw Error('PRIVATE_FIXTURE_REQUIRED');
const config=z.object({scope:z.literal('isolated-provider-collector'),principal:z.string().min(1),projectId:z.uuid(),accountId:z.uuid(),observationId:z.uuid(),
 adapter:z.object({id:z.string(),version:z.string(),provider:z.string(),mode:z.literal('synthetic'),eligibility:z.literal('documented_supported'),source:z.string(),timeoutMs:z.number()}),
 result:z.object({status:z.enum(['available','exhausted','rate_limited','auth_required','unknown','unreachable','disabled','configuration_error']),ttlSeconds:z.number(),remainingPercent:z.number().nullable(),resetAt:z.string().nullable()})}).strict().parse(JSON.parse(await readFile(path,'utf8')));
const ledger=new Ledger(url);
try{const collector=new ProviderCollectors(ledger,[{manifest:config.adapter,probe:async()=>config.result}]);
 const result=await collector.collect(config.principal,config.projectId,config.accountId,config.observationId);
 process.stdout.write(JSON.stringify({observationId:config.observationId,duplicate:result.duplicate,status:result.snapshot.status,expiresAt:result.expiresAt})+'\n');
}finally{await ledger.close();}
