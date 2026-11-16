import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {nativeReviewRequest} from '../src/native-verification.ts';
import type {ArtifactRow} from '../src/quality.ts';

test('a task reviewer is told to judge only its own files; the combined result is held to the whole request',()=>{
 const artifact={id:randomUUID(),policy_revision:1,commit_id:'a'.repeat(40),tree_id:'b'.repeat(40),base_id:'c'.repeat(40)} as unknown as ArtifactRow;
 const stage={id:randomUUID(),session_id:randomUUID()},intent=randomUUID(),grant=randomUUID(),asked='crie a.md e b.md';
 const text=(scope?:'task'|'composition')=>JSON.parse(nativeReviewRequest(stage,intent,grant,artifact,'review',asked,scope).task).instruction as string;
 assert.match(text('task'),/never reject because another task of the plan is absent/);
 assert.match(text('composition'),/reject when a part of ownerRequest is missing/);
 // Without a scope the request keeps its earlier wording, so a job started before this change still replays to the same digest.
 assert.doesNotMatch(text(),/task of the plan|combines every task/);
 assert.equal(nativeReviewRequest(stage,intent,grant,artifact,'review',asked).task,nativeReviewRequest(stage,intent,grant,artifact,'review',asked,undefined).task);
});
