import {z} from 'zod';
import {digest} from './contracts.ts';
export const NativeQaContract=z.object({schemaVersion:z.literal(1),id:z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/),
 image:z.string().regex(/^sha256:[a-f0-9]{64}$/),argv:z.array(z.string().max(4096).refine(v=>!v.includes('\0'))).min(1).max(64),
 environment:z.array(z.string().max(4096).regex(/^[A-Z_][A-Z0-9_]*=[^\x00\r\n]*$/)).max(32),
 timeoutMs:z.number().int().min(1000).max(1800000),memoryBytes:z.number().int().min(67108864).max(4294967296),pids:z.number().int().min(16).max(256),nanoCpus:z.number().int().min(100000000).max(4000000000)}).strict().refine(v=>v.argv[0]!.startsWith('/'),'ABSOLUTE_TEST_EXECUTABLE_REQUIRED').superRefine((v,c)=>{
 const allowed=new Set(['PATH','HOME','TMPDIR','CI','NODE_VERSION','YARN_VERSION','LANG','LC_ALL','NODE_ENV','NO_COLOR']);
 const names=v.environment.map(value=>value.slice(0,value.indexOf('=')));
 if(names.some(name=>!allowed.has(name))||new Set(names).size!==names.length)c.addIssue({code:'custom',message:'QA_ENVIRONMENT_NOT_ALLOWED'});
});
export type NativeQaContract=z.infer<typeof NativeQaContract>;
export const nativeQaContractDigest=(value:NativeQaContract)=>digest({contract:'native-qa-v1',definition:NativeQaContract.parse(value)});
