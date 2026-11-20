import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';

const text=readFileSync(join(import.meta.dirname,'..','deploy','compose.personal.yml'),'utf8');

/** Minimal reader for this file's shape: two-space service blocks under `services:` and top-level `networks:` entries. */
function section(name:string){
 const start=text.split('\n').findIndex(line=>line===`${name}:`);
 assert.ok(start>=0,name);
 const rows:string[]=[];
 for(const line of text.split('\n').slice(start+1)){if(line&&!line.startsWith(' ')&&!line.startsWith('#'))break;rows.push(line);}
 return rows;
}
function blocks(rows:string[]){
 const out=new Map<string,string[]>();
 let current:string[]|undefined;
 for(const row of rows){
  const head=/^  ([A-Za-z0-9_-]+):\s*(.*)$/.exec(row);
  if(head){current=[];out.set(head[1]!,current);if(head[2])current.push('  '+head[2]);continue;}
  current?.push(row);
 }
 return out;
}
const services=blocks(section('services'));
const declared=blocks(section('networks'));
/** Networks of a service. A service with no `networks` key is only on the project's default network. */
function networksOf(name:string){
 const body=services.get(name)!.join('\n');
 const flow=/^    networks:\s*\[([^\]]*)\]/m.exec(body);
 if(flow)return flow[1]!.split(',').map(item=>item.trim()).filter(Boolean);
 const map=/^    networks:\s*$/m.exec(body);
 if(!map)return ['default'];
 const names:string[]=[];
 for(const row of body.slice(map.index+map[0].length).split('\n').slice(1)){
  const item=/^      ([A-Za-z0-9_-]+):/.exec(row);
  if(item)names.push(item[1]!);else if(row.trim()&&!row.startsWith('      '))break;
 }
 return names;
}

test('the personal compose has no known default database password and requires an explicit credential',()=>{
 const db=services.get('db')!.join('\n');
 const password=/POSTGRES_PASSWORD:\s*(.+)/.exec(db)?.[1]??'';
 assert.doesNotMatch(password,/:-/,'a ${VAR:-default} fallback is a known password');
 assert.match(password,/\$\{AC_PERSONAL_DB_PASSWORD:\?[^}]+\}/,'the variable must be required, with no fallback');
 assert.doesNotMatch(text,/personal-local-only/);
 for(const row of text.split('\n').filter(line=>/^\s*[A-Z_]*(PASSWORD|SECRET|TOKEN)[A-Z_]*:/.test(line)))assert.match(row.replace(/^\s*[A-Z_]+:\s*/,''),/^\$\{[A-Z_]+:\?/,'credential must come from a required variable: '+row);
 assert.equal(/ports:/.test(db),false,'the database publishes no host port');
});

test('the Docker broker cannot reach the database, and nothing but the gateway shares a network with it',()=>{
 const broker=networksOf('broker'),db=networksOf('db'),gateway=networksOf('gateway');
 assert.deepEqual(broker.filter(name=>db.includes(name)),[],'broker and database share no network');
 assert.ok(broker.length&&!broker.includes('default'),'the broker is on a dedicated network, not the default one');
 assert.ok(db.length&&!db.includes('default'),'the database is on a dedicated network, not the default one');
 for(const name of [...broker,...db])assert.match(declared.get(name)?.join('\n')??'',/internal:\s*true/,`${name} is an internal network`);
 // The gateway is the only service that needs both sides.
 assert.ok(gateway.some(name=>broker.includes(name))&&gateway.some(name=>db.includes(name)));
 for(const [name] of services)if(!['gateway'].includes(name)){
  const nets=networksOf(name);
  assert.equal(nets.some(net=>broker.includes(net))&&nets.some(net=>db.includes(net)),false,`${name} must not bridge the broker and the database`);
 }
 assert.equal(/ports:/.test(services.get('broker')!.join('\n')),false,'the broker publishes no host port');
});

test('the broker limitation is documented in the file itself',()=>{
 const broker=services.get('broker')!.join('\n');
 assert.match(broker,/não filtra operações/i);
 assert.match(broker,/no-new-privileges/);
});
