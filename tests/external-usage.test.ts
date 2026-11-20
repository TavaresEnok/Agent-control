import {test} from 'node:test';
import {deepStrictEqual,strictEqual} from 'node:assert';
import {readCodex,readClaude,readAntigravity} from '../src/external-usage.ts';
const jsonl=(items:unknown[])=>items.map(x=>JSON.stringify(x)).join('\n');
const event=(timestamp:string,input:number)=>({timestamp,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:input/2,output_tokens:input/4}}}});
test('Codex last cumulative reading and period difference',()=>{
 const data=jsonl([{type:'turn_context',payload:{model:'gpt-test',effort:'high'}},event('2026-01-01T00:00:00Z',40),event('2026-01-02T00:00:00Z',80),event('2026-01-03T00:00:00Z',120)]);
 deepStrictEqual(readCodex(data)[0],{provider:'codex',model:'gpt-test',effort:'high',role:'desconhecido',input:120,cache:60,output:30,calls:null});
 // The 40 before the window is the base: 120 - 40, not 120 - 80 (the first reading inside the window).
 strictEqual(readCodex(data,{from:'2026-01-02T00:00:00Z'})[0]?.input,80);
});
test('Claude sums unique assistant messages, excludes synthetic and preserves unknown counters',()=>{
 const msg=(id:string,model:string,input:number)=>({type:'assistant',timestamp:'2026-01-02T00:00:00Z',message:{id,model,usage:{input_tokens:input,output_tokens:5,cache_read_input_tokens:2,cache_creation_input_tokens:3}}});
 const result=readClaude(jsonl([msg('a','claude-test',10),msg('a','claude-test',12),msg('b','claude-test',4),msg('x','<synthetic>',100)]));
 deepStrictEqual(result[0],{provider:'claude',model:'claude-test',effort:'desconhecido',role:'desconhecido',input:16,cache:10,output:10,calls:2});
 strictEqual(readClaude(jsonl([msg('a','claude-test',10)]),{to:'2026-01-01T00:00:00Z'}).length,0);
});
test('Antigravity has no fabricated numbers',()=>{strictEqual(readAntigravity()[0]?.input,null);strictEqual(readAntigravity()[0]?.calls,null);});

const meta=(timestamp:string)=>({timestamp,type:'session_meta',payload:{id:'s',timestamp}});
test('Codex window keeps the last counter before its start as the base',()=>{
 const data=jsonl([event('2026-01-01T00:00:00Z',100),event('2026-01-05T00:00:00Z',250)]);
 const row=readCodex(data,{from:'2026-01-03T00:00:00Z'})[0]!;
 strictEqual(row.input,150);strictEqual(row.cache,75);strictEqual(row.state,undefined);
});
test('Codex window with only an end date is the cumulative total up to it',()=>{
 const data=jsonl([event('2026-01-01T00:00:00Z',40),event('2026-01-02T00:00:00Z',80),event('2026-01-03T00:00:00Z',120)]);
 const row=readCodex(data,{to:'2026-01-03T00:00:00Z'})[0]!;
 strictEqual(row.input,80);strictEqual(row.state,undefined);
 strictEqual(readCodex(data,{to:'2025-12-31T00:00:00Z'}).length,0);
});
test('Codex window with unknown base says insufficient instead of a difference or zero',()=>{
 const data=jsonl([event('2026-01-05T00:00:00Z',250),event('2026-01-06T00:00:00Z',300)]);
 const row=readCodex(data,{from:'2026-01-03T00:00:00Z'})[0]!;
 deepStrictEqual([row.input,row.cache,row.output,row.state],[null,null,null,'medição insuficiente']);
});
test('Codex window uses a zero base only when the session start is proven',()=>{
 const proven=jsonl([meta('2026-01-04T00:00:00Z'),event('2026-01-05T00:00:00Z',250),event('2026-01-06T00:00:00Z',300)]);
 const row=readCodex(proven,{from:'2026-01-03T00:00:00Z'})[0]!;
 strictEqual(row.input,300);strictEqual(row.state,undefined);
 // A session that started before the window with no earlier reading is a complete file head: zero is also proven.
 strictEqual(readCodex(jsonl([meta('2026-01-01T00:00:00Z'),event('2026-01-05T00:00:00Z',250)]),{from:'2026-01-03T00:00:00Z'})[0]?.input,250);
 // A session_meta after the first reading proves nothing.
 strictEqual(readCodex(jsonl([event('2026-01-05T00:00:00Z',250),meta('2026-01-06T00:00:00Z')]),{from:'2026-01-03T00:00:00Z'})[0]?.state,'medição insuficiente');
});
test('Codex counter restart inside the window counts the new value in full',()=>{
 const data=jsonl([event('2026-01-01T00:00:00Z',100),event('2026-01-04T00:00:00Z',300),event('2026-01-05T00:00:00Z',50),event('2026-01-06T00:00:00Z',120)]);
 // base 100; 300 (+200); restart to 50 (+50); 120 (+70)
 strictEqual(readCodex(data,{from:'2026-01-02T00:00:00Z'})[0]?.input,320);
 strictEqual(readCodex(data,{from:'2026-01-02T00:00:00Z',to:'2026-01-05T12:00:00Z'})[0]?.input,250);
});
test('Codex window without readings inside it has no row',()=>{
 strictEqual(readCodex(jsonl([event('2026-01-01T00:00:00Z',100)]),{from:'2026-01-03T00:00:00Z'}).length,0);
});
