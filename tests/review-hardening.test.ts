import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelDisabledByPolicy} from '../src/model-policy.ts';
import {UNSAFE_SEMANTIC_TEXT} from '../src/config-export.ts';

test('forbidden model aliases are refused with provider, tag and version decorations',()=>{
 for(const model of ['astra','gpt-6-astra','openai/astra:preview','codex:astra:latest','gpt-6-astra-preview','astra@1','GPT-6.1-Astra'])assert.equal(modelDisabledByPolicy(model),true,model);
 for(const model of ['unknown-astra-alias','gpt-6.1-sol','claude-haiku-5-5','gpt-6-luna'])assert.equal(modelDisabledByPolicy(model),false,model);
});

test('portable text refuses common credential shapes',()=>{
 const tail='A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
 for(const text of ['AKIA'+'IOSFODNN7EXAMPLE','AWS_SECRET_ACCESS_KEY=abc','OPENAI_API_KEY=abcd1234','api_key: abc123','X-Api-Key: zzz','api_key: correct-horse-battery-staple','"api_key": "abcdefghijkl"','secret_key: AbCdEfGhIjKl','apikey=sk','redis://:pw@h:6379','Authorization: Basic abc','glpat-'+tail,'AIza'+tail+'abcdefgh','postgres://u:p@h/db','eyJhbGciOi'+'J.eyJzdWIiOi'+'J.sig'])assert.match(text,UNSAFE_SEMANTIC_TEXT,text);
 for(const text of ['Monkey wrench','keyboard layout','Review the access policy','https://example.com/docs','task: run tests','git clone ssh://git@github.com/org/repo.git','--max_key=3','PRIMARY_KEY= id','sort_key=name','Authorization: check roles before editing','Implement the authorization: policy'])assert.doesNotMatch(text,UNSAFE_SEMANTIC_TEXT,text);
});

