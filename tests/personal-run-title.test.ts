import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ACTIVE_VIEW_MAX_AGE_MS,archivedInView,planTaskDisplayTitle} from '../src/personal-run-title.ts';

const tasks=[{id:'append-readme-line',title:'Acrescentar uma linha no README',writePaths:['README.md']},{id:'check-json',writePaths:['package.json']}];

test('a child run shows the plan task title, or the task summary when the plan has no title',()=>{
 assert.equal(planTaskDisplayTitle('task-append-readme-line',tasks),'Acrescentar uma linha no README');
 assert.equal(planTaskDisplayTitle('AC_MANAGED_UNIT:task-append-readme-line',tasks),'Acrescentar uma linha no README');
 assert.equal(planTaskDisplayTitle('task-check-json',tasks),'check-json: package.json');
 assert.equal(planTaskDisplayTitle('Intent 00000000-0000-4000-8000-000000000001',tasks),undefined);
 assert.equal(planTaskDisplayTitle('task-missing',tasks),undefined);
});

test('a finished run older than seven days leaves the active view',()=>{
 const now=Date.parse('2026-11-13T00:00:00.000Z');
 const fresh=archivedInView({status:'done',finishedAt:new Date(now-ACTIVE_VIEW_MAX_AGE_MS).toISOString()},now);
 assert.equal(fresh.archived,undefined);
 const old=archivedInView({status:'done',finishedAt:new Date(now-ACTIVE_VIEW_MAX_AGE_MS-1).toISOString()},now);
 assert.equal(old.archived,true);
 assert.equal(archivedInView({status:'failed',finishedAt:'2020-01-01T00:00:00.000Z',archived:false},now).archived,false);
 assert.equal(archivedInView({status:'running',finishedAt:'2020-01-01T00:00:00.000Z'},now).archived,undefined);
});
