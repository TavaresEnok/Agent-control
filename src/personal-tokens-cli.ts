import {readFile,readdir,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {readCodex,readClaude,readAntigravity,type UsageRow,type Window} from './external-usage.ts';

async function files(root:string):Promise<string[]>{
 try{const entries=await readdir(root,{withFileTypes:true});const result:string[]=[];for(const e of entries){const p=join(root,e.name);if(e.isDirectory())result.push(...await files(p));else if(e.isFile()&&e.name.endsWith('.jsonl'))result.push(p);}return result;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
}
async function main(){
 const args=process.argv.slice(2),path=args.shift();if(!path)throw Error('Uso: personal:tokens <instalação.json> [--desde ISO] [--ate ISO] [--codex DIR] [--claude DIR]');
 const opts:Record<string,string[]>={};while(args.length){const k=args.shift()!,v=args.shift();if(!['--desde','--ate','--codex','--claude'].includes(k)||!v)throw Error('Opção inválida');(opts[k]??=[]).push(v);}
 const w:Window={from:opts['--desde']?.[0],to:opts['--ate']?.[0]};for(const t of [w.from,w.to])if(t&&!Number.isFinite(Date.parse(t)))throw Error('Data inválida');if(w.from&&w.to&&Date.parse(w.from)>=Date.parse(w.to))throw Error('Intervalo inválido');
 const config=JSON.parse(await readFile(resolve(path),'utf8'));if(typeof config.databaseUrl!=='string')throw Error('Instalação sem databaseUrl');
 const codex=opts['--codex']??[join(homedir(),'.codex','sessions')];
 const claude=opts['--claude']??['/home/app/.claude-trabalhadores',config.accountHomesDirectory??join(config.dataDirectory,'accounts')];
 const seen=new Set<string>(),rows:(UsageRow & {source:string})[]=[];
 for(const [roots,parser] of [[codex,readCodex],[claude,readClaude]] as const)for(const root of roots)for(const f of await files(root)){const canonical=await realpath(f);if(seen.has(canonical))continue;seen.add(canonical);rows.push(...parser(await readFile(f,'utf8'),w).map(r=>({...r,source:'externo'})));}
 rows.push(...readAntigravity().map(r=>({...r,source:'externo'})));
 const pool=new pg.Pool({connectionString:config.databaseUrl,max:1,connectionTimeoutMillis:5000});
 try{const result=await pool.query(`SELECT a.provider,p.model,p.effort,g.role,g.created_at, u.counters, b.counters baseline
 FROM ac_capacity_grants g JOIN ac_profiles p ON p.id=g.profile_id JOIN ac_accounts a ON a.id=g.account_id
 LEFT JOIN LATERAL (SELECT counters FROM ac_usage_observations WHERE grant_id=g.id AND ($2::timestamptz IS NULL OR observed_at<$2) ORDER BY seq DESC LIMIT 1) u ON true
 LEFT JOIN LATERAL (SELECT counters FROM ac_usage_observations WHERE grant_id=g.id AND observed_at<$1::timestamptz ORDER BY seq DESC LIMIT 1) b ON true
 WHERE g.resource_kind='model' AND ($2::timestamptz IS NULL OR g.created_at<$2) AND ($1::timestamptz IS NULL OR g.created_at >= $1 OR EXISTS (SELECT 1 FROM ac_usage_observations o WHERE o.grant_id=g.id AND o.observed_at >= $1 AND ($2::timestamptz IS NULL OR o.observed_at<$2)))`,[w.from??null,w.to??null]);
 for(const r of result.rows){const value=(k:string):number|null=>{const n=r.counters?.[k];if(typeof n!=='number')return null;if(!w.from||new Date(r.created_at).getTime()>=Date.parse(w.from))return n;const b=r.baseline?.[k];return typeof b==='number'&&n>=b?n-b:null;};rows.push({source:'nativo',provider:r.provider??'desconhecido',model:r.model??'desconhecido',effort:r.effort??'desconhecido',role:r.role??'desconhecido',input:value('input'),cache:value('cache'),output:value('output'),calls:1});}
 }finally{await pool.end();}
 const grouped=new Map<string,UsageRow & {source:string}>();for(const row of rows){const key=JSON.stringify([row.source,row.provider,row.model,row.effort,row.role]);const prev=grouped.get(key);if(!prev){grouped.set(key,{...row});continue;}for(const k of ['input','cache','output','calls'] as const)prev[k]=prev[k]===null||row[k]===null?null:prev[k]!+row[k]!;}
 console.log('As fontes nativa e externa podem conter os mesmos jobs; não some as duas.');
 console.log('fonte\tprovedor\tmodelo\tesforço\tpapel\tentrada\tcache\tsaída\tchamadas');for(const r of grouped.values())console.log([r.source,r.provider,r.model,r.effort,r.role,r.input,r.cache,r.output,r.calls].map(v=>v??'não medido').join('\t'));
}
main().catch((e:unknown)=>{console.error(e instanceof Error?e.message:'Falha ao ler uso');process.exitCode=1;});
