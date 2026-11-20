import {test} from 'node:test';
import {deepStrictEqual,strictEqual} from 'node:assert';
import {readCodex,readClaude,readAntigravity} from '../src/external-usage.ts';
const jsonl=(items:unknown[])=>items.map(x=>JSON.stringify(x)).join('\n');
const event=(timestamp:string,input:number)=>({timestamp,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:input/2,output_tokens:input/4}}}});
test('Codex last cumulative reading and period difference',()=>{
 const data=jsonl([{type:'turn_context',payload:{model:'gpt-test',effort:'high'}},event('2026-01-01T00:00:00Z',40),event('2026-01-02T00:00:00Z',80),event('2026-01-03T00:00:00Z',120)]);
 deepStrictEqual(readCodex(data)[0],{provider:'codex',model:'gpt-test',effort:'high',role:'desconhecido',input:120,cache:60,output:30,calls:null});
 strictEqual(readCodex(data,{from:'2026-01-02T00:00:00Z'})[0]?.input,40);
});
test('Claude sums unique assistant messages, excludes synthetic and preserves unknown counters',()=>{
 const msg=(id:string,model:string,input:number)=>({type:'assistant',timestamp:'2026-01-02T00:00:00Z',message:{id,model,usage:{input_tokens:input,output_tokens:5,cache_read_input_tokens:2,cache_creation_input_tokens:3}}});
 const result=readClaude(jsonl([msg('a','claude-test',10),msg('a','claude-test',12),msg('b','claude-test',4),msg('x','<synthetic>',100)]));
 deepStrictEqual(result[0],{provider:'claude',model:'claude-test',effort:'desconhecido',role:'desconhecido',input:16,cache:10,output:10,calls:2});
 strictEqual(readClaude(jsonl([msg('a','claude-test',10)]),{to:'2026-01-01T00:00:00Z'}).length,0);
});
test('Antigravity has no fabricated numbers',()=>{strictEqual(readAntigravity()[0]?.input,null);strictEqual(readAntigravity()[0]?.calls,null);});
