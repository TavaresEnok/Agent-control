import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UNSAFE_SEMANTIC_TEXT} from '../src/config-export.ts';

// Assembled at runtime so that no token-shaped literal is stored in the repository.
const tail='A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

for(const prefix of ['ghp_','gho_','ghu_','ghs_','ghr_','github_pat_','sk-','xoxb-'])
  test(`refuses ${prefix} credentials in portable text`,()=>assert.match('see '+prefix+tail,UNSAFE_SEMANTIC_TEXT));

test('keeps ordinary portable text',()=>{
  for(const text of ['Regular review policy','task-runner','ask-owner before merge','graph_pattern'])assert.doesNotMatch(text,UNSAFE_SEMANTIC_TEXT);
});
