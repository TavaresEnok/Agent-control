import {readFile,readdir,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {readCodex,readClaude,readAntigravity,type UsageRow,type Window} from './external-usage.ts';
import {ProjectEconomy} from './installation.ts';

async function files(root:string):Promise<string[]>{
 try{const entries=await readdir(root,{withFileTypes:true});const result:string[]=[];for(const e of entries){const p=join(root,e.name);if(e.isDirectory())result.push(...await files(p));else if(e.isFile()&&e.name.endsWith('.jsonl'))result.push(p);}return result;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
}

/** One printed line group. `measurement` is informado (a total or counters were reported), estimado (size-based) or desconhecido. */
export type Row=UsageRow & {source:string;total?:number|null;outcome?:string;measurement?:string;
 /** Chamadas do grupo sem número em cada contador. A soma mostra o que foi medido; estas ficam contadas à parte. */
 missing?:{input?:number;cache?:number;output?:number}};
const big=(v:unknown):number|null=>v===null||v===undefined?null:Number(v);
const measurementOf=(r:UsageRow):string=>r.state??(r.input===null&&r.cache===null&&r.output===null?'desconhecido':'informado');

/**
 * Panel manager attempts. A table that cannot be read is NOT an empty list: the problem comes back so the report can say
 * the manager part is missing. Old rows (before migration 120) have no outcome column value other than its default.
 */
export async function readManagerRows(pool:{query:(sql:string,params:unknown[])=>Promise<{rows:Record<string,unknown>[]}>},w:Window):Promise<{rows:Row[];problem:string|null}>{
 try{
  const result=await pool.query(`SELECT provider,model,effort,role,input_tokens,output_tokens,total_tokens,estimated,outcome,measurement,collection_error FROM ac_manager_chat_usage
   WHERE ($1::timestamptz IS NULL OR observed_at>=$1) AND ($2::timestamptz IS NULL OR observed_at<$2)`,[w.from??null,w.to??null]);
  return {problem:null,rows:result.rows.map(r=>({source:r.measurement==='estimado'?'estimado':r.measurement==='informado'?'nativo':'desconhecido',provider:String(r.provider),model:String(r.model),effort:String(r.effort),role:String(r.role),
   input:big(r.input_tokens),cache:null,output:big(r.output_tokens),calls:1,total:big(r.total_tokens),outcome:String(r.outcome),measurement:String(r.measurement)+(r.collection_error?' (erro de coleta)':'')}))};
 }catch(e){return {rows:[],problem:'tabela ac_manager_chat_usage ilegível ('+((e as {code?:unknown}).code??((e as Error).name||'erro'))+'): chamadas do gerente do painel NÃO estão nesta contagem'};}
}

/**
 * Same key means same line. A call without a number no longer erases the measured ones: the sum keeps what was
 * reported and `missing` counts the calls without a number. A group where nothing was measured stays unknown.
 * Outcome and measurement stay apart, so an estimate never joins a reported total.
 */
export function groupRows(rows:readonly Row[]):Row[]{
 const grouped=new Map<string,Row>();
 const miss=(row:Row,k:'input'|'cache'|'output',n:number)=>{if(n>0)(row.missing??={})[k]=(row.missing[k]??0)+n;};
 const calls=(r:Row)=>r.calls??1;
 for(const row of rows){const key=JSON.stringify([row.source,row.provider,row.model,row.effort,row.role,row.outcome??'',row.measurement??'',row.state??'']);const prev=grouped.get(key);
  if(!prev){const first:Row={...row,missing:{...row.missing}};for(const k of ['input','cache','output'] as const)if(row[k]===null)miss(first,k,calls(row));grouped.set(key,first);continue;}
  for(const k of ['input','cache','output'] as const){
   if(row[k]===null){miss(prev,k,calls(row));continue;}
   prev[k]=prev[k]===null?row[k]:prev[k]!+row[k]!;
   const m=row.missing?.[k];if(m)miss(prev,k,m);
  }
  prev.calls=prev.calls===null||row.calls===null?null:prev.calls!+row.calls!;prev.total=prev.total==null||row.total==null?null:prev.total+row.total;
  for(const k of ['cacheRead','cacheWrite'] as const)if(prev[k]!==undefined||row[k]!==undefined)prev[k]=prev[k]==null||row[k]==null?null:prev[k]!+row[k]!;}
 return [...grouped.values()];
}

/** Module 1 reads at most this many files per call whatever batchFiles says (SLICE_SIZE in verify-slices.ts; a test keeps both equal). */
export const SECURITY_FILE_LIMIT=15;
const SECURITY_READ_FACTOR=4;
const DESIGN_TOKEN_CEILING=20000;
/** What each module will actually do with the project's batching settings. Module 1 ignores batchFiles; modules 2-10 use it, and fewer than 2 means no batching. */
export function effectiveBatchLines(economyInput:unknown,label:string):string[]{
 let e;try{e=ProjectEconomy.parse(economyInput??{});}catch{return ['projeto '+label+': configuração de economia inválida; lotes não puderam ser determinados'];}
 const lines=['projeto '+label+': lotes '+(e.batch?'ligados':'desligados')+', batchTokens='+e.batchTokens+', batchFiles='+e.batchFiles];
 if(!e.batch)return [...lines,'  módulos 1 a 10: 1 arquivo por chamada'];
 const per=(files:number,tokens:number)=>files<2?'1 arquivo por chamada (lote exige batchFiles >= 2)':'até '+files+' arquivos e '+tokens+' tokens por chamada';
 return [...lines,
  '  módulo 1 (segurança): até '+SECURITY_FILE_LIMIT+' arquivos por chamada (limite histórico fixo; batchFiles='+e.batchFiles+' não se aplica) e orçamento de leitura de '+e.batchTokens*SECURITY_READ_FACTOR+' tokens (batchTokens x '+SECURITY_READ_FACTOR+')',
  '  módulos 2 a 9: '+per(e.batchFiles,e.batchTokens),
  '  módulo 10 (design): '+per(e.batchFiles,Math.min(e.batchTokens,DESIGN_TOKEN_CEILING))+(e.batchTokens>DESIGN_TOKEN_CEILING?' (teto do design: '+DESIGN_TOKEN_CEILING+')':'')];
}

/** Cache read, cache write and the share of input served from the cache. Claude reports input without the cache;
 * Codex counts cached tokens inside input and has no cache write. Null where the source does not say. */
export function cacheColumns(r:Row):{read:number|null;write:number|null;hit:string|null}{
 if(r.provider==='codex'){const read=r.cache,input=r.input;return {read,write:null,hit:read!==null&&input?Math.round(read/input*100)+'%':null};}
 const read=r.cacheRead??null,write=r.cacheWrite??null,input=r.input;
 const all=read!==null&&write!==null&&input!==null?read+write+input:null;
 return {read,write,hit:all?Math.round(read!/all*100)+'%':null};
}

/** The printed report. `problems` non-empty means partial coverage, stated before any number. */
export function renderReport(rows:readonly Row[],problems:readonly string[],batchLines:readonly string[]):string[]{
 const out:string[]=[];
 if(problems.length){out.push('COBERTURA PARCIAL: '+problems.length+' fonte(s) não puderam ser lidas; os números abaixo estão incompletos.');for(const p of problems)out.push('  - '+p);}
 else out.push('Cobertura: todas as fontes foram lidas.');
 out.push('As fontes nativa e externa podem conter os mesmos jobs; não some as duas. Estimado e informado também não se somam; "desconhecido" é chamada sem número, não consumo zero.');
 out.push('fonte\tprovedor\tmodelo\tesforço\tpapel\tentrada\tcache\tsaída\tchamadas\ttotal informado\tdesfecho\tmedição\tcache lido\tcache gravado\tacerto do cache');
 const counted=(r:Row,k:'input'|'cache'|'output'):string=>{const v=r[k],m=r.missing?.[k];if(v===null)return 'não medido';return m?`${v} (+${m} sem número)`:String(v);};
 for(const r of rows){const c=cacheColumns(r);out.push([r.source,r.provider,r.model,r.effort,r.role,counted(r,'input'),counted(r,'cache'),counted(r,'output'),r.calls,r.total,r.outcome??'-',r.measurement??measurementOf(r),c.read,c.write,c.hit].map(v=>v??'não medido').join('\t'));}
 out.push('Configuração efetiva de lotes por módulo:',...batchLines);
 return out;
}
async function main(){
 const args=process.argv.slice(2),path=args.shift();if(!path)throw Error('Uso: personal:tokens <instalação.json> [--desde ISO] [--ate ISO] [--codex DIR] [--claude DIR]');
 const opts:Record<string,string[]>={};while(args.length){const k=args.shift()!,v=args.shift();if(!['--desde','--ate','--codex','--claude'].includes(k)||!v)throw Error('Opção inválida');(opts[k]??=[]).push(v);}
 const w:Window={from:opts['--desde']?.[0],to:opts['--ate']?.[0]};for(const t of [w.from,w.to])if(t&&!Number.isFinite(Date.parse(t)))throw Error('Data inválida');if(w.from&&w.to&&Date.parse(w.from)>=Date.parse(w.to))throw Error('Intervalo inválido');
 const config=JSON.parse(await readFile(resolve(path),'utf8'));if(typeof config.databaseUrl!=='string')throw Error('Instalação sem databaseUrl');
 const codex=opts['--codex']??[join(homedir(),'.codex','sessions')];
 const claude=opts['--claude']??['/home/app/.claude-trabalhadores',config.accountHomesDirectory??join(config.dataDirectory,'accounts')];
 const seen=new Set<string>(),rows:Row[]=[],problems:string[]=[];
 for(const [roots,parser] of [[codex,readCodex],[claude,readClaude]] as const)for(const root of roots)for(const f of await files(root)){const canonical=await realpath(f);if(seen.has(canonical))continue;seen.add(canonical);
  try{rows.push(...parser(await readFile(f,'utf8'),w).map(r=>({...r,source:'externo'})));}catch(e){problems.push('arquivo de sessão ilegível ('+((e as {code?:unknown}).code??'erro')+'): '+f);}}
 rows.push(...readAntigravity().map(r=>({...r,source:'externo'})));
 const pool=new pg.Pool({connectionString:config.databaseUrl,max:1,connectionTimeoutMillis:5000});
 try{const result=await pool.query(`SELECT a.provider,p.model,p.effort,g.role,g.created_at, u.counters, b.counters baseline
 FROM ac_capacity_grants g JOIN ac_profiles p ON p.id=g.profile_id JOIN ac_accounts a ON a.id=g.account_id
 LEFT JOIN LATERAL (SELECT counters FROM ac_usage_observations WHERE grant_id=g.id AND ($2::timestamptz IS NULL OR observed_at<$2) ORDER BY seq DESC LIMIT 1) u ON true
 LEFT JOIN LATERAL (SELECT counters FROM ac_usage_observations WHERE grant_id=g.id AND observed_at<$1::timestamptz ORDER BY seq DESC LIMIT 1) b ON true
 WHERE g.resource_kind='model' AND ($2::timestamptz IS NULL OR g.created_at<$2) AND ($1::timestamptz IS NULL OR g.created_at >= $1 OR EXISTS (SELECT 1 FROM ac_usage_observations o WHERE o.grant_id=g.id AND o.observed_at >= $1 AND ($2::timestamptz IS NULL OR o.observed_at<$2)))`,[w.from??null,w.to??null]);
 for(const r of result.rows){const value=(k:string):number|null=>{const n=r.counters?.[k];if(typeof n!=='number')return null;if(!w.from||new Date(r.created_at).getTime()>=Date.parse(w.from))return n;const b=r.baseline?.[k];return typeof b==='number'&&n>=b?n-b:null;};rows.push({source:'nativo',provider:r.provider??'desconhecido',model:r.model??'desconhecido',effort:r.effort??'desconhecido',role:r.role??'desconhecido',input:value('input'),cache:value('cache'),output:value('output'),calls:1,...(r.counters&&'cacheRead' in r.counters?{cacheRead:value('cacheRead'),cacheWrite:value('cacheWrite')}:{})});}
 // Panel manager calls: reported totals are native; size-based estimates are kept apart and marked; an unreadable table is reported, not hidden.
 const manager=await readManagerRows(pool as unknown as Parameters<typeof readManagerRows>[0],w);rows.push(...manager.rows);if(manager.problem)problems.push(manager.problem);
 }finally{await pool.end();}
 const projects:{label?:unknown;economy?:unknown}[]=[config.project,...(Array.isArray(config.projects)?config.projects:[])].filter(p=>p&&typeof p==='object');
 const lines=projects.flatMap(p=>effectiveBatchLines(p.economy,String(p.label??'sem nome')));
 for(const line of renderReport(groupRows(rows),problems,lines))console.log(line);
 if(problems.length){console.error('Cobertura parcial: '+problems.length+' problema(s) de coleta.');process.exitCode=3;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch((e:unknown)=>{console.error(e instanceof Error?e.message:'Falha ao ler uso');process.exitCode=1;});
