import {z} from 'zod';
import {resolve} from 'node:path';
import {digest,Refusal} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import {ProviderCollectors,type ProviderAdapter} from './providers.ts';
import {CodexReadonlyQuotaSource,type CodexReadonlyBinding} from './codex-readonly-quota-source.ts';
import {createCodexReadonlyQuotaProbe} from './provider-collector-adapter.ts';
import {CodexQuotaDockerSupervisor} from './codex-quota-supervisor.ts';
const Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({accountId:z.uuid(),subjectDigest:Hash,home:z.string().refine(p=>resolve(p)===p),device:z.string().regex(/^\d+$/),inode:z.string().regex(/^\d+$/),uid:z.string().regex(/^\d+$/)}).strict();
export const CodexQuotaRegistryConfig=z.discriminatedUnion('state',[
 z.object({state:z.literal('disabled')}).strict(),
 z.object({state:z.literal('configured-inactive'),bindings:z.array(Binding).min(1).max(32)}).strict(),
 z.object({state:z.literal('lab-synthetic'),contract:z.literal('ac-r3-quota-disposable-v1'),bindings:z.array(Binding).min(1).max(32),image:z.string().regex(/^sha256:[a-f0-9]{64}$/),timeoutMs:z.number().int().min(100).max(20000).default(4000)}).strict(),
]);
export type CodexQuotaRegistryConfig=z.input<typeof CodexQuotaRegistryConfig>;
/** Explicit registration of an inactive real path, or a networkless fixture executor.
 * Configuration never changes account eligibility, enabled state or SQL 042. */
export async function configureCodexQuotaRegistry(ledger:Ledger,raw:CodexQuotaRegistryConfig){
 const config=CodexQuotaRegistryConfig.parse(raw),adapters:ProviderAdapter[]=[];
 const supervisors:{accountId:string;supervisor:CodexQuotaDockerSupervisor}[]=[];
 if(config.state!=='disabled'){
  if(new Set(config.bindings.map(b=>b.accountId)).size!==config.bindings.length)throw new Refusal('QUOTA_BINDING_DUPLICATE');
  await ledger.tx(async c=>{
   for(const binding of config.bindings){
    const account=(await c.query('SELECT * FROM ac_accounts WHERE id=$1 FOR UPDATE',[binding.accountId])).rows[0];
    if(!account||account.provider!=='codex'||account.resource_identity!=='codex:'+binding.subjectDigest)throw new Refusal('QUOTA_IDENTITY_UNBOUND');
    if(config.state==='lab-synthetic'&&(account.mode!=='synthetic'||account.eligibility!=='documented_supported'))throw new Refusal('QUOTA_REAL_ACTIVATION_BLOCKED');
    await c.query(`INSERT INTO ac_readonly_quota_registrations(account_id,subject_digest,configuration_digest,state) VALUES($1,$2,$3,$4)
     ON CONFLICT(account_id) DO UPDATE SET subject_digest=$2,configuration_digest=$3,state=$4,updated_at=clock_timestamp()`,[binding.accountId,binding.subjectDigest,digest(config),config.state]);
   }
  });
  if(config.state==='lab-synthetic'){const probes=new Map<string,ProviderAdapter['probe']>();for(const binding of config.bindings){
   const supervisor=new CodexQuotaDockerSupervisor(ledger,binding,config.image);supervisors.push({accountId:binding.accountId,supervisor});
   const source=new CodexReadonlyQuotaSource('/usr/bin/node',binding as CodexReadonlyBinding,config.timeoutMs,supervisor);
   probes.set(binding.accountId,createCodexReadonlyQuotaProbe(source));
  }
  adapters.push({manifest:{id:'codex-readonly-lab',version:'r3-'+digest(config).slice(0,32),provider:'codex',mode:'synthetic',eligibility:'documented_supported',source:'synthetic://codex-readonly/lab',timeoutMs:config.timeoutMs+6000},
   probe:async input=>{const probe=probes.get(input.accountId);return probe?probe(input):{status:'unknown',ttlSeconds:30,remainingPercent:null,resetAt:null};}});
  }
 }
 return {configurationDigest:digest(config),report:{state:config.state,realActivation:'blocked' as const,inferenceEnabled:false as const,registered:config.state==='disabled'?0:config.bindings.length},adapters,collectors:new ProviderCollectors(ledger,adapters),
  reconcile:async(accountId?:string)=>{let stopped=0;for(const entry of supervisors)if(!accountId||accountId===entry.accountId)stopped+=await entry.supervisor.reconcilePending();return stopped;}};
}
